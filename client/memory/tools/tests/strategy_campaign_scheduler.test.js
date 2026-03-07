#!/usr/bin/env node
'use strict';

const assert = require('assert');
const { annotateCampaignPriority } = require('../../../lib/strategy_campaign_scheduler.js');

function run() {
  const strategy = {
    id: 'default_general',
    campaigns: [
      {
        id: 'campaign_alpha',
        status: 'active',
        priority: 10,
        objective_id: 'T1_test',
        phases: [
          {
            id: 'phase_discover',
            status: 'active',
            order: 1,
            priority: 60,
            proposal_types: ['external_intel']
          },
          {
            id: 'phase_execute',
            status: 'active',
            order: 2,
            priority: 50,
            proposal_types: ['collector_remediation']
          }
        ]
      }
    ]
  };

  const candidates = [
    {
      proposal: {
        id: 'P1',
        type: 'collector_remediation',
        meta: { source_eye: 'local_state_fallback' }
      },
      objective_binding: { objective_id: 'T1_test' }
    },
    {
      proposal: {
        id: 'P2',
        type: 'external_intel',
        meta: { source_eye: 'local_state_fallback' }
      },
      objective_binding: { objective_id: 'T1_test' }
    },
    {
      proposal: {
        id: 'P3',
        type: 'pain_signal_escalation',
        meta: { source_eye: 'local_state_fallback' }
      },
      objective_binding: { objective_id: 'T1_test' }
    }
  ];

  const plan = annotateCampaignPriority(candidates, strategy);
  assert.strictEqual(plan.enabled, true, 'campaign scheduler should be enabled');
  assert.strictEqual(plan.campaign_count, 1, 'should report one active campaign');
  assert.strictEqual(plan.matched_count, 2, 'expected two campaign-matched candidates');

  assert.ok(candidates[0].campaign_match, 'collector candidate should match campaign');
  assert.strictEqual(candidates[0].campaign_match.phase_id, 'phase_execute');
  assert.ok(candidates[1].campaign_match, 'external intel candidate should match campaign');
  assert.strictEqual(candidates[1].campaign_match.phase_id, 'phase_discover');
  assert.ok(Number(candidates[1].campaign_sort_score || 0) > Number(candidates[0].campaign_sort_score || 0), 'phase order should favor phase_discover before phase_execute');
  assert.strictEqual(candidates[2].campaign_match, null, 'unmatched candidate should remain null');
  assert.strictEqual(Number(candidates[2].campaign_sort_bucket || 0), 0, 'unmatched candidate should stay in non-campaign bucket');

  const noCampaignCandidates = [
    { proposal: { id: 'X1', type: 'external_intel' } },
    { proposal: { id: 'X2', type: 'collector_remediation' } }
  ];
  const noCampaignPlan = annotateCampaignPriority(noCampaignCandidates, { id: 'none' });
  assert.strictEqual(noCampaignPlan.enabled, false, 'scheduler should disable when no campaigns configured');
  assert.strictEqual(noCampaignPlan.matched_count, 0, 'no matches expected without campaigns');
  assert.strictEqual(noCampaignCandidates[0].campaign_match, null);
  assert.strictEqual(noCampaignCandidates[1].campaign_match, null);

  console.log('strategy_campaign_scheduler.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`strategy_campaign_scheduler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
