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
  const eyesConfigBefore = fs.existsSync(eyesConfigPath) ? fs.readFileSync(eyesConfigPath, 'utf8') : null;
  const outcomePolicyBefore = process.env.OUTCOME_FITNESS_POLICY_PATH;
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
    process.env.OUTCOME_FITNESS_POLICY_PATH = path.join(tmpRoot, 'no_outcome_policy.json');

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
    assert.ok(low.meta && Number.isFinite(Number(low.meta.actionability_score)), 'low proposal has actionability score');
    assert.ok(low.meta && Number.isFinite(Number(low.meta.composite_eligibility_score)), 'low proposal has composite score');
    assert.ok(Array.isArray(low.meta.directive_fit_positive) && low.meta.directive_fit_positive.length >= 1, 'normalizer should produce directive-fit positives');
    assert.ok(low.meta && low.meta.admission_preview && low.meta.admission_preview.eligible === true, 'low-risk OPEN proposal should be eligible');
    assert.ok(missing.meta && missing.meta.admission_preview && missing.meta.admission_preview.eligible === false, 'missing success criteria should be blocked');
    assert.ok(
      Array.isArray(missing.meta.admission_preview.blocked_by)
        && missing.meta.admission_preview.blocked_by.includes('success_criteria_missing'),
      'missing success criteria should include success_criteria_missing blocker'
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

    banner('✅ PROPOSAL ENRICHER TESTS PASS');
  } finally {
    if (eyesConfigBefore == null) {
      if (fs.existsSync(eyesConfigPath)) fs.rmSync(eyesConfigPath, { force: true });
    } else {
      fs.writeFileSync(eyesConfigPath, eyesConfigBefore, 'utf8');
    }
    if (outcomePolicyBefore == null) delete process.env.OUTCOME_FITNESS_POLICY_PATH;
    else process.env.OUTCOME_FITNESS_POLICY_PATH = outcomePolicyBefore;
  }
}

try {
  run();
} catch (err) {
  console.error(`❌ proposal_enricher.test.js failed: ${err.message}`);
  process.exit(1);
}
