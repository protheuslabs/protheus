#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'observability', 'siem_bridge.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'siem-bridge-'));
  const policyPath = path.join(tmp, 'siem_bridge_policy.json');
  const inputA = path.join(tmp, 'state', 'security', 'integrity_status.json');
  const inputB = path.join(tmp, 'state', 'ops', 'execution_reliability_slo.json');
  const latestExportPath = path.join(tmp, 'state', 'observability', 'siem_bridge', 'latest_export.json');
  const exportHistoryPath = path.join(tmp, 'state', 'observability', 'siem_bridge', 'export_history.jsonl');
  const latestCorrelationPath = path.join(tmp, 'state', 'observability', 'siem_bridge', 'latest_correlation.json');
  const alertRoundtripPath = path.join(tmp, 'state', 'observability', 'siem_bridge', 'alert_roundtrip.json');
  const receiptsPath = path.join(tmp, 'state', 'observability', 'siem_bridge', 'receipts.jsonl');

  writeJson(inputA, { type: 'integrity_check', ok: false, reason: 'tamper mismatch deny policy gate' });
  writeJson(inputB, { type: 'execution_reliability', pass: true, auth_error: 'forbidden token' });
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: false,
    default_format: 'otlp',
    input_paths: [inputA, inputB],
    correlation_rules: {
      auth_anomaly: { enabled: true, pattern_tokens: ['auth', 'token', 'forbidden'], min_hits: 1 },
      integrity_drift: { enabled: true, pattern_tokens: ['integrity', 'tamper', 'mismatch'], min_hits: 1 },
      guard_denies: { enabled: true, pattern_tokens: ['deny', 'policy', 'gate'], min_hits: 1 }
    },
    latest_export_path: latestExportPath,
    export_history_path: exportHistoryPath,
    latest_correlation_path: latestCorrelationPath,
    alert_roundtrip_path: alertRoundtripPath,
    receipts_path: receiptsPath
  });
  const env = { SIEM_BRIDGE_POLICY_PATH: policyPath };

  const exportRun = run(['export', '--format=cef', '--strict=1'], env);
  assert.strictEqual(exportRun.status, 0, exportRun.stderr || 'export should pass');
  const exportPayload = parseJson(exportRun.stdout);
  assert.ok(exportPayload && exportPayload.ok === true, 'export payload should be ok');
  assert.strictEqual(exportPayload.format, 'cef', 'format should be cef');
  assert.ok(Number(exportPayload.event_count || 0) >= 2, 'should export input events');

  const correlate = run(['correlate', '--strict=1'], env);
  assert.strictEqual(correlate.status, 0, correlate.stderr || 'correlate should pass strict');
  const correlationPayload = parseJson(correlate.stdout);
  assert.ok(correlationPayload && correlationPayload.ok === true, 'correlation payload should be ok');
  assert.ok(Number(correlationPayload.matched_count || 0) >= 1, 'at least one rule should match');
  assert.ok(correlationPayload.alert_roundtrip && correlationPayload.alert_roundtrip.ack_rate === 1, 'alert roundtrip ack rate should be 1');

  const status = run(['status'], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  const statusPayload = parseJson(status.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.ok(statusPayload.latest_export, 'status should include latest export');
  assert.ok(statusPayload.latest_correlation, 'status should include latest correlation');

  console.log('siem_bridge.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`siem_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
