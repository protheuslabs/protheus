#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'habits', 'habit_cell_pool_executor.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeScript(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'habit-cell-pool-executor-'));
  const policyPath = path.join(tmp, 'config', 'habit_cell_pool_executor_policy.json');
  const mockRunnerPath = path.join(tmp, 'mock_run_habit.js');

  writeScript(mockRunnerPath, [
    "#!/usr/bin/env node",
    "'use strict';",
    "const idx = process.argv.indexOf('--id');",
    "const id = idx >= 0 ? String(process.argv[idx + 1] || '') : '';",
    "if (id === 'habit_fail') process.exit(2);",
    "process.stdout.write(JSON.stringify({ ok: true, id }) + '\\n');"
  ].join('\n'));

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    bounds: { min_workers: 1, max_workers: 4 },
    hysteresis: { scale_up_queue_threshold: 2, scale_down_queue_threshold: 1, cooldown_sec: 300 },
    safety: {
      allowed_risks: ['low', 'medium'],
      deny_habit_ids: ['habit_denied'],
      require_explicit_allow: false
    },
    execution: {
      runner_path: mockRunnerPath,
      apply_default: false,
      payload_json_default: '{}'
    },
    outputs: {
      state_path: path.join(tmp, 'state', 'habits', 'state.json'),
      latest_path: path.join(tmp, 'state', 'habits', 'latest.json'),
      history_path: path.join(tmp, 'state', 'habits', 'history.jsonl')
    }
  });

  const env = {
    HABIT_CELL_POOL_EXECUTOR_ROOT: tmp,
    HABIT_CELL_POOL_EXECUTOR_POLICY_PATH: policyPath
  };

  const queue = JSON.stringify([
    { id: 'habit_a', risk: 'low' },
    { id: 'habit_b', risk: 'low' },
    { id: 'habit_c', risk: 'medium' },
    { id: 'habit_denied', risk: 'low' },
    { id: 'habit_high', risk: 'high' }
  ]);

  let r = run(['plan', `--queue-json=${queue}`, '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'plan should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.metrics && out.metrics.target_workers >= 2, 'plan should scale above min workers');
  assert.ok(Array.isArray(out.blocked) && out.blocked.length === 2, 'plan should block denied/high-risk habits');

  const queueSmall = JSON.stringify([{ id: 'habit_single', risk: 'low' }]);
  r = run(['plan', `--queue-json=${queueSmall}`, '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'second plan should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.reason === 'cooldown_hold', 'cooldown should hold worker count after scale-up');

  r = run(['execute', `--queue-json=${queueSmall}`, '--apply=0', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'dry-run execute should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.dry_run === true && Array.isArray(out.commands), 'dry-run execute should emit commands');

  r = run(['execute', '--queue-json=[{"id":"habit_ok","risk":"low"}]', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'apply execute should pass');
  out = parseJson(r.stdout);
  assert.ok(out && out.ok === true && out.failures === 0, 'apply execute should report success');

  console.log('habit_cell_pool_executor.test.js: OK');
}

try { main(); } catch (err) { console.error(`habit_cell_pool_executor.test.js: FAIL: ${err.message}`); process.exit(1); }
