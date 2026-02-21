#!/usr/bin/env node

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EYES_INSIGHT_PATH = path.join(ROOT, 'habits', 'scripts', 'eyes_insight.js');
const SENSORY_QUEUE_PATH = path.join(ROOT, 'habits', 'scripts', 'sensory_queue.js');

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

  clearModule(EYES_INSIGHT_PATH);
  clearModule(SENSORY_QUEUE_PATH);

  const eyesInsight = require(EYES_INSIGHT_PATH);
  const sensoryQueue = require(SENSORY_QUEUE_PATH);

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
