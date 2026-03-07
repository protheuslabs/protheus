#!/usr/bin/env node
'use strict';

const assert = require('assert');
const {
  compileDirectivePulseObjectives,
  assessDirectivePulse
} = require('../../../systems/autonomy/autonomy_controller.js');

let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

function baseProposal() {
  return {
    id: 'PULSE_TEST_1',
    type: 'external_intel',
    title: 'Automate recurring income workflow from high-leverage opportunities',
    expected_impact: 'high',
    summary: 'Create scalable automation that compounds monthly revenue.',
    meta: {
      normalized_objective: 'Generate wealth through scalable, automated systems',
      relevance_score: 82,
      value_oracle_primary_currency: 'revenue'
    }
  };
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   DIRECTIVE PULSE TESTS');
console.log('═══════════════════════════════════════════════════════════');

test('compileDirectivePulseObjectives extracts strategic objectives', () => {
  const objectives = compileDirectivePulseObjectives([
    {
      id: 'T0_invariants',
      tier: 0,
      data: {
        metadata: { id: 'T0_invariants', tier: 0 },
        intent: { primary: 'Never violate safety.' }
      }
    },
    {
      id: 'T1_make_jay_billionaire_v1',
      tier: 1,
      data: {
        metadata: {
          id: 'T1_make_jay_billionaire_v1',
          tier: 1,
          description: 'Generate wealth through scalable, automated systems'
        },
        intent: { primary: 'Generate wealth through scalable, automated systems' },
        scope: { included: ['Income-generating automation'] },
        success_metrics: { leading: ['Monthly recurring revenue growth rate'] }
      }
    }
  ]);

  assert.strictEqual(Array.isArray(objectives), true);
  assert.strictEqual(objectives.length, 1);
  assert.strictEqual(objectives[0].id, 'T1_make_jay_billionaire_v1');
  assert.strictEqual(objectives[0].tier, 1);
  assert.ok(objectives[0].tier_weight > 1);
  assert.ok(objectives[0].tokens.includes('wealth'));
  assert.ok(Array.isArray(objectives[0].value_currencies), 'compiled objectives should include value currencies');
  assert.ok(objectives[0].value_currencies.includes('revenue'), 'revenue should be inferred from directive content');
});

test('assessDirectivePulse produces strong score for aligned T1 objective', () => {
  const proposal = baseProposal();
  const pulse = assessDirectivePulse(
    proposal,
    74,
    78,
    { outcomes: { no_change: 0, reverted: 0 } },
    {
      enabled: true,
      available: true,
      objectives: [
        {
          id: 'T1_make_jay_billionaire_v1',
          tier: 1,
          title: 'Generate wealth through scalable, automated systems',
          tier_weight: 1.3,
          min_share: 0.5,
          phrases: ['generate wealth through scalable automated systems'],
          tokens: ['generate', 'wealth', 'scalable', 'automation', 'income'],
          value_currencies: ['revenue'],
          primary_currency: 'revenue'
        }
      ],
      objective_stats: new Map(),
      tier_attempts_today: { 1: 0 },
      attempts_today: 4,
      urgency_hours: 24,
      no_progress_limit: 3,
      cooldown_hours: 6
    }
  );

  assert.strictEqual(pulse.pass, true);
  assert.strictEqual(pulse.objective_id, 'T1_make_jay_billionaire_v1');
  assert.strictEqual(pulse.tier, 1);
  assert.ok(pulse.score >= 55, `expected pulse score >= 55, got ${pulse.score}`);
  assert.strictEqual(pulse.proposal_value_currency, 'revenue');
  assert.strictEqual(pulse.objective_primary_currency, 'revenue');
  assert.strictEqual(Number(pulse.value_currency_alignment || 0), 1);
});

test('assessDirectivePulse blocks on objective cooldown after repeated no-progress', () => {
  const proposal = baseProposal();
  const now = new Date().toISOString();
  const pulse = assessDirectivePulse(
    proposal,
    70,
    72,
    { outcomes: { no_change: 1, reverted: 0 } },
    {
      enabled: true,
      available: true,
      objectives: [
        {
          id: 'T1_make_jay_billionaire_v1',
          tier: 1,
          title: 'Generate wealth through scalable, automated systems',
          tier_weight: 1.3,
          min_share: 0.5,
          phrases: ['generate wealth through scalable automated systems'],
          tokens: ['generate', 'wealth', 'scalable', 'automation', 'income']
        }
      ],
      objective_stats: new Map([
        ['T1_make_jay_billionaire_v1', {
          objective_id: 'T1_make_jay_billionaire_v1',
          tier: 1,
          attempts: 5,
          shipped: 0,
          no_change: 3,
          reverted: 1,
          no_progress_streak: 3,
          last_attempt_ts: now,
          last_shipped_ts: null
        }]
      ]),
      tier_attempts_today: { 1: 2 },
      attempts_today: 3,
      urgency_hours: 24,
      no_progress_limit: 3,
      cooldown_hours: 6
    }
  );

  assert.strictEqual(pulse.pass, false);
  assert.strictEqual(pulse.objective_id, 'T1_make_jay_billionaire_v1');
  assert.ok(Array.isArray(pulse.reasons) && pulse.reasons.includes('objective_cooldown_active'));
});

if (failed) process.exit(1);
console.log('   ✅ ALL DIRECTIVE PULSE TESTS PASS');
