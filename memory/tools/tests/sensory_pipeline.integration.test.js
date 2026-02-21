#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EYES_INSIGHT_PATH = path.join(ROOT, 'habits', 'scripts', 'eyes_insight.js');
const SENSORY_QUEUE_PATH = path.join(ROOT, 'habits', 'scripts', 'sensory_queue.js');
const PROPOSAL_ENRICHER_PATH = path.join(ROOT, 'systems', 'autonomy', 'proposal_enricher.js');

function writeJsonl(filePath, records) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = records.map((r) => JSON.stringify(r)).join('\n') + '\n';
  fs.writeFileSync(filePath, body, 'utf8');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonl(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function clearModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
}

async function main() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   SENSORY PIPELINE INTEGRATION TEST');
  console.log('═══════════════════════════════════════════════════════════');

  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sensory-pipeline-'));
  const sensoryDir = path.join(tmpRoot, 'state', 'sensory');
  const date = '2026-02-19';

  process.env.SENSORY_TEST_DIR = sensoryDir;
  process.env.SENSORY_QUEUE_TEST_DIR = tmpRoot;
  process.env.SENSORY_MIN_DIRECTIVE_FIT = '0';
  process.env.SENSORY_MIN_ACTIONABILITY_SCORE = '40';
  process.env.PROPOSAL_ENRICHER_EYES_REGISTRY = path.join(sensoryDir, 'eyes', 'registry.json');
  process.env.AUTONOMY_ALLOWED_RISKS = 'low,medium';
  process.env.AUTONOMY_MIN_SENSORY_SIGNAL_SCORE = '35';
  process.env.AUTONOMY_MIN_SENSORY_RELEVANCE_SCORE = '35';
  process.env.AUTONOMY_MIN_DIRECTIVE_FIT = '20';
  process.env.AUTONOMY_MIN_ACTIONABILITY_SCORE = '35';
  process.env.AUTONOMY_MIN_COMPOSITE_ELIGIBILITY = '45';

  clearModule(EYES_INSIGHT_PATH);
  clearModule(SENSORY_QUEUE_PATH);
  clearModule(PROPOSAL_ENRICHER_PATH);

  const eyesInsight = require(EYES_INSIGHT_PATH);
  const sensoryQueue = require(SENSORY_QUEUE_PATH);
  const proposalEnricher = require(PROPOSAL_ENRICHER_PATH);

  fs.mkdirSync(path.dirname(process.env.PROPOSAL_ENRICHER_EYES_REGISTRY), { recursive: true });
  fs.writeFileSync(process.env.PROPOSAL_ENRICHER_EYES_REGISTRY, JSON.stringify({
    version: '1.0',
    eyes: [
      {
        id: 'hn_frontpage',
        status: 'active',
        parser_type: 'hn_rss',
        score_ema: 78
      }
    ]
  }, null, 2), 'utf8');

  const rawPath = path.join(sensoryDir, 'eyes', 'raw', `${date}.jsonl`);
  writeJsonl(rawPath, [
    {
      ts: `${date}T01:00:00Z`,
      type: 'external_item',
      item: {
        eye_id: 'hn_frontpage',
        url: 'https://example.com/opportunity/1',
        title: 'Build an automated revenue monitor for model routing spend',
        topics: ['automation', 'revenue', 'routing'],
        content_preview: 'Implement a weekly workflow to measure cost, optimize routing, and ship high-leverage improvements.',
        collected_at: `${date}T01:00:00Z`
      }
    }
  ]);

  const merge = eyesInsight.mergeIntoDailyProposals(date, 5);
  assert.strictEqual(merge.ok, true);
  assert.ok(merge.added_count >= 1, `expected at least 1 added proposal, got ${merge.added_count}`);

  const proposalsPath = path.join(sensoryDir, 'proposals', `${date}.json`);
  const proposals = readJson(proposalsPath);
  assert.ok(Array.isArray(proposals));
  assert.ok(proposals.length >= 1);
  const first = proposals[0];
  assert.ok(/^(EYE|PRP)-/.test(String(first.id || '')));
  assert.strictEqual(first.type, 'external_intel');
  assert.ok(first.meta && first.meta.actionability_pass === true);
  assert.ok(first.action_spec && typeof first.action_spec === 'object');
  assert.ok(typeof first.action_spec.next_command === 'string' && first.action_spec.next_command.length > 0);
  assert.ok(typeof first.meta.directive_objective_id === 'string' && /^T[0-9]_/.test(first.meta.directive_objective_id), 'eyes_insight should bind directive objective');

  const enrich = proposalEnricher.runForDate(date, false);
  assert.strictEqual(enrich.ok, true, 'proposal_enricher should run successfully');
  assert.ok(enrich.objective_binding && typeof enrich.objective_binding === 'object', 'proposal_enricher should report objective binding summary');
  assert.strictEqual(Number(enrich.objective_binding.missing_required || 0), 0, 'objective binding summary missing_required should be zero');
  assert.strictEqual(Number(enrich.objective_binding.invalid_required || 0), 0, 'objective binding summary invalid_required should be zero');
  assert.ok(Number(enrich.objective_binding.source_meta_required || 0) >= 1, 'objective binding summary should report meta-sourced required bindings');

  const enriched = readJson(proposalsPath);
  const enrichedFirst = enriched.find((p) => String(p.id) === String(first.id));
  assert.ok(enrichedFirst, 'enriched proposal should exist');
  assert.ok(enrichedFirst.meta && enrichedFirst.meta.objective_binding_required === true, 'objective binding should be required');
  assert.ok(enrichedFirst.meta && enrichedFirst.meta.objective_binding_valid === true, 'objective binding should be valid');
  assert.strictEqual(String(enrichedFirst.meta.objective_binding_source || ''), 'meta.objective_id', 'objective binding should come from source meta, not fallback');
  const blocked = Array.isArray(enrichedFirst.meta && enrichedFirst.meta.admission_preview && enrichedFirst.meta.admission_preview.blocked_by)
    ? enrichedFirst.meta.admission_preview.blocked_by
    : [];
  assert.ok(!blocked.includes('objective_binding_missing'), 'admission should not fail objective binding missing');
  assert.ok(!blocked.includes('objective_binding_invalid'), 'admission should not fail objective binding invalid');

  const ingested = sensoryQueue.ingest(date);
  assert.ok(Number(ingested.ingested || 0) >= 1, `expected queue ingest >=1, got ${JSON.stringify(ingested)}`);

  const queueLog = path.join(tmpRoot, 'state', 'sensory', 'queue_log.jsonl');
  const events = readJsonl(queueLog);
  const generated = events.filter((e) => e.type === 'proposal_generated');
  assert.ok(generated.length >= 1);
  assert.strictEqual(generated[0].proposal_id, first.id);

  fs.rmSync(tmpRoot, { recursive: true, force: true });

  console.log('   ✅ sensory raw -> proposals -> queue ingest path is healthy');
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
