#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeText(filePath, text) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, text, 'utf8');
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return null; }
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'memory', 'idle_dream_cycle.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'idle-dream-budget-'));
  const dreamsDir = path.join(tmpRoot, 'state', 'memory', 'dreams');
  const routingPath = path.join(tmpRoot, 'state', 'routing', 'routing_decisions.jsonl');
  const brokerStub = path.join(tmpRoot, 'spawn_broker_stub.js');

  mkDir(dreamsDir);
  mkDir(path.dirname(routingPath));

  writeJson(path.join(dreamsDir, '2026-02-21.json'), {
    ts: '2026-02-21T12:00:00.000Z',
    date: '2026-02-21',
    themes: [
      {
        token: 'memory-graph',
        score: 16,
        rows: [{ memory_file: 'memory/2026-02-20.md', node_id: 'uid-connections' }]
      }
    ]
  });

  fs.writeFileSync(routingPath, '', 'utf8');

  writeText(
    brokerStub,
    `#!/usr/bin/env node
const cmd = process.argv[2] || '';
const moduleArg = (process.argv.find((a) => a.startsWith('--module=')) || '--module=dreaming_idle').slice('--module='.length);
if (cmd === 'request') {
  const granted = Number(process.env.TEST_SPAWN_GRANT || 0);
  console.log(JSON.stringify({
    ok: true,
    module: moduleArg,
    granted_cells: granted,
    limits: { max_cells: 1, module_current_cells: 0 },
    token_budget: { enabled: false }
  }));
  process.exit(0);
}
if (cmd === 'release') {
  console.log(JSON.stringify({ ok: true, module: moduleArg, released_cells: 1 }));
  process.exit(0);
}
if (cmd === 'status') {
  console.log(JSON.stringify({ ok: true, module: moduleArg, limits: { max_cells: 1 } }));
  process.exit(0);
}
process.exit(2);
`
  );

  const baseEnv = {
    ...process.env,
    IDLE_DREAM_DREAMS_DIR: dreamsDir,
    IDLE_DREAM_ROUTING_DECISIONS_PATH: routingPath,
    IDLE_DREAM_SPAWN_BROKER_SCRIPT: brokerStub,
    IDLE_DREAM_SPAWN_BUDGET_ENABLED: '1',
    IDLE_DREAM_FAKE_MODELS: 'smallthinker',
    IDLE_DREAM_FAKE_IDLE_JSON: JSON.stringify({
      dream_links: [{ token: 'memory-graph-bridge', hint: 'bridge', confidence: 3, refs: [] }]
    }),
    IDLE_DREAM_REM_MIN_IDLE_RUNS: '99'
  };

  let r = spawnSync('node', [script, 'run', '2026-02-21', '--force=1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...baseEnv, TEST_SPAWN_GRANT: '0' }
  });
  assert.strictEqual(r.status, 0, `run should pass on deny path: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.ok(out.idle && out.idle.skipped === true, 'idle should be skipped when budget denied');
  assert.strictEqual(out.idle.reason, 'spawn_budget_denied', 'idle skip reason should be spawn budget denial');

  r = spawnSync('node', [script, 'run', '2026-02-21', '--force=1'], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...baseEnv, TEST_SPAWN_GRANT: '1' }
  });
  assert.strictEqual(r.status, 0, `run should pass on grant path: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.ok(out.idle && out.idle.skipped === false, 'idle should run when budget granted');
  assert.ok(out.idle.spawn_budget && out.idle.spawn_budget.module, 'idle should report spawn budget lease');

  console.log('idle_dream_budget_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`idle_dream_budget_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

