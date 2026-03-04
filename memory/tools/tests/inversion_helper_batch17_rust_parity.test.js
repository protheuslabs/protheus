#!/usr/bin/env node
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const inversionPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'inversion_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadInversion(rustEnabled) {
  process.env.INVERSION_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[inversionPath];
  delete require.cache[bridgePath];
  return require(inversionPath);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function stripTs(row) {
  if (!row || typeof row !== 'object') return row;
  const out = { ...row };
  delete out.ts;
  return out;
}

function run() {
  const tmpRoot = path.join(REPO_ROOT, 'tmp', 'inversion-batch17-parity');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const libraryPathTs = path.join(tmpRoot, 'ts_library.jsonl');
  const libraryPathRust = path.join(tmpRoot, 'rust_library.jsonl');

  const baseRows = [
    {
      id: 'a1',
      ts: '2026-03-04T00:00:00.000Z',
      objective: 'Reduce drift safely',
      signature: 'drift guard stable',
      signature_tokens: ['drift', 'guard', 'stable'],
      target: 'directive',
      impact: 'high',
      certainty: 0.9,
      filter_stack: ['drift_guard'],
      outcome_trit: -1,
      result: 'fail',
      maturity_band: 'developing'
    },
    {
      id: 'a2',
      ts: '2026-03-04T00:10:00.000Z',
      objective: 'Reduce drift safely',
      signature: 'drift guard stable',
      signature_tokens: ['drift', 'guard', 'stable'],
      target: 'directive',
      impact: 'high',
      certainty: 0.88,
      filter_stack: ['drift_guard', 'identity_guard'],
      outcome_trit: -1,
      result: 'fail',
      maturity_band: 'developing'
    },
    {
      id: 'a3',
      ts: '2026-03-04T00:20:00.000Z',
      objective: 'Reduce drift safely',
      signature: 'drift guard stable',
      signature_tokens: ['drift', 'guard', 'stable'],
      target: 'directive',
      impact: 'high',
      certainty: 0.86,
      filter_stack: ['drift_guard', 'fallback_pathing'],
      outcome_trit: -1,
      result: 'fail',
      maturity_band: 'developing'
    },
    {
      id: 'a4',
      ts: '2026-03-04T00:30:00.000Z',
      objective: 'Reduce drift safely',
      signature: 'drift guard stable',
      signature_tokens: ['drift', 'guard', 'stable'],
      target: 'directive',
      impact: 'high',
      certainty: 0.84,
      filter_stack: ['drift_guard', 'constraint_reframe'],
      outcome_trit: -1,
      result: 'fail',
      maturity_band: 'developing'
    },
    {
      id: 'ok1',
      ts: '2026-03-04T01:00:00.000Z',
      objective: 'Ship safely',
      signature: 'safe lane pass',
      signature_tokens: ['safe', 'lane', 'pass'],
      target: 'directive',
      impact: 'high',
      certainty: 0.92,
      filter_stack: ['safe_path'],
      outcome_trit: 1,
      result: 'success',
      maturity_band: 'mature'
    }
  ];

  for (const row of baseRows) {
    ts.appendJsonl(libraryPathTs, row);
    rust.appendJsonl(libraryPathRust, row);
  }

  const detectPolicy = {
    immutable_axioms: {
      enabled: true,
      axioms: [
        {
          id: 'safety_guard',
          patterns: ['drift guard'],
          regex: ['drift\\s+guard'],
          intent_tags: ['safety'],
          signals: {
            action_terms: ['drift'],
            subject_terms: ['guard'],
            object_terms: []
          },
          min_signal_groups: 1
        }
      ]
    }
  };
  const detectInput = {
    objective: 'Need drift guard policy',
    signature: 'drift guard now',
    filters: ['constraint_reframe'],
    intent_tags: ['safety']
  };
  assert.deepStrictEqual(
    rust.detectImmutableAxiomViolation(detectPolicy, detectInput),
    ts.detectImmutableAxiomViolation(detectPolicy, detectInput),
    'detectImmutableAxiomViolation mismatch'
  );

  const maturityPolicy = {
    maturity: {
      target_test_count: 40,
      score_weights: {
        pass_rate: 0.5,
        non_destructive_rate: 0.3,
        experience: 0.2
      },
      bands: {
        novice: 0.25,
        developing: 0.45,
        mature: 0.65,
        seasoned: 0.82
      }
    }
  };
  const maturityState = {
    stats: {
      total_tests: 20,
      passed_tests: 15,
      destructive_failures: 2
    }
  };
  assert.deepStrictEqual(
    rust.computeMaturityScore(maturityState, maturityPolicy),
    ts.computeMaturityScore(maturityState, maturityPolicy),
    'computeMaturityScore mismatch'
  );

  const query = {
    signature_tokens: ['drift', 'guard', 'stable'],
    trit_vector: [-1],
    target: 'directive'
  };
  const policyForLib = {
    library: {
      min_similarity_for_reuse: 0.2,
      token_weight: 0.6,
      trit_weight: 0.3,
      target_weight: 0.1
    }
  };
  const tsCandidates = ts.selectLibraryCandidates({ library_path: libraryPathTs }, policyForLib, query);
  const rustCandidates = rust.selectLibraryCandidates({ library_path: libraryPathRust }, policyForLib, query);
  assert.strictEqual(rustCandidates.length, tsCandidates.length, 'selectLibraryCandidates size mismatch');
  assert.strictEqual(rustCandidates[0].row.id, tsCandidates[0].row.id, 'selectLibraryCandidates top id mismatch');

  const laneArgs = { brain_lane: 'right' };
  assert.deepStrictEqual(
    rust.parseLaneDecision(laneArgs, { dual_brain_policy_path: path.join(tmpRoot, 'none.json') }, '2026-03-04'),
    ts.parseLaneDecision(laneArgs, { dual_brain_policy_path: path.join(tmpRoot, 'none.json') }, '2026-03-04'),
    'parseLaneDecision mismatch'
  );

  const mkSweepPaths = (prefix) => {
    const root = path.join(tmpRoot, prefix);
    fs.mkdirSync(path.join(root, 'events'), { recursive: true });
    return {
      active_sessions_path: path.join(root, 'active_sessions.json'),
      receipts_path: path.join(root, 'receipts.jsonl'),
      library_path: path.join(root, 'library.jsonl'),
      events_dir: path.join(root, 'events')
    };
  };
  const tsSweepPaths = mkSweepPaths('ts_sweep');
  const rustSweepPaths = mkSweepPaths('rust_sweep');
  const now = Date.now();
  const expiredAt = new Date(now - 5 * 60 * 1000).toISOString();
  const liveAt = new Date(now + 60 * 60 * 1000).toISOString();
  ts.saveActiveSessions(tsSweepPaths, {
    sessions: [
      { session_id: 'exp', objective: 'old', signature: 'old sig', target: 'directive', impact: 'high', certainty: 0.5, expires_at: expiredAt },
      { session_id: 'live', objective: 'new', signature: 'new sig', target: 'directive', impact: 'high', certainty: 0.6, expires_at: liveAt }
    ]
  });
  rust.saveActiveSessions(rustSweepPaths, {
    sessions: [
      { session_id: 'exp', objective: 'old', signature: 'old sig', target: 'directive', impact: 'high', certainty: 0.5, expires_at: expiredAt },
      { session_id: 'live', objective: 'new', signature: 'new sig', target: 'directive', impact: 'high', certainty: 0.6, expires_at: liveAt }
    ]
  });
  const sweepPolicy = { telemetry: { emit_events: false }, library: { max_entries: 200 } };
  const tsSweep = ts.sweepExpiredSessions(tsSweepPaths, sweepPolicy, '2026-03-04');
  const rustSweep = rust.sweepExpiredSessions(rustSweepPaths, sweepPolicy, '2026-03-04');
  assert.strictEqual(rustSweep.expired_count, tsSweep.expired_count, 'sweepExpiredSessions expired count mismatch');
  assert.strictEqual(rustSweep.sessions.length, tsSweep.sessions.length, 'sweepExpiredSessions keep sessions mismatch');

  const signalRootTs = path.join(tmpRoot, 'ts_signals');
  const signalRootRust = path.join(tmpRoot, 'rust_signals');
  fs.mkdirSync(path.join(signalRootTs, 'simulation'), { recursive: true });
  fs.mkdirSync(path.join(signalRootTs, 'red_team'), { recursive: true });
  fs.mkdirSync(path.join(signalRootRust, 'simulation'), { recursive: true });
  fs.mkdirSync(path.join(signalRootRust, 'red_team'), { recursive: true });

  const signalFiles = [
    ['regime.json', { selected_regime: 'constrained', candidate_confidence: 0.8, context: { trit: { trit: -1 } } }],
    ['mirror.json', { pressure_score: 0.7, confidence: 0.75, reasons: ['pressure', 'drift'] }],
    ['drift_governor.json', { last_decision: { trit_shadow: { belief: { trit: -1 } } } }]
  ];
  for (const [name, payload] of signalFiles) {
    fs.writeFileSync(path.join(signalRootTs, name), JSON.stringify(payload));
    fs.writeFileSync(path.join(signalRootRust, name), JSON.stringify(payload));
  }
  fs.writeFileSync(path.join(signalRootTs, 'simulation', '2026-03-04.json'), JSON.stringify({ checks_effective: { drift_rate: { value: 0.09 }, yield_rate: { value: 0.4 } } }));
  fs.writeFileSync(path.join(signalRootRust, 'simulation', '2026-03-04.json'), JSON.stringify({ checks_effective: { drift_rate: { value: 0.09 }, yield_rate: { value: 0.4 } } }));
  fs.writeFileSync(path.join(signalRootTs, 'red_team', 'latest.json'), JSON.stringify({ summary: { critical_fail_cases: 2, pass_cases: 1, fail_cases: 3 } }));
  fs.writeFileSync(path.join(signalRootRust, 'red_team', 'latest.json'), JSON.stringify({ summary: { critical_fail_cases: 2, pass_cases: 1, fail_cases: 3 } }));

  const signalPolicy = {
    organ: {
      trigger_detection: {
        enabled: true,
        min_impossibility_score: 0.58,
        min_signal_count: 2,
        thresholds: { predicted_drift_warn: 0.03, predicted_yield_warn: 0.68 },
        weights: {
          trit_pain: 0.2,
          mirror_pressure: 0.2,
          predicted_drift: 0.18,
          predicted_yield_gap: 0.18,
          red_team_critical: 0.14,
          regime_constrained: 0.1
        },
        paths: {
          regime_latest_path: 'regime.json',
          mirror_latest_path: 'mirror.json',
          simulation_dir: 'simulation',
          red_team_runs_dir: 'red_team',
          drift_governor_path: 'drift_governor.json'
        }
      }
    }
  };

  const cwd = process.cwd();
  process.chdir(signalRootTs);
  const tsSignals = ts.loadImpossibilitySignals(signalPolicy, '2026-03-04');
  process.chdir(signalRootRust);
  const rustSignals = rust.loadImpossibilitySignals(signalPolicy, '2026-03-04');
  process.chdir(cwd);

  assert.strictEqual(rustSignals.trit.value, tsSignals.trit.value, 'loadImpossibilitySignals trit mismatch');
  assert.strictEqual(rustSignals.red_team.critical_fail_cases, tsSignals.red_team.critical_fail_cases, 'loadImpossibilitySignals red-team mismatch');
  assert.strictEqual(rustSignals.simulation.predicted_drift, tsSignals.simulation.predicted_drift, 'loadImpossibilitySignals drift mismatch');

  const tsTrigger = ts.evaluateImpossibilityTrigger(signalPolicy, tsSignals, false);
  const rustTrigger = rust.evaluateImpossibilityTrigger(signalPolicy, rustSignals, false);
  assert.strictEqual(rustTrigger.triggered, tsTrigger.triggered, 'evaluateImpossibilityTrigger triggered mismatch');
  assert.strictEqual(rustTrigger.signal_count, tsTrigger.signal_count, 'evaluateImpossibilityTrigger signal_count mismatch');

  const fpPolicy = {
    first_principles: {
      enabled: true,
      auto_extract_on_success: true,
      max_strategy_bonus: 0.12,
      allow_failure_cluster_extraction: true,
      failure_cluster_min: 4
    },
    library: policyForLib.library
  };
  const fpSession = {
    session_id: 'sfp',
    objective: 'Reduce drift safely',
    objective_id: 'BL-263',
    target: 'directive',
    certainty: 0.8,
    filter_stack: ['drift_guard'],
    signature: 'drift guard stable',
    signature_tokens: ['drift', 'guard', 'stable']
  };

  const tsPrinciple = ts.extractFirstPrinciple({}, fpPolicy, fpSession, {}, 'success');
  const rustPrinciple = rust.extractFirstPrinciple({}, fpPolicy, fpSession, {}, 'success');
  assert.ok(tsPrinciple && rustPrinciple, 'extractFirstPrinciple null mismatch');
  assert.deepStrictEqual(stripTs(rustPrinciple), stripTs(tsPrinciple), 'extractFirstPrinciple mismatch');

  const tsFailPrinciple = ts.extractFailureClusterPrinciple({ library_path: libraryPathTs }, fpPolicy, fpSession);
  const rustFailPrinciple = rust.extractFailureClusterPrinciple({ library_path: libraryPathRust }, fpPolicy, fpSession);
  assert.ok(tsFailPrinciple && rustFailPrinciple, 'extractFailureClusterPrinciple null mismatch');
  assert.strictEqual(rustFailPrinciple.failure_cluster_count, tsFailPrinciple.failure_cluster_count, 'extractFailureClusterPrinciple count mismatch');

  const tsPersistPaths = {
    first_principles_latest_path: path.join(tmpRoot, 'ts_fp_latest.json'),
    first_principles_history_path: path.join(tmpRoot, 'ts_fp_history.jsonl'),
    first_principles_lock_path: path.join(tmpRoot, 'ts_fp_lock.json')
  };
  const rustPersistPaths = {
    first_principles_latest_path: path.join(tmpRoot, 'rust_fp_latest.json'),
    first_principles_history_path: path.join(tmpRoot, 'rust_fp_history.jsonl'),
    first_principles_lock_path: path.join(tmpRoot, 'rust_fp_lock.json')
  };
  const tsPersisted = ts.persistFirstPrinciple(tsPersistPaths, fpSession, tsPrinciple);
  const rustPersisted = rust.persistFirstPrinciple(rustPersistPaths, fpSession, rustPrinciple);
  assert.deepStrictEqual(stripTs(rustPersisted), stripTs(tsPersisted), 'persistFirstPrinciple return mismatch');
  assert.deepStrictEqual(stripTs(readJson(rustPersistPaths.first_principles_latest_path)), stripTs(readJson(tsPersistPaths.first_principles_latest_path)), 'persistFirstPrinciple latest mismatch');

  console.log('inversion_helper_batch17_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch17_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
