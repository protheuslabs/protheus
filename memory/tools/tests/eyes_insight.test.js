#!/usr/bin/env node
/**
 * eyes_insight.test.js
 * Truthful tests: exit 1 on failure
 */

const fs = require('fs');
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
  const tmp = path.join(__dirname, 'temp_eyes_insight');
  if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true, force: true });
  mkDir(tmp);
  process.env.SENSORY_TEST_DIR = tmp;

  const scriptPath = path.join(__dirname, '..', '..', '..', 'habits', 'scripts', 'eyes_insight.js');
  const eyes = require(scriptPath);

  const date = '2026-02-17';
  const eyesRaw = path.join(tmp, 'eyes', 'raw', `${date}.jsonl`);
  const proposalsPath = path.join(tmp, 'proposals', `${date}.json`);

  // Seed raw external_item events (with duplication by URL)
  const events = [
    {
      ts: `${date}T01:00:00Z`,
      type: 'external_item',
      item: {
        eye_id: 'hn_frontpage',
        url: 'https://moltbook.example/item/1',
        title: 'Automated income system pattern for engineering teams',
        topics: ['automation', 'income', 'systems'],
        content_preview: 'Concrete implementation notes for scalable automated systems with measurable revenue outcomes.',
        collected_at: `${date}T01:00:00Z`
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

  const eyeProps = merged.filter(p => String(p.id || '').startsWith('EYE-'));
  assert.ok(eyeProps.length >= 1, 'expected at least 1 EYE-* proposal');
  ok('generated EYE-* proposal ids');

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

  banner('✅ ALL EYES INSIGHT TESTS PASS');
}

try {
  run();
  if (process.exitCode && process.exitCode !== 0) process.exit(process.exitCode);
} catch (e) {
  fail('Unhandled test error', e);
  process.exit(1);
}
