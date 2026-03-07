#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'trit_shadow_replay_calibration.js');

function writeJson(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function writeJsonl(fp, rows) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const body = (rows || []).map((row) => JSON.stringify(row)).join('\n');
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
  return { status: r.status == null ? 1 : r.status, payload, stderr: String(r.stderr || '') };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'trit-shadow-replay-'));
  const strategyPath = path.join(tmp, 'strategy_mode_changes.jsonl');
  const driftPath = path.join(tmp, 'drift_target_governor_state.json');
  const runsDir = path.join(tmp, 'runs');
  const reportDir = path.join(tmp, 'reports');

  writeJsonl(strategyPath, [
    {
      ts: '2026-02-21T01:00:00.000Z',
      strategy_id: 'default_general',
      trit_shadow: {
        belief: { trit: 1, confidence: 0.8 },
        top_sources: [{ source: 'spc_gate', weighted: 1.4 }]
      }
    },
    {
      ts: '2026-02-21T05:00:00.000Z',
      strategy_id: 'default_general',
      trit_shadow: {
        belief: { trit: -1, confidence: 0.7 },
        top_sources: [{ source: 'quality_lock', weighted: 1.2 }]
      }
    }
  ]);
  writeJsonl(path.join(runsDir, '2026-02-21.jsonl'), [
    {
      ts: '2026-02-21T02:00:00.000Z',
      type: 'autonomy_run',
      strategy_id: 'default_general',
      result: 'executed'
    },
    {
      ts: '2026-02-21T06:00:00.000Z',
      type: 'autonomy_run',
      strategy_id: 'default_general',
      result: 'stop_repeat_gate'
    }
  ]);
  writeJson(driftPath, {
    history: [
      {
        ts: '2026-02-21T00:30:00.000Z',
        date: '2026-02-21',
        drift_rate: 0.05,
        trit_shadow: {
          belief: { trit: 1, confidence: 0.6 },
          top_sources: [{ source: 'drift_vs_target', weighted: 2.0 }]
        }
      },
      {
        ts: '2026-02-21T08:30:00.000Z',
        date: '2026-02-21',
        drift_rate: 0.03,
        trit_shadow: {
          belief: { trit: 1, confidence: 0.55 },
          top_sources: [{ source: 'drift_vs_target', weighted: 2.0 }]
        }
      }
    ]
  });

  const env = {
    AUTONOMY_TRIT_SHADOW_STRATEGY_LOG_PATH: strategyPath,
    AUTONOMY_TRIT_SHADOW_DRIFT_STATE_PATH: driftPath,
    AUTONOMY_TRIT_SHADOW_RUNS_DIR: runsDir,
    AUTONOMY_TRIT_SHADOW_CALIBRATION_DIR: reportDir
  };

  const res = run(['run', '2026-02-21', '--days=1', '--lookahead-hours=4'], env);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'payload should be ok');
  assert.ok(Number(res.payload.summary.total_events || 0) >= 2, 'should evaluate multiple replay events');
  assert.ok(Array.isArray(res.payload.source_reliability), 'source reliability should be emitted');
  assert.ok(fs.existsSync(path.join(reportDir, '2026-02-21.json')), 'report should be written');
  assert.ok(fs.existsSync(path.join(reportDir, 'history.jsonl')), 'history should be written');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('trit_shadow_replay_calibration.test.js: OK');
} catch (err) {
  console.error(`trit_shadow_replay_calibration.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
