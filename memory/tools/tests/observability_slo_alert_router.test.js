#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'observability', 'slo_alert_router.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeJsonl(filePath, rows) {
  mkdirp(path.dirname(filePath));
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${body}${body ? '\n' : ''}`, 'utf8');
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'slo-alert-router-'));
  const state = path.join(tmp, 'state');
  const config = path.join(tmp, 'config');
  const policyPath = path.join(config, 'observability_policy.json');
  const dateStr = '2026-02-26';
  const alertsPath = path.join(state, 'autonomy', 'health_alerts', `${dateStr}.jsonl`);

  writeJsonl(alertsPath, [
    {
      ts: `${dateStr}T01:00:00.000Z`,
      type: 'autonomy_health_alert',
      date: dateStr,
      window: 'daily',
      check: 'loop_stall',
      level: 'warn',
      summary: 'loop stall warning',
      alert_key: 'A'
    },
    {
      ts: `${dateStr}T01:01:00.000Z`,
      type: 'autonomy_health_alert',
      date: dateStr,
      window: 'daily',
      check: 'verification_pass_rate',
      level: 'critical',
      summary: 'verification pass critical',
      alert_key: 'B'
    },
    {
      ts: `${dateStr}T01:02:00.000Z`,
      type: 'autonomy_health_alert',
      date: dateStr,
      window: 'daily',
      check: 'dark_eyes',
      level: 'ok',
      summary: 'dark eye recovered',
      alert_key: 'C'
    }
  ]);

  writeJson(policyPath, {
    version: '1.0-test',
    alert_routing: {
      enabled: true,
      min_level: 'warn',
      max_per_run: 200,
      source_alerts_dir: path.join(state, 'autonomy', 'health_alerts'),
      state_path: path.join(state, 'observability', 'alerts', 'router_state.json'),
      routed_jsonl_path: path.join(state, 'observability', 'alerts', 'routed.jsonl'),
      max_state_keys: 12000,
      sinks: {
        file: { enabled: true },
        stdout: { enabled: false },
        webhook: { enabled: false, url: '', url_env: 'OBSERVABILITY_ALERT_WEBHOOK_URL', timeout_ms: 1500 }
      }
    }
  });

  const first = run(['route', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(first.status, 0, `first route should pass: ${first.stderr}`);
  const firstPayload = parseJson(first.stdout);
  assert.strictEqual(firstPayload.ok, true, 'first payload should be ok');
  assert.strictEqual(Number(firstPayload.source_total), 3, 'source count expected');
  assert.strictEqual(Number(firstPayload.filtered_out), 1, 'one ok-level alert should be filtered');
  assert.strictEqual(Number(firstPayload.routed), 2, 'warn+critical should route');

  const second = run(['route', dateStr, `--policy=${policyPath}`]);
  assert.strictEqual(second.status, 0, `second route should pass: ${second.stderr}`);
  const secondPayload = parseJson(second.stdout);
  assert.strictEqual(Number(secondPayload.routed), 0, 'second pass should dedupe');
  assert.strictEqual(Number(secondPayload.already_routed), 2, 'both warn/critical alerts should already be routed');

  const routedPath = path.join(state, 'observability', 'alerts', 'routed.jsonl');
  const routedLines = fs.readFileSync(routedPath, 'utf8').trim().split('\n').filter(Boolean);
  assert.strictEqual(routedLines.length, 2, 'exactly two routed rows expected');
  const routedRows = routedLines.map((line) => JSON.parse(line));
  assert.ok(routedRows.every((row) => typeof row.runbook_id === 'string' && row.runbook_id.length > 0), 'runbook_id should be mapped');
  assert.ok(routedRows.every((row) => typeof row.owner === 'string' && row.owner.length > 0), 'owner should be mapped');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('observability_slo_alert_router.test.js: OK');
} catch (err) {
  console.error(`observability_slo_alert_router.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
