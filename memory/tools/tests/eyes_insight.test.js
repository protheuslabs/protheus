#!/usr/bin/env node
/**
 * eyes_insight.test.js
 * Truthful tests: exit 1 on failure
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

function banner(title) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(title);
  console.log('═══════════════════════════════════════════════════════════');
}

function ok(msg) { console.log(`✅ ${msg}`); }
function fail(msg, e) {
  console.error(`❌ ${msg}: ${e && e.message ? e.message : e}`);
  process.exitCode = 1;
}

function mkDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function writeJsonl(filePath, objs) {
  mkDir(path.dirname(filePath));
  const lines = objs.map(o => JSON.stringify(o)).join('\n') + '\n';
  fs.writeFileSync(filePath, lines, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function run() {
  banner('EYES INSIGHT TESTS Eyes → Proposals deterministic merge Truthful PASS/FAIL - exit 1 on failure');

  // isolated sensory dir
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'eyes-insight-test-'));
  process.env.SENSORY_TEST_DIR = tmp;
  process.env.SENSORY_MIN_DIRECTIVE_FIT = '0';
  process.env.SENSORY_MIN_ACTIONABILITY_SCORE = '40';

  const scriptPath = path.join(__dirname, '..', '..', '..', 'habits', 'scripts', 'eyes_insight.js');
  const eyes = require(scriptPath);

  const date = '2026-02-17';
  const eyesRaw = path.join(tmp, 'eyes', 'raw', `${date}.jsonl`);
  const proposalsPath = path.join(tmp, 'proposals', `${date}.json`);
  const crossSignalPath = path.join(tmp, 'cross_signal', 'hypotheses', `${date}.json`);

  // Seed raw external_item events (with duplication by URL)
  const events = [
    {
      ts: `${date}T01:00:02Z`,
      type: 'external_item',
      item: {
        eye_id: 'hn_frontpage',
        url: 'https://moltbook.example/item/1',
        title: 'Build automated income system for engineering teams',
        topics: ['automation', 'income', 'systems'],
        content_preview: 'Implement a measurable revenue workflow: automate weekly lead intake, score opportunities, and ship changes with metrics.',
        collected_at: `${date}T01:00:02Z`
      }
    },
    {
      ts: `${date}T01:00:01Z`,
      type: 'external_item',
      item: {
        eye_id: 'hn_frontpage',
        url: 'https://moltbook.example/item/1',
        title: 'Duplicate link, worse title',
        topics: [],
        content_preview: 'short',
        collected_at: `${date}T01:00:01Z`
      }
    },
    {
      ts: `${date}T01:00:02Z`,
      type: 'external_item',
      item: {
        source: 'x_trends',
        url: 'https://x.example/item/9',
        title: '[STUB] noisy',
        topics: ['llm'],
        content_preview: 'okish content preview that is long enough to score',
        collected_at: `${date}T01:00:02Z`
      }
    }
  ];
  writeJsonl(eyesRaw, events);
  fs.mkdirSync(path.dirname(crossSignalPath), { recursive: true });
  fs.writeFileSync(crossSignalPath, JSON.stringify({
    ts: `${date}T02:00:00Z`,
    type: 'cross_signal_hypotheses',
    date,
    hypotheses: [
      {
        id: 'HYP-test-convergence',
        type: 'convergence',
        topic: 'automation',
        summary: 'Automation topic converging across 3 eyes',
        confidence: 88,
        support_eyes: 3,
        support_events: 11,
        trend_direction: 'up'
      }
    ]
  }, null, 2), 'utf8');

  // Seed an existing proposals file (array)
  mkDir(path.dirname(proposalsPath));
  fs.writeFileSync(
    proposalsPath,
    JSON.stringify([{ id: 'P001', type: 'refactor', title: 'Existing proposal' }], null, 2),
    'utf8'
  );

  // Merge
  const res = eyes.mergeIntoDailyProposals(date, 5);
  assert.strictEqual(res.ok, true);
  ok('mergeIntoDailyProposals returns ok');

  const merged = readJson(proposalsPath);
  assert.ok(Array.isArray(merged), 'proposals output must be an array');
  ok('proposals output is an array');

  // Should include original + <= 2 new (deduped by url)
  assert.ok(merged.length >= 2, 'expected at least 2 proposals after merge');
  ok('merge adds proposals');

  const eyeProps = merged.filter(p => /^(EYE|PRP)-/.test(String(p.id || '')));
  assert.ok(eyeProps.length >= 1, 'expected at least 1 eye-derived proposal id (EYE-* or PRP-*)');
  ok('generated eye-derived proposal ids');

  const crossProps = merged.filter(p => /^CSG-/.test(String(p.id || '')));
  assert.ok(crossProps.length >= 1, 'expected at least 1 cross-signal proposal id (CSG-*)');
  assert.strictEqual(String(crossProps[0].type), 'cross_signal_opportunity');
  assert.ok(
    Array.isArray(crossProps[0].evidence)
      && String((crossProps[0].evidence[0] || {}).evidence_ref || '').startsWith('cross_signal:'),
    'cross-signal proposal should include evidence_ref cross_signal:<id>'
  );
  ok('cross-signal hypotheses generate cross_signal_opportunity proposals');

  // Verify evidence_ref contains eye:<id>
  const one = eyeProps[0];
  assert.ok(Array.isArray(one.evidence), 'expected evidence array');
  const ref = one.evidence[0] && one.evidence[0].evidence_ref;
  assert.ok(typeof ref === 'string' && ref.startsWith('eye:'), 'evidence_ref must start with eye:');
  ok('evidence_ref includes eye:<id>');

  assert.ok(
    one.meta && Number.isFinite(Number(one.meta.signal_quality_score)),
    'meta.signal_quality_score must be numeric'
  );
  assert.ok(
    one.meta && ['high', 'medium', 'low'].includes(String(one.meta.signal_quality_tier)),
    'meta.signal_quality_tier must be high|medium|low'
  );
  ok('signal quality score+tier are written to proposal meta');

  assert.ok(
    one.meta && Number.isFinite(Number(one.meta.relevance_score)),
    'meta.relevance_score must be numeric'
  );
  assert.ok(
    one.meta && Number.isFinite(Number(one.meta.directive_fit_score)),
    'meta.directive_fit_score must be numeric'
  );
  ok('relevance + directive fit are written to proposal meta');

  assert.ok(
    one.meta && Number.isFinite(Number(one.meta.actionability_score)),
    'meta.actionability_score must be numeric'
  );
  assert.ok(
    one.meta && typeof one.meta.actionability_pass === 'boolean',
    'meta.actionability_pass must be boolean'
  );
  ok('actionability score+pass are written to proposal meta');

  assert.ok(
    typeof one.suggested_next_command === 'string'
      && one.suggested_next_command.startsWith('node systems/routing/route_execute.js --task='),
    'suggested_next_command should be route_execute dry-run command'
  );
  ok('suggested_next_command is actionable (not browser-open only)');

  assert.ok(one.action_spec && typeof one.action_spec === 'object', 'action_spec should exist');
  assert.ok(typeof one.action_spec.next_command === 'string' && one.action_spec.next_command.length > 0);
  assert.ok(Array.isArray(one.action_spec.verify) && one.action_spec.verify.length >= 1);
  ok('action_spec contract is generated for eye proposals');

  assert.ok(typeof one.meta.directive_objective_id === 'string' && /^T[0-9]_/.test(one.meta.directive_objective_id), 'meta.directive_objective_id should be bound');
  assert.strictEqual(one.meta.objective_id, one.meta.directive_objective_id, 'meta.objective_id should mirror directive_objective_id');
  assert.strictEqual(one.action_spec.objective_id, one.meta.directive_objective_id, 'action_spec.objective_id should match meta.directive_objective_id');
  assert.ok(one.suggested_next_command.includes(`--id=${one.meta.directive_objective_id}`), 'suggested_next_command should carry --id=<objective_id>');
  ok('eye proposal objective binding is present in meta/action_spec/command');

  assert.ok(crossProps[0].action_spec && typeof crossProps[0].action_spec === 'object');
  assert.ok(typeof crossProps[0].action_spec.next_command === 'string' && crossProps[0].action_spec.next_command.length > 0);
  ok('action_spec contract is generated for cross-signal proposals');

  assert.ok(typeof crossProps[0].meta.directive_objective_id === 'string' && /^T[0-9]_/.test(crossProps[0].meta.directive_objective_id), 'cross-signal meta.directive_objective_id should be bound');
  assert.strictEqual(crossProps[0].action_spec.objective_id, crossProps[0].meta.directive_objective_id, 'cross-signal action_spec.objective_id should match meta.directive_objective_id');
  assert.ok(crossProps[0].suggested_next_command.includes(`--id=${crossProps[0].meta.directive_objective_id}`), 'cross-signal suggested_next_command should carry --id=<objective_id>');
  ok('cross-signal proposal objective binding is present in meta/action_spec/command');

  const allowedCrossSignalMetrics = new Set([
    'execution_success',
    'postconditions_ok',
    'queue_outcome_logged',
    'artifact_count',
    'entries_count',
    'revenue_actions_count',
    'token_usage',
    'duration_ms'
  ]);
  const crossCriteria = Array.isArray(crossProps[0].action_spec && crossProps[0].action_spec.success_criteria)
    ? crossProps[0].action_spec.success_criteria
    : [];
  assert.ok(crossCriteria.length >= 2, 'cross-signal success_criteria should include measurable contract rows');
  for (const row of crossCriteria) {
    const metric = String(row && row.metric || '').toLowerCase().replace(/[\s-]+/g, '_').trim();
    assert.ok(allowedCrossSignalMetrics.has(metric), `cross-signal metric must be contract-supported: ${metric || 'missing'}`);
  }
  ok('cross-signal success criteria only use contract-supported metrics');

  // Verify deterministic dedupe by url worked (only one proposal per URL)
  const urls = new Set();
  for (const p of eyeProps) {
    const u = p && p.meta && p.meta.url;
    if (u) {
      assert.ok(!urls.has(u), 'duplicate url proposal should not exist');
      urls.add(u);
    }
  }
  ok('dedupe by URL works');

  // Verify scoreItem returns number 0..100
  const s = eyes.scoreItem(events[0].item);
  assert.ok(Number.isFinite(s) && s >= 0 && s <= 100);
  ok('scoreItem returns 0..100');

  // Wrapper proposals file format should load too
  const date2 = '2026-02-16';
  const eyesRaw2 = path.join(tmp, 'eyes', 'raw', `${date2}.jsonl`);
  const proposalsPath2 = path.join(tmp, 'proposals', `${date2}.json`);
  writeJsonl(eyesRaw2, [events[0]]);
  fs.writeFileSync(
    proposalsPath2,
    JSON.stringify({ proposals: [{ id: 'P100', type: 'chore', title: 'Wrapped proposal' }] }, null, 2),
    'utf8'
  );
  eyes.mergeIntoDailyProposals(date2, 3);
  const merged2 = readJson(proposalsPath2);
  assert.ok(Array.isArray(merged2), 'wrapper should be rewritten as array output');
  ok('wrapper input is tolerated and output normalized to array');

  fs.rmSync(tmp, { recursive: true, force: true });

  banner('✅ ALL EYES INSIGHT TESTS PASS');
}

try {
  run();
  if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
} catch (e) {
  fail('Unhandled test error', e);
  process.exit(1);
}
