#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const APERTURE_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'optimization_aperture_controller.js');
const FLOOR_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'objective_optimization_floor.js');

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

function runNode(script, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'opt-aperture-floor-test-'));
  const aperturePolicy = path.join(tmp, 'aperture_policy.json');
  const apertureStateDir = path.join(tmp, 'aperture_state');
  const floorPolicy = path.join(tmp, 'floor_policy.json');
  const floorStateDir = path.join(tmp, 'floor_state');

  writeJson(aperturePolicy, {
    version: '1.0',
    strict_default: false,
    target_drift_rate: 0.03,
    penalties: {
      risk: { low: 0.05, medium: 0.2, high: 0.45 },
      impact: { low: 0.01, medium: 0.1, high: 0.2 },
      budget_pressure: { low: 0.01, medium: 0.1, high: 0.2, critical: 0.35 },
      safety_critical: 0.2,
      drift_multiplier: 4
    },
    rewards: {
      verification_pass_rate_multiplier: 0.4
    },
    level_thresholds: {
      tight_max: 0.35,
      balanced_max: 0.7
    }
  });

  writeJson(floorPolicy, {
    version: '1.0',
    criticality_floor_bands: {
      safety: 2,
      financial: 5,
      reliability: 5,
      standard: 10
    },
    aperture_multipliers: {
      tight: 1.2,
      balanced: 1,
      wide: 0.85
    },
    plateau_min_streak: 3,
    objective_criticality_map: {
      objective_a: 'safety'
    }
  });

  const apertureEnv = {
    OPTIMIZATION_APERTURE_POLICY_PATH: aperturePolicy,
    OPTIMIZATION_APERTURE_STATE_DIR: apertureStateDir
  };

  const floorEnv = {
    OBJECTIVE_OPT_FLOOR_POLICY_PATH: floorPolicy,
    OBJECTIVE_OPT_FLOOR_STATE_DIR: floorStateDir,
    OBJECTIVE_OPT_APERTURE_LATEST_PATH: path.join(apertureStateDir, 'latest.json')
  };

  try {
    let r = runNode(APERTURE_SCRIPT, [
      'run',
      '--lane=autonomy',
      '--risk=high',
      '--impact=high',
      '--budget-pressure=critical',
      '--safety-critical=1',
      '--verification-pass-rate=0.6',
      '--drift-rate=0.05'
    ], apertureEnv);
    assert.strictEqual(r.status, 0, `aperture run should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.decision && r.payload.decision.level === 'tight', 'high-risk context should produce tight aperture');

    r = runNode(FLOOR_SCRIPT, [
      'run',
      '--objective=objective_a',
      '--delta=1.5',
      '--plateau-streak=4'
    ], floorEnv);
    assert.strictEqual(r.status, 0, `floor run should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.decision, 'floor decision missing');
    assert.strictEqual(r.payload.decision.criticality, 'safety', 'objective criticality map should apply');
    assert.strictEqual(r.payload.decision.aperture_level, 'tight', 'floor should consume latest aperture level');
    assert.strictEqual(r.payload.decision.good_enough, true, 'low delta + plateau should be good_enough');

    r = runNode(FLOOR_SCRIPT, [
      'run',
      '--objective=objective_a',
      '--delta=1.5',
      '--plateau-streak=4',
      '--override=1'
    ], floorEnv);
    assert.strictEqual(r.status, 0, 'floor override run should pass');
    assert.strictEqual(r.payload.decision.good_enough, false, 'override should disable good_enough decision');

    console.log('optimization_aperture_and_floor.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`optimization_aperture_and_floor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
