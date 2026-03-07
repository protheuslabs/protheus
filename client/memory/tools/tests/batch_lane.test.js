#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'batch_lane.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const text = String(r.stdout || '').trim();
  let payload = null;
  if (text) {
    const lines = text.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return { status: r.status, stdout: text, stderr: String(r.stderr || '').trim(), payload };
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function writeText(filePath, body) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-lane-test-'));
  const stateDir = path.join(tmp, 'state');
  const stub = path.join(tmp, 'executor_stub.js');
  writeText(stub, `#!/usr/bin/env node
const argv = process.argv.slice(2);
const idx = argv.indexOf('--task');
const task = idx >= 0 ? String(argv[idx + 1] || '') : '';
if (/fail/i.test(task)) {
  process.stderr.write('simulated_executor_failure');
  process.exit(1);
}
process.stdout.write(JSON.stringify({ ok: true, result: 'executed', executable: true }) + '\\n');
`);

  const baseEnv = {
    AUTONOMY_BATCH_LANE_STATE_DIR: stateDir,
    AUTONOMY_BATCH_LANE_EXECUTOR_SCRIPT: stub,
    AUTONOMY_BATCH_LANE_TOKEN_SAVINGS_PCT: '0.3',
    AUTONOMY_BATCH_LANE_NOW_ISO: '2026-02-23T10:00:00.000Z'
  };

  try {
    let r = run([
      'enqueue',
      '--task=low urgency queued item',
      '--tokens_est=500',
      '--urgency=low',
      '--sla_minutes=60',
      '--ttl_minutes=120'
    ], baseEnv);
    assert.strictEqual(r.status, 0, `enqueue should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true && r.payload.result === 'enqueued', 'enqueue payload should be ok');

    r = run([
      'enqueue',
      '--task=will expire before process',
      '--tokens_est=300',
      '--urgency=low',
      '--sla_minutes=30',
      '--ttl_minutes=15'
    ], baseEnv);
    assert.strictEqual(r.status, 0, `second enqueue should pass: ${r.stderr}`);

    // Advance time past second item TTL so expiry path is exercised.
    const processEnv = {
      ...baseEnv,
      AUTONOMY_BATCH_LANE_NOW_ISO: '2026-02-23T11:00:00.000Z'
    };
    r = run(['process', '--max=10', '--dry-run'], processEnv);
    assert.strictEqual(r.status, 0, `process should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'process payload should be ok');
    assert.strictEqual(String(r.payload.result || ''), 'batch_processed');
    assert.ok(Number(r.payload.done || 0) >= 1, 'expected at least one done item');
    assert.ok(Number(r.payload.expired || 0) >= 1, 'expected at least one expired item');
    assert.ok(Number(r.payload.token_delta && r.payload.token_delta.saved_tokens_est || 0) > 0, 'expected positive token savings');

    r = run(['status'], processEnv);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'status payload should be ok');
    assert.ok(r.payload.queue && Number(r.payload.queue.total || 0) >= 2, 'status queue total should include enqueued items');

    const metrics = readJson(path.join(stateDir, 'metrics.json'), null);
    assert.ok(metrics && metrics.token_delta, 'metrics should be written');
    assert.ok(Number(metrics.token_delta.saved_tokens_est || 0) > 0, 'metrics should track token savings');

    const receiptsDir = path.join(stateDir, 'receipts');
    const receiptFile = path.join(receiptsDir, '2026-02-23.jsonl');
    const receipts = readJsonl(receiptFile);
    assert.ok(receipts.length >= 2, 'expected receipts for processed + expired rows');

    console.log('batch_lane.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`batch_lane.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

