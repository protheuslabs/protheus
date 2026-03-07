#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'soc2_type2_track.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
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
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function isoDaysAgo(days) {
  return new Date(Date.now() - (Number(days) * 24 * 60 * 60 * 1000)).toISOString();
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soc2-type2-'));
  const historyPath = path.join(tmp, 'state', 'ops', 'compliance', 'history.jsonl');
  const policyPath = path.join(tmp, 'config', 'soc2_type2_policy.json');
  const statePath = path.join(tmp, 'state', 'ops', 'soc2_type2_track', 'latest.json');
  const windowHistoryPath = path.join(tmp, 'state', 'ops', 'soc2_type2_track', 'window_history.jsonl');
  const exceptionsPath = path.join(tmp, 'state', 'ops', 'soc2_type2_track', 'exceptions.json');
  const bundleDir = path.join(tmp, 'state', 'ops', 'soc2_type2_track', 'bundles');
  const receiptsPath = path.join(tmp, 'state', 'ops', 'soc2_type2_track', 'receipts.jsonl');

  const rows = [];
  for (let d = 0; d <= 84; d += 7) {
    const ts = isoDaysAgo(d);
    rows.push({ ts, type: 'soc2_readiness', ok: true, controls_failed: 0, path: `state/ops/compliance/${ts.slice(0, 10)}/soc2_readiness.json` });
    rows.push({ ts, type: 'framework_readiness', ok: true, controls_failed: 0, path: `state/ops/compliance/${ts.slice(0, 10)}/framework_readiness.json` });
    rows.push({ ts, type: 'compliance_control_inventory', ok: true, controls_failed: 0, path: `state/ops/compliance/${ts.slice(0, 10)}/control_inventory.json` });
  }
  writeJsonl(historyPath, rows);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    default_window_days: 90,
    minimum_window_days: 90,
    minimum_soc2_runs: 10,
    minimum_unique_evidence_days: 10,
    max_open_exception_days: 30,
    required_event_types: ['soc2_readiness', 'framework_readiness', 'compliance_control_inventory'],
    history_path: historyPath,
    state_path: statePath,
    window_history_path: windowHistoryPath,
    exceptions_path: exceptionsPath,
    bundle_dir: bundleDir,
    receipts_path: receiptsPath,
    attestation_format_version: '1.0'
  });

  const env = { SOC2_TYPE2_POLICY_PATH: policyPath };

  let r = run(['run', '--days=90', '--strict=1'], env);
  assert.strictEqual(r.status, 0, `run should pass strict: ${r.stderr || r.stdout}`);
  let payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'run payload should pass');
  assert.ok(payload.window && payload.window.days === 90, 'window days should be 90');

  r = run(['exception-open', '--id=exc_cc6', '--control=cc6', '--reason=missing_evidence', '--owner=secops'], env);
  assert.strictEqual(r.status, 0, `exception-open should pass: ${r.stderr || r.stdout}`);

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr || r.stdout}`);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'status payload should be ok');
  assert.strictEqual(Number(payload.open_exception_count || 0), 1, 'should have one open exception');

  r = run(['exception-close', '--id=exc_cc6', '--resolution=evidence_attached', '--closed-by=secops'], env);
  assert.strictEqual(r.status, 0, `exception-close should pass: ${r.stderr || r.stdout}`);

  r = run(['run', '--days=90', '--strict=1'], env);
  assert.strictEqual(r.status, 0, `run should pass strict after close: ${r.stderr || r.stdout}`);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'second run should pass');

  r = run(['bundle', '--label=auditor', '--strict=1'], env);
  assert.strictEqual(r.status, 0, `bundle should pass strict: ${r.stderr || r.stdout}`);
  payload = parseJson(r.stdout);
  assert.ok(payload && payload.ok === true, 'bundle payload should be ok');
  const bundlePath = path.resolve(ROOT, String(payload.bundle_path || ''));
  assert.ok(fs.existsSync(bundlePath), 'bundle file should exist');

  const staleBook = {
    schema_id: 'soc2_type2_exceptions',
    schema_version: '1.0',
    updated_at: new Date().toISOString(),
    items: {
      stale_exc: {
        id: 'stale_exc',
        control: 'cc7',
        reason: 'stale gap',
        owner: 'secops',
        opened_at: isoDaysAgo(120),
        status: 'open'
      }
    }
  };
  writeJson(exceptionsPath, staleBook);

  r = run(['run', '--days=90', '--strict=1'], env);
  assert.notStrictEqual(r.status, 0, 'strict run should fail with stale open exception');

  console.log('soc2_type2_track.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`soc2_type2_track.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
