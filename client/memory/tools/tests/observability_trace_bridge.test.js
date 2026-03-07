#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'observability', 'trace_bridge.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}').trim());
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-bridge-'));
  const state = path.join(tmp, 'state');
  const config = path.join(tmp, 'config');
  const policyPath = path.join(config, 'observability_policy.json');

  writeJson(policyPath, {
    version: '1.0-test',
    tracing: {
      enabled: true,
      spans_path: path.join(state, 'observability', 'tracing', 'spans.jsonl'),
      latest_path: path.join(state, 'observability', 'tracing', 'latest.json'),
      max_attr_count: 24,
      max_attr_key_length: 64,
      max_attr_value_length: 200
    }
  });

  const emit = run([
    'span',
    '--name=spine.autonomy_health.daily',
    '--status=warn',
    '--duration-ms=123',
    '--service=protheus',
    '--component=spine',
    '--attrs-json={"window":"daily","critical_count":"1"}',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(emit.status, 0, `span should pass: ${emit.stderr}`);
  const emitPayload = parseJson(emit.stdout);
  assert.strictEqual(emitPayload.ok, true, 'emit payload should be ok');
  assert.strictEqual(emitPayload.span.status, 'warn', 'status should be warn');
  assert.strictEqual(Number(emitPayload.span.duration_ms), 123, 'duration should be set');

  const spansPath = path.join(state, 'observability', 'tracing', 'spans.jsonl');
  assert.ok(fs.existsSync(spansPath), 'spans file expected');
  const lines = fs.readFileSync(spansPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 1, 'at least one span expected');

  const summary = run(['summary', '--hours=24', `--policy=${policyPath}`]);
  assert.strictEqual(summary.status, 0, `summary should pass: ${summary.stderr}`);
  const summaryPayload = parseJson(summary.stdout);
  assert.strictEqual(summaryPayload.ok, true, 'summary payload should be ok');
  assert.ok(Number(summaryPayload.spans_total || 0) >= 1, 'summary should include spans');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('observability_trace_bridge.test.js: OK');
} catch (err) {
  console.error(`observability_trace_bridge.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
