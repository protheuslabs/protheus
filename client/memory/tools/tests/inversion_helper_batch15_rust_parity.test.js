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

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function withoutUpdatedAt(row) {
  const out = { ...(row || {}) };
  delete out.updated_at;
  return out;
}

function run() {
  const tmpRoot = path.join(REPO_ROOT, 'tmp', 'inversion-batch15-parity');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const mkPaths = (prefix) => {
    const stateDir = path.join(tmpRoot, prefix, 'state');
    fs.mkdirSync(stateDir, { recursive: true });
    return {
      state_dir: stateDir,
      maturity_path: path.join(stateDir, 'maturity.json'),
      active_sessions_path: path.join(stateDir, 'active_sessions.json'),
      events_dir: path.join(stateDir, 'events'),
      latest_path: path.join(stateDir, 'latest.json'),
      history_path: path.join(stateDir, 'history.jsonl'),
      interfaces_latest_path: path.join(stateDir, 'interfaces_latest.json'),
      interfaces_history_path: path.join(stateDir, 'interfaces_history.jsonl'),
      library_path: path.join(stateDir, 'library.jsonl')
    };
  };

  const tsPaths = mkPaths('ts');
  const rustPaths = mkPaths('rust');

  const policy = {
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
    },
    telemetry: {
      emit_events: true
    },
    persona_lens_gate: {
      paths: {
        receipts_path: path.join(tsPaths.state_dir, 'lens_gate_receipts.jsonl')
      }
    },
    library: {
      max_entries: 2
    }
  };

  const maturityInput = {
    stats: {
      total_tests: 20,
      passed_tests: 15,
      failed_tests: 5,
      safe_failures: 4,
      destructive_failures: 1
    },
    recent_tests: []
  };

  const tsSavedMaturity = ts.saveMaturityState(tsPaths, policy, maturityInput);
  const rustSavedMaturity = rust.saveMaturityState(rustPaths, policy, maturityInput);
  assert.deepStrictEqual(
    {
      state: withoutUpdatedAt(tsSavedMaturity.state),
      computed: tsSavedMaturity.computed
    },
    {
      state: withoutUpdatedAt(rustSavedMaturity.state),
      computed: rustSavedMaturity.computed
    },
    'saveMaturityState mismatch'
  );

  const tsLoadedMaturity = ts.loadMaturityState(tsPaths, policy);
  const rustLoadedMaturity = rust.loadMaturityState(rustPaths, policy);
  assert.deepStrictEqual(
    {
      state: withoutUpdatedAt(tsLoadedMaturity.state),
      computed: tsLoadedMaturity.computed
    },
    {
      state: withoutUpdatedAt(rustLoadedMaturity.state),
      computed: rustLoadedMaturity.computed
    },
    'loadMaturityState mismatch'
  );

  const activeStore = { sessions: [{ session_id: 's1' }, { session_id: 's2' }] };
  const tsSavedSessions = ts.saveActiveSessions(tsPaths, activeStore);
  const rustSavedSessions = rust.saveActiveSessions(rustPaths, activeStore);
  assert.deepStrictEqual(withoutUpdatedAt(rustSavedSessions), withoutUpdatedAt(tsSavedSessions), 'saveActiveSessions mismatch');
  assert.deepStrictEqual(
    withoutUpdatedAt(rust.loadActiveSessions(rustPaths)),
    withoutUpdatedAt(ts.loadActiveSessions(tsPaths)),
    'loadActiveSessions mismatch'
  );

  ts.emitEvent(tsPaths, policy, '2026-03-04', 'lane_selection', { ok: true });
  rust.emitEvent(rustPaths, policy, '2026-03-04', 'lane_selection', { ok: true });
  const tsEvents = readJsonl(path.join(tsPaths.events_dir, '2026-03-04.jsonl'));
  const rustEvents = readJsonl(path.join(rustPaths.events_dir, '2026-03-04.jsonl'));
  assert.strictEqual(tsEvents.length, 1, 'ts emitEvent missing row');
  assert.strictEqual(rustEvents.length, 1, 'rust emitEvent missing row');
  assert.strictEqual(rustEvents[0].event, tsEvents[0].event, 'emitEvent event mismatch');
  assert.deepStrictEqual(rustEvents[0].payload, tsEvents[0].payload, 'emitEvent payload mismatch');

  const payload = {
    enabled: true,
    persona_id: 'vikram',
    mode: 'auto',
    effective_mode: 'enforce',
    status: 'enforced',
    fail_closed: false,
    drift_rate: 0.01,
    drift_threshold: 0.02,
    parity_confidence: 0.9,
    parity_confident: true,
    reasons: ['ok']
  };
  const decision = {
    allowed: true,
    input: {
      objective: 'Ship safely',
      target: 'belief',
      impact: 'high'
    }
  };

  const tsReceiptPath = path.join(tsPaths.state_dir, 'lens_gate_receipts.jsonl');
  const rustReceiptPath = path.join(rustPaths.state_dir, 'lens_gate_receipts.jsonl');
  const tsPolicy = { ...policy, persona_lens_gate: { paths: { receipts_path: tsReceiptPath } } };
  const rustPolicy = { ...policy, persona_lens_gate: { paths: { receipts_path: rustReceiptPath } } };

  const tsRel = ts.appendPersonaLensGateReceipt(tsPaths, tsPolicy, payload, decision);
  const rustRel = rust.appendPersonaLensGateReceipt(rustPaths, rustPolicy, payload, decision);
  assert.ok(tsRel && rustRel, 'appendPersonaLensGateReceipt rel path missing');
  const tsReceiptRows = readJsonl(tsReceiptPath);
  const rustReceiptRows = readJsonl(rustReceiptPath);
  assert.strictEqual(tsReceiptRows.length, 1, 'ts receipt row missing');
  assert.strictEqual(rustReceiptRows.length, 1, 'rust receipt row missing');
  delete tsReceiptRows[0].ts;
  delete rustReceiptRows[0].ts;
  assert.deepStrictEqual(rustReceiptRows[0], tsReceiptRows[0], 'appendPersonaLensGateReceipt row mismatch');

  const tsCorrespondence = path.join(tsPaths.state_dir, 'correspondence.md');
  const rustCorrespondence = path.join(rustPaths.state_dir, 'correspondence.md');
  const conclaveRow = {
    ts: '2026-03-04T12:06:00.000Z',
    session_or_step: 'step-1',
    pass: true,
    winner: 'vikram',
    arbitration_rule: 'safety_first',
    high_risk_flags: ['none'],
    query: 'q',
    proposal_summary: 's',
    receipt_path: 'r',
    review_payload: { ok: true }
  };
  ts.appendConclaveCorrespondence(tsCorrespondence, conclaveRow);
  rust.appendConclaveCorrespondence(rustCorrespondence, conclaveRow);
  assert.strictEqual(
    fs.readFileSync(rustCorrespondence, 'utf8'),
    fs.readFileSync(tsCorrespondence, 'utf8'),
    'appendConclaveCorrespondence mismatch'
  );

  const decisionPayload = { objective: 'x', ok: true };
  ts.persistDecision(tsPaths, decisionPayload);
  rust.persistDecision(rustPaths, decisionPayload);
  assert.deepStrictEqual(readJson(rustPaths.latest_path), readJson(tsPaths.latest_path), 'persistDecision latest mismatch');
  assert.deepStrictEqual(readJsonl(rustPaths.history_path), readJsonl(tsPaths.history_path), 'persistDecision history mismatch');

  const envelope = { channel: 'code_change_proposal', ok: true };
  ts.persistInterfaceEnvelope(tsPaths, envelope);
  rust.persistInterfaceEnvelope(rustPaths, envelope);
  assert.deepStrictEqual(
    readJson(rustPaths.interfaces_latest_path),
    readJson(tsPaths.interfaces_latest_path),
    'persistInterfaceEnvelope latest mismatch'
  );
  assert.deepStrictEqual(
    readJsonl(rustPaths.interfaces_history_path),
    readJsonl(tsPaths.interfaces_history_path),
    'persistInterfaceEnvelope history mismatch'
  );

  [
    { id: 'a', ts: '2026-03-04T00:00:00.000Z', objective: 'one' },
    { id: 'b', ts: '2026-03-04T00:01:00.000Z', objective: 'two' },
    { id: 'c', ts: '2026-03-04T00:02:00.000Z', objective: 'three' }
  ].forEach((row) => {
    ts.appendJsonl(tsPaths.library_path, row);
    rust.appendJsonl(rustPaths.library_path, row);
  });

  const tsTrimmed = ts.trimLibrary(tsPaths, policy);
  const rustTrimmed = rust.trimLibrary(rustPaths, policy);
  assert.deepStrictEqual(rustTrimmed, tsTrimmed, 'trimLibrary mismatch');

  console.log('inversion_helper_batch15_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_helper_batch15_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
