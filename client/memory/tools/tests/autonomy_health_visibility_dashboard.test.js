#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'autonomy_health_visibility_dashboard.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
function writeJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}
function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autonomy-health-dashboard-'));
  const policyPath = path.join(tmp, 'config', 'autonomy_health_visibility_dashboard_policy.json');
  const now = new Date();
  const staleTs = new Date(now.getTime() - (30 * 60 * 60 * 1000)).toISOString();
  const freshTs = new Date(now.getTime() - (1 * 60 * 60 * 1000)).toISOString();

  writeJson(path.join(tmp, 'state', 'sensory', 'eyes', 'registry.json'), {
    eyes: [
      { id: 'eye_a', status: 'active', last_seen_at: staleTs },
      { id: 'eye_b', status: 'active', last_seen_at: freshTs }
    ]
  });
  writeJsonl(path.join(tmp, 'state', 'sensory', 'queue_log.jsonl'), [
    { ts: staleTs, type: 'proposal_generated' },
    { ts: freshTs, type: 'proposal_filtered', filter_reason: 'action_spec_missing' }
  ]);
  writeJson(path.join(tmp, 'state', 'autonomy', 'runs', 'today.jsonl'), []);
  writeJson(path.join(tmp, 'state', 'autonomy', 'receipt_summary', 'latest.json'), { pass_rate: 0.5 });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    thresholds: {
      dark_eye_hours: 24,
      proposal_starvation_hours: 12,
      loop_stall_hours: 6,
      drift_ratio_warn: 0.2
    },
    inputs: {
      eyes_registry_path: path.join(tmp, 'state', 'sensory', 'eyes', 'registry.json'),
      queue_log_path: path.join(tmp, 'state', 'sensory', 'queue_log.jsonl'),
      autonomy_runs_path: path.join(tmp, 'state', 'autonomy', 'runs'),
      receipt_summary_path: path.join(tmp, 'state', 'autonomy', 'receipt_summary', 'latest.json')
    },
    outputs: {
      daily_path: path.join(tmp, 'state', 'ops', 'dashboard', 'daily.json'),
      weekly_path: path.join(tmp, 'state', 'ops', 'dashboard', 'weekly.json'),
      alerts_path: path.join(tmp, 'state', 'ops', 'dashboard', 'alerts.jsonl'),
      latest_path: path.join(tmp, 'state', 'ops', 'dashboard', 'latest.json'),
      history_path: path.join(tmp, 'state', 'ops', 'dashboard', 'history.jsonl')
    }
  });

  const env = {
    AUTONOMY_HEALTH_DASHBOARD_ROOT: tmp,
    AUTONOMY_HEALTH_DASHBOARD_POLICY_PATH: policyPath
  };

  const r = run(['daily', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'daily report should pass');
  const out = parseJson(r.stdout);
  assert.ok(out && out.ok === true, 'payload should pass');
  assert.ok(Array.isArray(out.alerts) && out.alerts.length >= 1, 'expected at least one alert');
  assert.strictEqual(Number(out.metrics.dark_eyes || 0), 1, 'expected one dark eye');

  console.log('autonomy_health_visibility_dashboard.test.js: OK');
}

try { main(); } catch (err) { console.error(`autonomy_health_visibility_dashboard.test.js: FAIL: ${err.message}`); process.exit(1); }
