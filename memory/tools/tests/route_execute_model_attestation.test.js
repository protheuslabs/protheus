#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeText(filePath, text) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function writeJson(filePath, obj) {
  writeText(filePath, JSON.stringify(obj, null, 2));
}

function parseJsonLines(text) {
  return String(text || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function runRouteExecute(repoRoot, env) {
  const script = path.join(repoRoot, 'systems', 'routing', 'route_execute.js');
  return spawnSync('node', [
    script,
    '--task', 'model attestation check',
    '--tokens_est', '160',
    '--repeats_14d', '0',
    '--errors_30d', '0'
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
}

function findMetrics(rows) {
  return rows.find((row) => row && row.type === 'route_execute_metrics' && row.execution_metrics);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_route_execute_model_attestation');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const stopPath = path.join(repoRoot, 'state', 'security', 'emergency_stop.json');
  const backupPath = `${stopPath}.test-backup-${Date.now()}`;
  const hadExisting = fs.existsSync(stopPath);
  if (hadExisting) {
    mkDir(path.dirname(backupPath));
    fs.copyFileSync(stopPath, backupPath);
  }

  try {
    writeJson(stopPath, {
      engaged: false,
      scopes: [],
      updated_at: new Date().toISOString(),
      actor: 'test',
      reason: 'route_execute_model_attestation'
    });

    const routeTaskStub = path.join(tmpRoot, 'route_task_stub.js');
    const execStub = path.join(tmpRoot, 'exec_stub.js');
    writeText(routeTaskStub, `#!/usr/bin/env node
const execScript = process.env.ROUTE_EXECUTE_TEST_EXEC;
if (!execScript) {
  process.stderr.write('missing ROUTE_EXECUTE_TEST_EXEC');
  process.exit(2);
}
const out = {
  decision: 'RUN_HABIT',
  reason: 'stub route',
  gate_decision: 'ALLOW',
  gate_risk: 'low',
  executor: { cmd: 'node', args: [execScript] },
  route: {
    selected_model: 'ollama/smallthinker',
    budget_enforcement: { blocked: false, action: 'none', reason: null },
    mode: 'normal',
    role: 'chat',
    tier: 1
  }
};
process.stdout.write(JSON.stringify(out) + '\\n');
`);
    writeText(execStub, `#!/usr/bin/env node
const observed = process.env.FORCE_OBSERVED_MODEL || process.env.ROUTED_MODEL || null;
process.stdout.write(JSON.stringify({ route: { selected_model: observed } }) + '\\n');
process.exit(0);
`);

    const baseEnv = {
      ...process.env,
      ROUTER_ENABLED: '0',
      ROUTE_EXECUTE_BUDGET_ENABLED: '0',
      ROUTE_EXECUTE_ROUTE_TASK_SCRIPT: routeTaskStub,
      ROUTE_EXECUTE_TEST_EXEC: execStub
    };

    let r = runRouteExecute(repoRoot, baseEnv);
    assert.strictEqual(r.status, 0, `verified run failed: ${r.stderr}`);
    let rows = parseJsonLines(r.stdout);
    let metrics = findMetrics(rows);
    assert.ok(metrics, 'expected metrics payload for verified run');
    assert.strictEqual(metrics.execution_metrics.route_model_attestation.status, 'verified');
    assert.strictEqual(metrics.execution_metrics.route_model_attestation.expected_model, 'ollama/smallthinker');

    r = runRouteExecute(repoRoot, { ...baseEnv, FORCE_OBSERVED_MODEL: 'ollama/qwen3:4b' });
    assert.strictEqual(r.status, 0, `mismatch run failed: ${r.stderr}`);
    rows = parseJsonLines(r.stdout);
    metrics = findMetrics(rows);
    assert.ok(metrics, 'expected metrics payload for mismatch run');
    assert.strictEqual(metrics.execution_metrics.route_model_attestation.status, 'mismatch');
    assert.ok(
      Array.isArray(metrics.execution_metrics.route_model_attestation.observed_models)
      && metrics.execution_metrics.route_model_attestation.observed_models.includes('ollama/qwen3:4b'),
      'mismatch run should record observed model'
    );

    console.log('route_execute_model_attestation.test.js: OK');
  } finally {
    if (hadExisting) {
      fs.copyFileSync(backupPath, stopPath);
      fs.rmSync(backupPath, { force: true });
    } else {
      fs.rmSync(stopPath, { force: true });
    }
  }
}

try {
  run();
} catch (err) {
  console.error(`route_execute_model_attestation.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
