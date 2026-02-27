#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { loadActiveDirectives } = require('../../../lib/directive_resolver.js');

function banner(title) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(title);
  console.log('═══════════════════════════════════════════════════════════');
}

function mkDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function run() {
  banner('PROPOSAL ENRICHER TESTS');

  const tmpRoot = path.join(__dirname, 'temp_proposal_enricher');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const sensoryDir = path.join(tmpRoot, 'state', 'sensory');
  const proposalsDir = path.join(sensoryDir, 'proposals');
  mkDir(proposalsDir);
  mkDir(path.join(sensoryDir, 'eyes'));

  const date = '2026-02-19';
  const proposalsPath = path.join(proposalsDir, `${date}.json`);
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const eyesConfigPath = path.join(repoRoot, 'adaptive', 'sensory', 'eyes', 'catalog.json');
  const eyesRegistryPath = path.join(sensoryDir, 'eyes', 'registry.json');
  const dreamsDir = path.join(tmpRoot, 'state', 'memory', 'dreams');
  const eyesConfigBefore = fs.existsSync(eyesConfigPath) ? fs.readFileSync(eyesConfigPath, 'utf8') : null;
  const outcomePolicyBefore = process.env.OUTCOME_FITNESS_POLICY_PATH;
  const dreamsDirBefore = process.env.PROPOSAL_ENRICHER_DREAMS_DIR;
  const dreamBonusCapBefore = process.env.AUTONOMY_DREAM_DIRECTIVE_BONUS_CAP;
  const revenueOracleBefore = process.env.AUTONOMY_REVENUE_ORACLE_REQUIRED;
  const revenueOracleScopeBefore = process.env.AUTONOMY_REVENUE_ORACLE_SCOPE;
  const revenueOracleExemptBefore = process.env.AUTONOMY_REVENUE_ORACLE_EXEMPT_TYPES;
  const valueOracleBefore = process.env.AUTONOMY_VALUE_ORACLE_REQUIRED;
  const valueOracleScopeBefore = process.env.AUTONOMY_VALUE_ORACLE_SCOPE;
  const valueOracleExemptBefore = process.env.AUTONOMY_VALUE_ORACLE_EXEMPT_TYPES;
  const valueOracleDefaultCurrenciesBefore = process.env.AUTONOMY_VALUE_ORACLE_DEFAULT_CURRENCIES;
  const valueOracleRequirePrimaryBefore = process.env.AUTONOMY_VALUE_ORACLE_REQUIRE_PRIMARY_SIGNAL;
  const mutationGuardRequiredBefore = process.env.AUTONOMY_MUTATION_GUARD_REQUIRED;
  const mutationBudgetMaxBefore = process.env.AUTONOMY_MUTATION_BUDGET_CAP_MAX;
  const mutationTtlMaxBefore = process.env.AUTONOMY_MUTATION_TTL_HOURS_MAX;
  const mutationQuarantineMinBefore = process.env.AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN;
  const mutationVetoMinBefore = process.env.AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN;
  const mutationKernelPolicyBefore = process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH;
  const mutationKernelRunsBefore = process.env.MUTATION_SAFETY_RUNS_DIR;
  const mutationKernelStateBefore = process.env.MUTATION_SAFETY_STATE_DIR;
  const outcomePolicyPath = path.join(tmpRoot, 'outcome_fitness.json');
  const mutationKernelPolicyPath = path.join(tmpRoot, 'mutation_safety_kernel_policy.json');
  const mutationKernelRunsDir = path.join(tmpRoot, 'state', 'autonomy', 'runs');
  const mutationKernelStateDir = path.join(tmpRoot, 'state', 'autonomy', 'mutation_safety_kernel');
  const objectiveId = (() => {
    try {
      const directives = loadActiveDirectives({ allowMissing: true });
      for (const row of directives) {
        const id = String((row && row.id) || (row && row.data && row.data.metadata && row.data.metadata.id) || '').trim();
        if (/^T[0-9]_[A-Za-z0-9_]+$/.test(id)) return id;
      }
    } catch {
      // ignore
    }
    return '';
  })();

  try {
    process.env.SENSORY_TEST_DIR = sensoryDir;
    process.env.PROPOSAL_ENRICHER_EYES_REGISTRY = eyesRegistryPath;
    process.env.AUTONOMY_ALLOWED_RISKS = 'low';
    process.env.AUTONOMY_MIN_SENSORY_SIGNAL_SCORE = '35';
    process.env.AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE = '35';
    process.env.AUTONOMY_MIN_DIRECTIVE_FIT = '20';
    process.env.AUTONOMY_MIN_ACTIONABILITY_SCORE = '35';
    process.env.AUTONOMY_MIN_COMPOSITE_ELIGIBILITY = '45';
    process.env.AUTONOMY_DREAM_DIRECTIVE_BONUS_CAP = '6';
    process.env.AUTONOMY_VALUE_ORACLE_REQUIRED = '1';
    process.env.AUTONOMY_VALUE_ORACLE_SCOPE = 'dream';
    process.env.AUTONOMY_VALUE_ORACLE_EXEMPT_TYPES = 'pain_signal_escalation,dream_cycle_escalation,collector_remediation,infrastructure_outage,directive_clarification,directive_decomposition';
    process.env.AUTONOMY_VALUE_ORACLE_DEFAULT_CURRENCIES = 'revenue,delivery';
    process.env.AUTONOMY_VALUE_ORACLE_REQUIRE_PRIMARY_SIGNAL = '0';
    process.env.AUTONOMY_MUTATION_GUARD_REQUIRED = '1';
    process.env.AUTONOMY_MUTATION_BUDGET_CAP_MAX = '5';
    process.env.AUTONOMY_MUTATION_TTL_HOURS_MAX = '168';
    process.env.AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN = '24';
    process.env.AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN = '24';
    process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH = mutationKernelPolicyPath;
    process.env.MUTATION_SAFETY_RUNS_DIR = mutationKernelRunsDir;
    process.env.MUTATION_SAFETY_STATE_DIR = mutationKernelStateDir;
    process.env.AUTONOMY_REVENUE_ORACLE_REQUIRED = '1';
    process.env.AUTONOMY_REVENUE_ORACLE_SCOPE = 'dream';
    process.env.AUTONOMY_REVENUE_ORACLE_EXEMPT_TYPES = 'pain_signal_escalation,dream_cycle_escalation,collector_remediation,infrastructure_outage,directive_clarification,directive_decomposition';
    process.env.PROPOSAL_ENRICHER_DREAMS_DIR = dreamsDir;
    fs.writeFileSync(outcomePolicyPath, JSON.stringify({
      strategy_policy: {
        proposal_type_threshold_offsets: {
          collector_remediation: {
            min_actionability_score: 4,
            min_directive_fit: 2
          }
        }
      }
    }, null, 2));
    process.env.OUTCOME_FITNESS_POLICY_PATH = outcomePolicyPath;
    fs.mkdirSync(mutationKernelRunsDir, { recursive: true });
    fs.writeFileSync(mutationKernelPolicyPath, JSON.stringify({
      version: '1.0',
      max_mutation_attempts_per_day: 100,
      high_risk_score_min: 70,
      medium_risk_score_min: 45,
      require_lineage_id: true,
      require_policy_root_for_high: true,
      require_dual_control_for_high: true
    }, null, 2), 'utf8');

    fs.mkdirSync(path.dirname(eyesConfigPath), { recursive: true });
    fs.writeFileSync(eyesConfigPath, JSON.stringify({
      version: '1.0',
      eyes: [
        {
          id: 'local_state_fallback',
          status: 'active',
          parser_type: 'local_state_digest',
          score_ema: 68
        }
      ]
    }, null, 2));

    fs.writeFileSync(eyesRegistryPath, JSON.stringify({
      version: '1.0',
      eyes: [
        {
          id: 'local_state_fallback',
          status: 'active',
          parser_type: 'local_state_digest',
          score_ema: 68
        }
      ]
    }, null, 2));
    mkDir(dreamsDir);
    mkDir(path.join(dreamsDir, 'rem'));
    fs.writeFileSync(path.join(dreamsDir, `${date}.json`), JSON.stringify({
      ts: `${date}T00:00:00.000Z`,
      date,
      themes: [
        { token: 'automation', score: 91 },
        { token: 'reliability', score: 85 }
      ]
    }, null, 2));
    fs.writeFileSync(path.join(dreamsDir, 'rem', `${date}.json`), JSON.stringify({
      ts: `${date}T00:00:00.000Z`,
      type: 'rem_quantized',
      date,
      quantized: [
        { token: 'automation', weight: 24 },
        { token: 'collector', weight: 12 }
      ]
    }, null, 2));

    fs.writeFileSync(proposalsPath, JSON.stringify([
      {
        id: 'PLOW',
        type: 'collector_remediation',
        title: '[Collector] Stabilize failing sensor collector (hn_frontpage)',
        expected_impact: 'medium',
        risk: 'low',
        evidence: [{ evidence_ref: 'eye:local_state_fallback', match: 'collector failed twice' }],
        validation: [
          'Implement deterministic fix',
          'Define measurable error-rate target and 24h verification window',
          'Record proposal outcome'
        ],
        action_spec: objectiveId
          ? {
              version: 1,
              objective_id: objectiveId,
              target: 'eye:local_state_fallback',
              next_command: 'node systems/routing/route_execute.js --task="Improve automation growth reliability with deterministic checks" --dry-run',
              verify: ['record outcome'],
              success_criteria: [{ metric: 'artifact_count', target: '>=1 artifact', horizon: '24h' }],
              rollback: 'revert bounded remediation'
            }
          : undefined,
        meta: objectiveId ? { directive_objective_id: objectiveId } : undefined,
        suggested_next_command: 'node systems/routing/route_execute.js --task="Improve automation growth reliability with deterministic checks" --dry-run'
      },
      {
        id: 'PMISSING',
        type: 'collector_remediation',
        title: '[Collector] Restore parser coverage after repeated fetch errors',
        expected_impact: 'medium',
        risk: 'low',
        evidence: [{ evidence_ref: 'eye:local_state_fallback', match: 'collector failed repeatedly' }],
        validation: ['Implement deterministic collector fix', 'Record proposal outcome'],
        meta: objectiveId ? { directive_objective_id: objectiveId } : undefined,
        suggested_next_command: 'node systems/routing/route_execute.js --task=\"Restore parser coverage with deterministic collector diagnostics\" --dry-run'
      },
      {
        id: 'PHIGH',
        type: 'external_intel',
        title: 'High risk discretionary action',
        expected_impact: 'high',
        risk: 'high',
        evidence: [{ evidence_ref: 'eye:local_state_fallback', match: 'high risk source' }],
        validation: ['Review manually'],
        meta: objectiveId ? { directive_objective_id: objectiveId } : undefined,
        suggested_next_command: 'node systems/routing/route_execute.js --task="Explore discretionary high risk option" --dry-run'
      }
    ], null, 2));

    const script = require('../../../systems/autonomy/proposal_enricher.js');
    const out = script.runForDate(date, false);
    assert.strictEqual(out.ok, true, 'runForDate should return ok');
    assert.strictEqual(out.total, 3, 'should process all proposals');
    assert.ok(Number(out.changed) >= 1, 'should enrich at least one proposal');
    assert.ok(out.admission && typeof out.admission === 'object', 'should return admission summary');
    assert.ok(out.objective_binding && typeof out.objective_binding === 'object', 'should return objective binding summary');
    assert.ok(out.dream_alignment && typeof out.dream_alignment === 'object', 'should return dream alignment summary');
    assert.strictEqual(out.dream_alignment.available, true, 'dream alignment should be available when dream inputs exist');
    assert.ok(Number(out.dream_alignment.quality_score || 0) > 0, 'dream alignment summary should expose quality score');
    assert.ok(Number(out.dream_alignment.quality_scale || 0) > 0, 'dream alignment summary should expose quality scale');
    assert.ok(Number(out.dream_alignment.tokens_loaded || 0) >= 2, 'dream alignment should load dream tokens');

    const enriched = readJson(proposalsPath);
    assert.ok(Array.isArray(enriched), 'output file should remain array');
    assert.strictEqual(enriched.length, 3, 'proposal count should be preserved');

    const low = enriched.find(p => p.id === 'PLOW');
    const missing = enriched.find(p => p.id === 'PMISSING');
    const high = enriched.find(p => p.id === 'PHIGH');
    assert.ok(low && missing && high, 'all proposals should exist');

    assert.ok(typeof low.summary === 'string' && low.summary.length > 20, 'normalizer should add summary');
    assert.ok(typeof low.notes === 'string' && low.notes.length > 20, 'normalizer should add notes');
    assert.ok(low.meta && typeof low.meta.normalized_objective === 'string', 'normalizer writes objective');
    assert.ok(low.meta && typeof low.meta.normalized_expected_outcome === 'string', 'normalizer writes expected outcome');
    assert.ok(low.meta && typeof low.meta.normalized_validation_metric === 'string', 'normalizer writes validation metric');
    assert.ok(low.meta && Array.isArray(low.meta.normalized_hint_tokens) && low.meta.normalized_hint_tokens.length >= 1, 'normalizer writes hint tokens');
    assert.ok(low.meta && low.meta.normalization_version === '1.0', 'normalizer version should be tracked');

    assert.ok(low.meta && Number.isFinite(Number(low.meta.signal_quality_score)), 'low proposal has signal score');
    assert.ok(low.meta && Number.isFinite(Number(low.meta.relevance_score)), 'low proposal has relevance score');
    assert.ok(low.meta && Number.isFinite(Number(low.meta.directive_fit_score)), 'low proposal has directive fit score');
    assert.ok(Number(low.meta.directive_fit_score || 0) >= Number(low.meta.directive_fit_base_score || 0), 'dream bonus should not reduce directive fit');
    assert.ok(Number(low.meta.dream_alignment_bonus || 0) >= 1, 'low proposal should receive bounded dream bonus');
    assert.ok(Number(low.meta.dream_signal_quality_score || 0) > 0, 'proposal meta should include dream quality score');
    assert.ok(Number(low.meta.dream_signal_quality_scale || 0) > 0, 'proposal meta should include dream quality scaling');
    assert.ok(
      Array.isArray(low.meta.dream_alignment_tokens) && low.meta.dream_alignment_tokens.includes('automation'),
      'dream alignment should record matching token evidence'
    );
    assert.ok(low.meta && Number.isFinite(Number(low.meta.actionability_score)), 'low proposal has actionability score');
    assert.ok(low.meta && Number.isFinite(Number(low.meta.composite_eligibility_score)), 'low proposal has composite score');
    assert.strictEqual(
      Number(low.meta && low.meta.type_threshold_offsets && low.meta.type_threshold_offsets.min_actionability_score || 0),
      4,
      'per-type threshold offset should be attached to meta'
    );
    assert.ok(
      low.meta && low.meta.type_thresholds_applied && Number.isFinite(Number(low.meta.type_thresholds_applied.min_actionability_score)),
      'type-adjusted thresholds should be attached to meta'
    );
    assert.ok(Array.isArray(low.meta.directive_fit_positive) && low.meta.directive_fit_positive.length >= 1, 'normalizer should produce directive-fit positives');
    assert.ok(low.meta && low.meta.admission_preview && low.meta.admission_preview.eligible === true, 'low-risk OPEN proposal should be eligible');
    assert.ok(
      missing.action_spec
        && Array.isArray(missing.action_spec.success_criteria)
        && missing.action_spec.success_criteria.length >= 1,
      'enricher should compile canonical success criteria into action_spec'
    );
    assert.ok(
      Number((missing.meta && missing.meta.success_criteria_compiled_count) || 0) >= 1,
      'compiled criteria count should be tracked in meta'
    );
    assert.ok(
      Array.isArray(missing.meta.admission_preview.blocked_by)
        && !missing.meta.admission_preview.blocked_by.includes('success_criteria_missing'),
      'compiled criteria should clear success_criteria_missing blocker'
    );
    assert.ok(
      !objectiveId || (low.meta && low.meta.objective_binding_required === true),
      'executable proposal should require objective binding when objectives exist'
    );
    assert.ok(low.meta && low.meta.objective_binding_valid !== false, 'low-risk proposal should have valid objective binding');
    if (objectiveId) {
      assert.strictEqual(low.meta.directive_objective_id, objectiveId, 'objective binding should retain directive objective id');
      assert.strictEqual(low.meta.objective_id, objectiveId, 'objective_id should be normalized');
    }

    const fallbackRes = script.enrichOne({
      id: 'PFALLBACK',
      type: 'external_intel',
      title: 'Unbound executable proposal should default to first active objective',
      risk: 'low',
      evidence: [{ evidence_ref: 'eye:local_state_fallback' }],
      suggested_next_command: 'node systems/routing/route_execute.js --task=\"Run one bounded execution\" --dry-run',
      validation: ['Emit one artifact receipt with measurable outcome']
    }, {
      eyes: new Map(),
      directiveProfile: { available: false, active_directive_ids: [] },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE', 'T2_BETA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    assert.ok(fallbackRes && fallbackRes.proposal && fallbackRes.proposal.meta, 'fallback enrichment should return proposal with meta');
    assert.strictEqual(
      fallbackRes.proposal.meta.objective_id,
      'T1_ALPHA_OBJECTIVE',
      'unbound executable should default to first active objective'
    );
    assert.strictEqual(
      fallbackRes.proposal.meta.objective_binding_source,
      'default_first_active_objective',
      'fallback source should be recorded for audit'
    );
    assert.strictEqual(
      fallbackRes.proposal.meta.objective_binding_valid,
      true,
      'default fallback objective binding should be marked valid'
    );
    const measurableRes = script.enrichOne({
      id: 'PMEASURE',
      type: 'cross_signal_opportunity',
      title: '[Cross-Signal] Topic convergence with bounded execution',
      risk: 'low',
      evidence: [{ evidence_ref: 'cross_signal:HYP-1', match: 'topic convergence' }],
      suggested_next_command: 'node systems/routing/route_execute.js --task=\"Validate one bounded experiment\" --dry-run',
      action_spec: {
        version: 1,
        objective_id: 'T1_ALPHA_OBJECTIVE',
        target: 'cross_signal:HYP-1',
        verify: ['Generate one concrete experiment tied to hypothesis evidence'],
        success_criteria: [
          { metric: 'hypothesis_signal_lift', target: 'observable trend/support improvement from baseline', horizon: 'next run' }
        ],
        rollback: 'cancel plan'
      },
      validation: ['Generate one concrete experiment tied to hypothesis evidence']
    }, {
      eyes: new Map(),
      directiveProfile: { available: false, active_directive_ids: [] },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE', 'T2_BETA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    assert.ok(measurableRes && measurableRes.proposal && measurableRes.proposal.meta, 'measurable enrichment should return proposal with meta');
    assert.ok(
      Number(measurableRes.proposal.meta.success_criteria_measurable_count || 0) >= 1,
      'structured success criteria with next-run horizon should count as measurable'
    );
    assert.ok(
      !((measurableRes.proposal.meta.admission_preview || {}).blocked_by || []).includes('success_criteria_missing'),
      'measurable structured criteria should not trigger success_criteria_missing blocker'
    );
    const metaNoopRes = script.enrichOne({
      id: 'PMETA_NOOP',
      type: 'collector_remediation',
      title: 'Review system automation health and prioritize one high leverage improvement',
      risk: 'low',
      evidence: [{ evidence_ref: 'eye:local_state_fallback', match: 'proposal backlog unchanged' }],
      validation: ['Review proposal status and report findings'],
      suggested_next_command: 'node systems/routing/route_execute.js --task=\"Review automation health and triage proposals\" --dry-run'
    }, {
      eyes: new Map(),
      directiveProfile: { available: false, active_directive_ids: [] },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    assert.ok(metaNoopRes && metaNoopRes.proposal && metaNoopRes.proposal.meta, 'meta-noop proposal should be enriched');
    assert.strictEqual(
      (metaNoopRes.proposal.meta.admission_preview || {}).eligible,
      false,
      'meta-noop proposal should be blocked'
    );
    const metaBlocked = (metaNoopRes.proposal.meta.admission_preview || {}).blocked_by || [];
    assert.ok(
      Array.isArray(metaBlocked) && metaBlocked.includes('meta_missing_concrete_delta'),
      'meta-noop proposal should require a concrete delta'
    );
    assert.ok(
      Array.isArray(metaBlocked) && metaBlocked.includes('meta_missing_measurable_outcome'),
      'meta-noop proposal should require measurable outcome evidence'
    );
    const dreamBlockedRes = script.enrichOne({
      id: 'PDREAM_BLOCKED',
      type: 'dream_revenue_probe',
      title: 'Improve dream synthesis reliability and cadence',
      summary: 'Improve dream synthesis reliability and cadence.',
      risk: 'low',
      evidence: [{ evidence_ref: 'dream:idle:model_timeout', match: 'idle dream preflight degradation' }],
      validation: ['Run bounded simulation and verify queue impact'],
      suggested_next_command: 'node systems/routing/route_execute.js --task=\"Simulate one bounded dream intervention\" --dry-run'
    }, {
      eyes: new Map(),
      directiveProfile: { available: false, active_directive_ids: [] },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    const dreamBlocked = (dreamBlockedRes.proposal.meta.admission_preview || {}).blocked_by || [];
    assert.ok(
      Array.isArray(dreamBlocked) && dreamBlocked.includes('value_oracle_first_sentence_missing'),
      'dream-origin proposal without first-sentence value signal should be blocked by value oracle'
    );
    assert.strictEqual(
      dreamBlockedRes.proposal.meta.value_oracle_applies,
      true,
      'dream-origin proposal should trigger value oracle scope'
    );
    const dreamValueRes = script.enrichOne({
      id: 'PDREAM_VALUE',
      type: 'dream_revenue_probe',
      title: 'Run customer lead pilot from dream signal',
      summary: 'Customer lead pilot targets $500 monthly revenue from an Upwork automation niche.',
      risk: 'low',
      evidence: [{ evidence_ref: 'dream:idle:market_signal', match: 'external demand for automation gigs' }],
      validation: ['Simulate one pilot and verify projected ROI before execution'],
      suggested_next_command: 'node systems/routing/route_execute.js --task=\"Simulate one bounded Upwork lead pilot\" --dry-run',
      action_spec: {
        version: 1,
        objective_id: 'T1_ALPHA_OBJECTIVE',
        target: 'upwork:automation',
        verify: ['record simulation receipts'],
        success_criteria: [
          { metric: 'revenue_actions_count', target: '>=1 verified projected revenue action', horizon: 'next run' }
        ],
        rollback: 'cancel pilot'
      }
    }, {
      eyes: new Map(),
      directiveProfile: { available: false, active_directive_ids: [] },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    assert.strictEqual(
      dreamValueRes.proposal.meta.value_oracle_applies,
      true,
      'dream-origin value proposal should trigger value oracle'
    );
    assert.strictEqual(
      dreamValueRes.proposal.meta.value_oracle_pass,
      true,
      'dream-origin proposal with first-sentence customer/revenue signal should pass value oracle'
    );
    assert.ok(
      !((dreamValueRes.proposal.meta.admission_preview || {}).blocked_by || []).includes('value_oracle_first_sentence_missing'),
      'value-oriented dream proposal should not be blocked by first-sentence revenue gate'
    );
    const directiveDeliveryRes = script.enrichOne({
      id: 'PDREAM_DELIVERY',
      type: 'dream_build_probe',
      title: 'Build deterministic publish pipeline from dream link',
      summary: 'Build and ship the deterministic publish workflow this run.',
      risk: 'low',
      evidence: [{ evidence_ref: 'dream:idle:workflow_gap', match: 'delivery bottleneck found in dream synthesis' }],
      validation: ['Implement one bounded file-level patch and verify postconditions'],
      suggested_next_command: 'node systems/routing/route_execute.js --task=\"Implement one bounded workflow patch\" --dry-run'
    }, {
      eyes: new Map(),
      directiveProfile: {
        available: true,
        strategy_id: 'delivery-focus',
        strategy_tokens: ['ship', 'deliverable'],
        active_directive_ids: ['T1_ALPHA_OBJECTIVE'],
        positive_phrases: ['Ship one concrete deliverable'],
        negative_phrases: [],
        positive_tokens: ['build', 'ship', 'deliver'],
        negative_tokens: []
      },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    assert.strictEqual(
      directiveDeliveryRes.proposal.meta.value_oracle_pass,
      true,
      'delivery-oriented directive should allow non-revenue dream proposal when delivery currency matches'
    );
    assert.strictEqual(
      directiveDeliveryRes.proposal.meta.value_oracle_primary_currency,
      'delivery',
      'value oracle should derive delivery as primary currency from directive profile'
    );
    assert.ok(
      Array.isArray(directiveDeliveryRes.proposal.meta.value_oracle_matched_currencies)
      && directiveDeliveryRes.proposal.meta.value_oracle_matched_currencies.includes('delivery'),
      'delivery-oriented proposal should match delivery value currency'
    );
    const mutationBlockedRes = script.enrichOne({
      id: 'PMUTATION_BLOCKED',
      type: 'adaptive_topology_mutation',
      title: 'Adaptive topology mutation to rewire spawn branches',
      summary: 'Mutate branch topology for higher throughput.',
      risk: 'low',
      evidence: [{ evidence_ref: 'dream:idle:topology_shift', match: 'spawn branch churn detected' }],
      validation: ['Run bounded dry-run and verify postconditions'],
      suggested_next_command: 'node systems/routing/route_execute.js --task=\"Simulate topology mutation\" --dry-run'
    }, {
      eyes: new Map(),
      directiveProfile: { available: false, active_directive_ids: [] },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    const mutationBlockedReasons = (mutationBlockedRes.proposal.meta.admission_preview || {}).blocked_by || [];
    assert.strictEqual(
      mutationBlockedRes.proposal.meta.adaptive_mutation_guard_applies,
      true,
      'adaptive mutation proposal should trigger mutation safety guard'
    );
    assert.strictEqual(
      mutationBlockedRes.proposal.meta.adaptive_mutation_guard_pass,
      false,
      'adaptive mutation proposal without controls should fail safety guard'
    );
    assert.ok(
      Array.isArray(mutationBlockedReasons) && mutationBlockedReasons.includes('adaptive_mutation_missing_safety_attestation'),
      'adaptive mutation proposal should fail closed when safety attestation is missing'
    );

    const mutationPassRes = script.enrichOne({
      id: 'PMUTATION_PASS',
      type: 'adaptive_topology_mutation',
      title: 'Adaptive topology mutation with bounded guardrails',
      summary: 'Mutation trial keeps strict safety attestation and rollback receipt controls.',
      risk: 'low',
      evidence: [{ evidence_ref: 'eye:local_state_fallback', match: 'topology pressure under sustained load' }],
      validation: ['Apply bounded mutation dry-run', 'Verify postconditions and rollback receipt'],
      suggested_next_command: 'node systems/routing/route_execute.js --task=\"Run guarded topology mutation dry-run\" --dry-run',
      action_spec: {
        version: 1,
        objective_id: 'T1_ALPHA_OBJECTIVE',
        target: 'spawn:topology',
        verify: ['record mutation receipt'],
        success_criteria: [
          { metric: 'postconditions_ok', target: 'postconditions pass', horizon: 'next run' }
        ],
        rollback_receipt_id: 'receipt_mutation_guard_001',
        rollback: 'revert topology mutation'
      },
      meta: {
        objective_id: 'T1_ALPHA_OBJECTIVE',
        safety_attestation_id: 'attest_mutation_guard_001',
        mutation_lineage_id: 'lineage_mutation_guard_001',
        policy_root_approval_id: 'policy_root_approval_001',
        dual_approval_id: 'dual_approval_001',
        mutation_budget_cap: 2,
        mutation_ttl_hours: 48,
        mutation_quarantine_hours: 48,
        mutation_veto_window_hours: 24,
        rollback_receipt_id: 'receipt_mutation_guard_001'
      }
    }, {
      eyes: new Map(),
      directiveProfile: { available: false, active_directive_ids: [] },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    assert.strictEqual(
      mutationPassRes.proposal.meta.adaptive_mutation_guard_pass,
      true,
      'adaptive mutation proposal with required controls should pass mutation safety guard'
    );
    assert.strictEqual(
      mutationPassRes.proposal.meta.adaptive_mutation_guard_reason,
      null,
      'passing mutation guard should not emit guard reason'
    );
    assert.ok(
      String(mutationPassRes.proposal.meta.adaptive_mutation_guard_receipt_id || '').startsWith('mut_guard_'),
      'passing mutation guard should stamp deterministic execution guard receipt id'
    );
    assert.strictEqual(
      String(
        (mutationPassRes.proposal.meta.adaptive_mutation_guard_controls || {}).guard_receipt_id
        || ''
      ),
      String(mutationPassRes.proposal.meta.adaptive_mutation_guard_receipt_id || ''),
      'mutation guard controls should expose same guard receipt id'
    );

    const adaptiveNonMutationRes = script.enrichOne({
      id: 'PNON_MUTATION_ADAPTIVE',
      type: 'pain_adaptive_candidate',
      title: 'Adaptive reliability patch lane',
      summary: 'Repair collector fallback behavior after timeout burst.',
      risk: 'low',
      evidence: [{ evidence_ref: 'eye:ops_log', match: 'collector timeout burst detected' }],
      validation: ['Run deterministic regression checks and verify receipts'],
      suggested_next_command: 'node systems/ops/collector_preflight.js run --dry-run'
    }, {
      eyes: new Map(),
      directiveProfile: { available: false, active_directive_ids: [] },
      directiveObjectiveIds: ['T1_ALPHA_OBJECTIVE'],
      strategy: null,
      thresholds: {
        min_signal_quality: 35,
        min_sensory_signal_score: 35,
        min_sensory_relevance_score: 35,
        min_directive_fit: 20,
        min_actionability_score: 35,
        min_composite_eligibility: 45,
        min_eye_score_ema: 35
      },
      outcomePolicy: {}
    });
    assert.strictEqual(
      adaptiveNonMutationRes.proposal.meta.adaptive_mutation_guard_applies,
      false,
      'adaptive non-mutation proposal should not trigger mutation safety guard'
    );
    assert.ok(
      !Array.isArray((adaptiveNonMutationRes.proposal.meta.admission_preview || {}).blocked_by)
      || !(adaptiveNonMutationRes.proposal.meta.admission_preview || {}).blocked_by.includes('adaptive_mutation_missing_safety_attestation'),
      'adaptive non-mutation proposal should not be blocked by mutation attestation requirements'
    );

    assert.ok(high.meta && high.meta.admission_preview && high.meta.admission_preview.eligible === false, 'high-risk proposal should be blocked');
    assert.ok(
      Array.isArray(high.meta.admission_preview.blocked_by)
        && high.meta.admission_preview.blocked_by.includes('risk_not_allowed'),
      'high-risk proposal should include risk_not_allowed blocker'
    );

    assert.ok(Number(out.admission.eligible) >= 1, 'summary should report at least one eligible proposal');
    assert.ok(Number(out.admission.blocked) >= 1, 'summary should report blocked proposals');
    assert.ok(
      out.admission.blocked_by_reason && Number(out.admission.blocked_by_reason.risk_not_allowed || 0) >= 1,
      'summary should aggregate blocked_by_reason'
    );
    assert.ok(Number(out.objective_binding.required || 0) >= 1, 'summary should report objective binding required count');
    assert.strictEqual(Number(out.objective_binding.missing_required || 0), 0, 'summary should report zero missing required objective bindings');
    assert.strictEqual(Number(out.objective_binding.invalid_required || 0), 0, 'summary should report zero invalid required objective bindings');
    assert.ok(Number(out.objective_binding.source_meta_required || 0) >= 1, 'summary should report meta-sourced required objective bindings');
    assert.ok(Number(out.dream_alignment.proposals_with_bonus || 0) >= 1, 'dream summary should report proposals with bonus');

    banner('✅ PROPOSAL ENRICHER TESTS PASS');
  } finally {
    if (eyesConfigBefore == null) {
      if (fs.existsSync(eyesConfigPath)) fs.rmSync(eyesConfigPath, { force: true });
    } else {
      fs.writeFileSync(eyesConfigPath, eyesConfigBefore, 'utf8');
    }
    if (outcomePolicyBefore == null) delete process.env.OUTCOME_FITNESS_POLICY_PATH;
    else process.env.OUTCOME_FITNESS_POLICY_PATH = outcomePolicyBefore;
    if (dreamsDirBefore == null) delete process.env.PROPOSAL_ENRICHER_DREAMS_DIR;
    else process.env.PROPOSAL_ENRICHER_DREAMS_DIR = dreamsDirBefore;
    if (dreamBonusCapBefore == null) delete process.env.AUTONOMY_DREAM_DIRECTIVE_BONUS_CAP;
    else process.env.AUTONOMY_DREAM_DIRECTIVE_BONUS_CAP = dreamBonusCapBefore;
    if (revenueOracleBefore == null) delete process.env.AUTONOMY_REVENUE_ORACLE_REQUIRED;
    else process.env.AUTONOMY_REVENUE_ORACLE_REQUIRED = revenueOracleBefore;
    if (revenueOracleScopeBefore == null) delete process.env.AUTONOMY_REVENUE_ORACLE_SCOPE;
    else process.env.AUTONOMY_REVENUE_ORACLE_SCOPE = revenueOracleScopeBefore;
    if (revenueOracleExemptBefore == null) delete process.env.AUTONOMY_REVENUE_ORACLE_EXEMPT_TYPES;
    else process.env.AUTONOMY_REVENUE_ORACLE_EXEMPT_TYPES = revenueOracleExemptBefore;
    if (valueOracleBefore == null) delete process.env.AUTONOMY_VALUE_ORACLE_REQUIRED;
    else process.env.AUTONOMY_VALUE_ORACLE_REQUIRED = valueOracleBefore;
    if (valueOracleScopeBefore == null) delete process.env.AUTONOMY_VALUE_ORACLE_SCOPE;
    else process.env.AUTONOMY_VALUE_ORACLE_SCOPE = valueOracleScopeBefore;
    if (valueOracleExemptBefore == null) delete process.env.AUTONOMY_VALUE_ORACLE_EXEMPT_TYPES;
    else process.env.AUTONOMY_VALUE_ORACLE_EXEMPT_TYPES = valueOracleExemptBefore;
    if (valueOracleDefaultCurrenciesBefore == null) delete process.env.AUTONOMY_VALUE_ORACLE_DEFAULT_CURRENCIES;
    else process.env.AUTONOMY_VALUE_ORACLE_DEFAULT_CURRENCIES = valueOracleDefaultCurrenciesBefore;
    if (valueOracleRequirePrimaryBefore == null) delete process.env.AUTONOMY_VALUE_ORACLE_REQUIRE_PRIMARY_SIGNAL;
    else process.env.AUTONOMY_VALUE_ORACLE_REQUIRE_PRIMARY_SIGNAL = valueOracleRequirePrimaryBefore;
    if (mutationGuardRequiredBefore == null) delete process.env.AUTONOMY_MUTATION_GUARD_REQUIRED;
    else process.env.AUTONOMY_MUTATION_GUARD_REQUIRED = mutationGuardRequiredBefore;
    if (mutationBudgetMaxBefore == null) delete process.env.AUTONOMY_MUTATION_BUDGET_CAP_MAX;
    else process.env.AUTONOMY_MUTATION_BUDGET_CAP_MAX = mutationBudgetMaxBefore;
    if (mutationTtlMaxBefore == null) delete process.env.AUTONOMY_MUTATION_TTL_HOURS_MAX;
    else process.env.AUTONOMY_MUTATION_TTL_HOURS_MAX = mutationTtlMaxBefore;
    if (mutationQuarantineMinBefore == null) delete process.env.AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN;
    else process.env.AUTONOMY_MUTATION_QUARANTINE_HOURS_MIN = mutationQuarantineMinBefore;
    if (mutationVetoMinBefore == null) delete process.env.AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN;
    else process.env.AUTONOMY_MUTATION_VETO_WINDOW_HOURS_MIN = mutationVetoMinBefore;
    if (mutationKernelPolicyBefore == null) delete process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH;
    else process.env.MUTATION_SAFETY_KERNEL_POLICY_PATH = mutationKernelPolicyBefore;
    if (mutationKernelRunsBefore == null) delete process.env.MUTATION_SAFETY_RUNS_DIR;
    else process.env.MUTATION_SAFETY_RUNS_DIR = mutationKernelRunsBefore;
    if (mutationKernelStateBefore == null) delete process.env.MUTATION_SAFETY_STATE_DIR;
    else process.env.MUTATION_SAFETY_STATE_DIR = mutationKernelStateBefore;
  }
}

try {
  run();
} catch (err) {
  console.error(`❌ proposal_enricher.test.js failed: ${err.message}`);
  process.exit(1);
}
