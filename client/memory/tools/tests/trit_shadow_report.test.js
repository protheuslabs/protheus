#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'trit_shadow_report.js');

function mkdirp(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(fp, obj) {
  mkdirp(path.dirname(fp));
  fs.writeFileSync(fp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeJsonl(fp, rows) {
  mkdirp(path.dirname(fp));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(fp, body ? `${body}\n` : '', 'utf8');
}

function run(args, env) {
  const r = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return {
    status: r.status == null ? 1 : r.status,
    payload,
    stderr: String(r.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trit-shadow-report-'));
  const strategyLogPath = path.join(tmp, 'strategy_mode_changes.jsonl');
  const driftStatePath = path.join(tmp, 'drift_target_governor_state.json');
  const reportDir = path.join(tmp, 'reports');

  writeJsonl(strategyLogPath, [
    {
      ts: '2026-02-20T10:00:00.000Z',
      type: 'strategy_mode_auto_change',
      to_mode: 'canary_execute',
      trit_shadow: {
        legacy_to_mode: 'canary_execute',
        shadow_to_mode: 'canary_execute',
        divergence: false,
        reason: 'shadow_promote_canary',
        belief: { trit: 1, confidence: 0.8 }
      }
    },
    {
      ts: '2026-02-21T10:00:00.000Z',
      type: 'strategy_mode_auto_change',
      to_mode: 'execute',
      trit_shadow: {
        legacy_to_mode: 'execute',
        shadow_to_mode: 'canary_execute',
        divergence: true,
        reason: 'shadow_demote_canary',
        belief: { trit: -1, confidence: 0.7 }
      }
    },
    {
      ts: '2026-02-10T10:00:00.000Z',
      type: 'strategy_mode_auto_change',
      to_mode: 'score_only',
      trit_shadow: {
        legacy_to_mode: 'score_only',
        shadow_to_mode: 'score_only',
        divergence: false,
        reason: 'old_event',
        belief: { trit: 0, confidence: 0.6 }
      }
    }
  ]);

  writeJson(driftStatePath, {
    schema_id: 'drift_target_governor_state',
    history: [
      {
        ts: '2026-02-20T11:00:00.000Z',
        date: '2026-02-20',
        action: 'hold',
        trit_shadow: {
          action: 'hold',
          divergence: false,
          reason: 'shadow_hold',
          belief: { trit: 0, confidence: 0.5 }
        }
      },
      {
        ts: '2026-02-21T11:00:00.000Z',
        date: '2026-02-21',
        action: 'tighten',
        trit_shadow: {
          action: 'loosen',
          divergence: true,
          reason: 'shadow_loosen',
          belief: { trit: -1, confidence: 0.6 }
        }
      },
      {
        ts: '2026-02-12T11:00:00.000Z',
        date: '2026-02-12',
        action: 'hold',
        trit_shadow: {
          action: 'hold',
          divergence: false,
          reason: 'old_event',
          belief: { trit: 1, confidence: 0.9 }
        }
      }
    ]
  });

  const env = {
    AUTONOMY_TRIT_SHADOW_STRATEGY_LOG_PATH: strategyLogPath,
    AUTONOMY_TRIT_SHADOW_DRIFT_STATE_PATH: driftStatePath,
    AUTONOMY_TRIT_SHADOW_REPORT_DIR: reportDir,
    AUTONOMY_TRIT_SHADOW_MIN_SAMPLES: '1',
    AUTONOMY_TRIT_SHADOW_WARN_DIVERGENCE_RATE: '0.2',
    AUTONOMY_TRIT_SHADOW_CRITICAL_DIVERGENCE_RATE: '0.35'
  };

  const runRes = run(['run', '2026-02-21', '--days=2', '--max-divergence-rate=0.6'], env);
  assert.strictEqual(runRes.status, 0, `run should pass: ${runRes.stderr}`);
  assert.ok(runRes.payload && runRes.payload.ok === true, 'run payload should be ok');
  assert.strictEqual(runRes.payload.summary.total_decisions, 4, 'expected 4 decisions in window');
  assert.strictEqual(runRes.payload.summary.divergence_count, 2, 'expected 2 divergences');
  assert.strictEqual(runRes.payload.summary.divergence_rate, 0.5, 'expected divergence rate 0.5');
  assert.strictEqual(runRes.payload.summary.status, 'critical', 'expected critical status for rate 0.5');
  assert.strictEqual(runRes.payload.summary.gate.enabled, true, 'gate should be enabled');
  assert.strictEqual(runRes.payload.summary.gate.pass, true, 'gate should pass at max 0.6');
  assert.ok(runRes.payload.success_criteria && typeof runRes.payload.success_criteria === 'object', 'success criteria should be included');
  assert.ok(fs.existsSync(path.join(reportDir, '2026-02-21.json')), 'report file should be written');
  assert.ok(fs.existsSync(path.join(reportDir, 'history.jsonl')), 'history file should be written');

  const statusRes = run(['status', '2026-02-21', '--days=2', '--max-divergence-rate=0.4'], env);
  assert.strictEqual(statusRes.status, 0, `status should pass: ${statusRes.stderr}`);
  assert.ok(statusRes.payload && statusRes.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(statusRes.payload.summary.gate.enabled, true, 'status gate should be enabled');
  assert.strictEqual(statusRes.payload.summary.gate.pass, false, 'gate should fail at max 0.4');
  assert.strictEqual(statusRes.payload.summary.gate.reason, 'divergence_rate_exceeds_limit', 'gate should explain failure');
  assert.ok(!statusRes.payload.report_path, 'status should not write report path');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('trit_shadow_report.test.js: OK');
} catch (err) {
  console.error(`trit_shadow_report.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
