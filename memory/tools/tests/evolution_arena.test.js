#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'fractal', 'evolution_arena.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function parsePayload(stdout) {
  const out = String(stdout || '').trim();
  try { return JSON.parse(out); } catch {}
  const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    payload: parsePayload(r.stdout)
  };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evolution-arena-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const stateDir = path.join(tmp, 'state', 'autonomy', 'evolution_arena');
  const mockSpawn = path.join(tmp, 'spawn_mock.js');

  writeJson(policyPath, {
    version: '1.0',
    strict_default: true,
    default_objective: 'objective_a',
    default_variants: ['incumbent', 'candidate_a', 'candidate_b'],
    requested_cells_per_variant: 1,
    synthetic_tokens_per_variant: 500,
    max_token_budget: 3000,
    min_promotion_gain: 0.05,
    loser_ttl_days: 3
  });

  fs.writeFileSync(mockSpawn, [
    "#!/usr/bin/env node",
    "'use strict';",
    "process.stdout.write(JSON.stringify({ ok: true, type: 'spawn_request', granted_cells: 1 }));"
  ].join('\n') + '\n', 'utf8');

  const env = {
    EVOLUTION_ARENA_POLICY_PATH: policyPath,
    EVOLUTION_ARENA_STATE_DIR: stateDir,
    EVOLUTION_ARENA_SPAWN_BROKER_SCRIPT: mockSpawn
  };

  try {
    let r = run([
      'run',
      '--objective=objective_a',
      '--variants=incumbent,candidate_a,candidate_b',
      '--scores=incumbent:0.62,candidate_a:0.63,candidate_b:0.72',
      '--strict=1'
    ], env);
    assert.strictEqual(r.status, 0, `arena run should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'arena should pass budget gate');
    assert.strictEqual(r.payload.winner.variant, 'candidate_b', 'candidate_b should win');
    assert.strictEqual(r.payload.promote, true, 'winner should promote with gain threshold');
    assert.ok(Array.isArray(r.payload.losers) && r.payload.losers.length === 2, 'losers should be emitted with cleanup receipts');

    r = run([
      'run',
      '--objective=objective_a',
      '--variants=incumbent,candidate_a',
      '--scores=incumbent:0.7,candidate_a:0.72',
      '--strict=1'
    ], env);
    assert.strictEqual(r.status, 0, 'second run should pass');
    assert.strictEqual(r.payload.promote, false, 'gain below threshold should block promotion');

    r = run(['status'], env);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    assert.ok(r.payload && Number(r.payload.recent_runs || 0) >= 2, 'status should include run history');

    console.log('evolution_arena.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`evolution_arena.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
