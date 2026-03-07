#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CONTROLLER_PATH = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, rows) {
  ensureDir(path.dirname(filePath));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.appendFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withEnv(envPatch, fn) {
  const saved = {};
  const keys = Object.keys(envPatch || {});
  for (const key of keys) {
    saved[key] = process.env[key];
    process.env[key] = envPatch[key];
  }
  try {
    return fn();
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  }
}

function loadController() {
  delete require.cache[require.resolve(CONTROLLER_PATH)];
  return require(CONTROLLER_PATH);
}

function mkSandbox(prefix) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const canaryPath = path.join(root, 'state', 'routing', 'model_catalog_canary.json');
  const auditPath = path.join(root, 'state', 'routing', 'model_catalog_audit.jsonl');
  ensureDir(runsDir);
  ensureDir(path.dirname(canaryPath));
  ensureDir(path.dirname(auditPath));
  return { root, runsDir, canaryPath, auditPath };
}

function nowIso() {
  return new Date().toISOString();
}

function dayStr() {
  return nowIso().slice(0, 10);
}

let failed = false;
function test(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   MODEL CATALOG CANARY INTEGRATION TESTS');
console.log('═══════════════════════════════════════════════════════════');

test('canary passes after enough healthy samples', () => {
  const box = mkSandbox('model-catalog-canary-pass-');
  const env = {
    AUTONOMY_RUNS_DIR: box.runsDir,
    AUTONOMY_MODEL_CATALOG_CANARY_PATH: box.canaryPath,
    AUTONOMY_MODEL_CATALOG_AUDIT_PATH: box.auditPath,
    AUTONOMY_MODEL_CATALOG_CANARY_ENABLED: '1',
    AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES: '3',
    AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE: '0.6',
    AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE: '0.5'
  };

  withEnv(env, () => {
    const controller = loadController();
    const day = dayStr();
    const runFile = path.join(box.runsDir, `${day}.jsonl`);
    const model = 'ollama/test-pass:cloud';
    const proposalId = 'proposal-pass';

    controller.startModelCatalogCanary(proposalId, {
      added_models: 1,
      models: [model],
      snapshot: '/tmp/fake_snapshot.json'
    });

    appendJsonl(runFile, [
      {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'executed',
        route_summary: { selected_model: model },
        verification: { passed: true },
        exec_ok: true,
        outcome: 'shipped'
      },
      {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'executed',
        route_summary: { selected_model: model },
        verification: { passed: true },
        exec_ok: true,
        outcome: 'shipped'
      },
      {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'executed',
        route_summary: { selected_model: model },
        verification: { passed: true },
        exec_ok: true,
        outcome: 'no_change'
      }
    ]);

    const evalResult = controller.evaluateModelCatalogCanary(day);
    assert.strictEqual(evalResult.status, 'passed');

    const state = readJson(box.canaryPath);
    assert.strictEqual(state.status, 'passed');
    assert.strictEqual(Number(state.stats.samples || 0), 3);
    assert.strictEqual(Number(state.stats.failed || 0), 0);
    assert.strictEqual(Number(state.stats.route_blocked || 0), 0);

    const audit = readJsonl(box.auditPath);
    assert.ok(audit.some((e) => e && e.type === 'canary_started' && e.proposal_id === proposalId));
    assert.ok(audit.some((e) => e && e.type === 'canary_passed' && e.proposal_id === proposalId));
  });
});

test('canary triggers rollback when failure rate exceeds threshold', () => {
  const box = mkSandbox('model-catalog-canary-rollback-');
  const rollbackMarker = path.join(box.root, 'rollback.marker');
  const rollbackScript = path.join(box.root, 'fake_rollback.js');
  fs.writeFileSync(
    rollbackScript,
    [
      '#!/usr/bin/env node',
      "'use strict';",
      "const fs = require('fs');",
      "const marker = process.env.TEST_ROLLBACK_MARKER;",
      "if (marker) fs.writeFileSync(marker, 'ok', 'utf8');",
      "process.stdout.write(JSON.stringify({ ok: true, restored_from: 'fake_snapshot' }) + '\\n');"
    ].join('\n'),
    'utf8'
  );

  const env = {
    AUTONOMY_RUNS_DIR: box.runsDir,
    AUTONOMY_MODEL_CATALOG_CANARY_PATH: box.canaryPath,
    AUTONOMY_MODEL_CATALOG_AUDIT_PATH: box.auditPath,
    AUTONOMY_MODEL_CATALOG_ROLLBACK_SCRIPT: rollbackScript,
    AUTONOMY_MODEL_CATALOG_CANARY_ENABLED: '1',
    AUTONOMY_MODEL_CATALOG_CANARY_MIN_SAMPLES: '3',
    AUTONOMY_MODEL_CATALOG_CANARY_MAX_FAIL_RATE: '0.5',
    AUTONOMY_MODEL_CATALOG_CANARY_MAX_ROUTE_BLOCK_RATE: '0.5',
    TEST_ROLLBACK_MARKER: rollbackMarker
  };

  withEnv(env, () => {
    const controller = loadController();
    const day = dayStr();
    const runFile = path.join(box.runsDir, `${day}.jsonl`);
    const model = 'ollama/test-rollback:cloud';
    const proposalId = 'proposal-rollback';

    controller.startModelCatalogCanary(proposalId, {
      added_models: 1,
      models: [model],
      snapshot: '/tmp/fake_snapshot.json'
    });

    appendJsonl(runFile, [
      {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'executed',
        route_summary: { selected_model: model },
        verification: { passed: false },
        exec_ok: true,
        outcome: 'reverted'
      },
      {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'executed',
        route_summary: { selected_model: model },
        verification: { passed: false },
        exec_ok: true,
        outcome: 'no_change'
      },
      {
        ts: nowIso(),
        type: 'autonomy_run',
        result: 'init_gate_blocked_route',
        route_summary: { selected_model: model },
        route_block_reason: 'gate_deny'
      }
    ]);

    const evalResult = controller.evaluateModelCatalogCanary(day);
    assert.strictEqual(evalResult.rollback_triggered, true);
    assert.strictEqual(evalResult.rollback_ok, true);
    assert.strictEqual(evalResult.status, 'rolled_back');

    const state = readJson(box.canaryPath);
    assert.strictEqual(state.status, 'rolled_back');
    assert.ok(state.rollback && state.rollback.ok === true, 'rollback details should be persisted');
    assert.ok(fs.existsSync(rollbackMarker), 'rollback script should run');

    const audit = readJsonl(box.auditPath);
    assert.ok(audit.some((e) => e && e.type === 'canary_rollback_success' && e.proposal_id === proposalId));
  });
});

if (failed) process.exit(1);
console.log('   ✅ ALL MODEL CATALOG CANARY INTEGRATION TESTS PASS');
