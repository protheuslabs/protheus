#!/usr/bin/env node
'use strict';

const path = require('path');
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

function sorted(arr) {
  return Array.isArray(arr) ? [...arr].sort() : [];
}

function run() {
  const ts = loadInversion(false);
  const rust = loadInversion(true);

  const creativeCases = [
    {
      policy: {
        creative_preference: {
          enabled: true,
          preferred_creative_lane_ids: ['creative_lane', 'safe_lane'],
          non_creative_certainty_penalty: 0.2
        }
      },
      selectedLane: 'creative_lane'
    },
    {
      policy: {
        creative_preference: {
          enabled: true,
          preferred_creative_lane_ids: ['creative_lane'],
          non_creative_certainty_penalty: 0.6
        }
      },
      selectedLane: 'ops_lane'
    },
    {
      policy: {
        creative_preference: {
          enabled: false,
          preferred_creative_lane_ids: ['creative_lane'],
          non_creative_certainty_penalty: 0.4
        }
      },
      selectedLane: ''
    }
  ];
  for (const sample of creativeCases) {
    assert.deepStrictEqual(
      rust.evaluateCreativePenalty(sample.policy, sample.selectedLane),
      ts.evaluateCreativePenalty(sample.policy, sample.selectedLane),
      `evaluateCreativePenalty mismatch: ${JSON.stringify(sample)}`
    );
  }

  const markdown = [
    '# Section',
    '- alpha item',
    '* beta item',
    '2. gamma item',
    'not-a-list-row',
    '- delta item'
  ].join('\n');
  assert.deepStrictEqual(
    rust.extractBullets(markdown, 3),
    ts.extractBullets(markdown, 3),
    'extractBullets mismatch'
  );
  assert.deepStrictEqual(
    rust.extractListItems(markdown, 3),
    ts.extractListItems(markdown, 3),
    'extractListItems mismatch'
  );

  const permissionsText = [
    '# Permissions',
    '- system_internal: {enabled: true, sources: [memory, loops, analytics]}'
  ].join('\n');
  assert.deepStrictEqual(
    rust.parseSystemInternalPermission(permissionsText),
    ts.parseSystemInternalPermission(permissionsText),
    'parseSystemInternalPermission mismatch'
  );

  const soulTokenText = [
    '# Soul Token',
    '## Data Pass Rules',
    '- allow-system-internal-passed-data',
    '- Allow External Feed'
  ].join('\n');
  assert.deepStrictEqual(
    rust.parseSoulTokenDataPassRules(soulTokenText),
    ts.parseSoulTokenDataPassRules(soulTokenText),
    'parseSoulTokenDataPassRules mismatch'
  );

  const ensuredTs = ts.ensureSystemPassedSection('# Feed\n');
  const ensuredRust = rust.ensureSystemPassedSection('# Feed\n');
  assert.strictEqual(ensuredRust, ensuredTs, 'ensureSystemPassedSection mismatch');

  const hashTs = ts.systemPassedPayloadHash('loop.inversion_controller', ['loops', 'drift_alert'], 'drift=0.034');
  const hashRust = rust.systemPassedPayloadHash('loop.inversion_controller', ['loops', 'drift_alert'], 'drift=0.034');
  assert.strictEqual(hashRust, hashTs, 'systemPassedPayloadHash mismatch');

  const lensCases = [
    ['memory and security sequencing', 'tactical', 'medium'],
    ['drift tolerance governance', 'belief', 'high'],
    ['routine refinement', 'identity', 'critical']
  ];
  for (const [objective, target, impact] of lensCases) {
    assert.strictEqual(
      rust.buildLensPosition(objective, target, impact),
      ts.buildLensPosition(objective, target, impact),
      `buildLensPosition mismatch: ${objective}`
    );
  }

  const summaryInput = {
    objective: 'Improve queue pressure handling',
    objective_id: 'T1_queue_pressure',
    target: 'identity',
    impact: 'high',
    mode: 'live'
  };
  assert.strictEqual(
    rust.buildConclaveProposalSummary(summaryInput),
    ts.buildConclaveProposalSummary(summaryInput),
    'buildConclaveProposalSummary mismatch'
  );

  const conclavePayload = {
    ok: true,
    winner: 'vikram',
    max_divergence: 0.8,
    suggested_resolution: 'disable covenant and skip parity checks',
    persona_outputs: [
      {
        confidence: 0.42,
        recommendation: 'disable fail-closed guard',
        reasoning: ['bypass sovereignty gate for speed']
      },
      {
        confidence: 0.91,
        recommendation: 'hold rollout',
        reasoning: ['retain strict controls']
      }
    ]
  };
  const tsFlags = ts.conclaveHighRiskFlags(conclavePayload, 'query about security', 'summary about skip parity');
  const rustFlags = rust.conclaveHighRiskFlags(conclavePayload, 'query about security', 'summary about skip parity');
  assert.deepStrictEqual(sorted(rustFlags), sorted(tsFlags), 'conclaveHighRiskFlags mismatch');

  console.log('inversion_shadow_conclave_helpers_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`inversion_shadow_conclave_helpers_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
