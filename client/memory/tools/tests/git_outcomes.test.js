/**
 * git_outcomes.test.js — Tests for git_outcomes.js
 * Truthful PASS/FAIL - exit 1 on failure
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const mod = require('../../../habits/scripts/git_outcomes.js');

let failed = false;

function test(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    console.error(`   ❌ ${name}: ${err.message}`);
    failed = true;
  }
}

const TEST_DIR = path.join(__dirname, 'temp_git_outcomes');

function setup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(path.join(TEST_DIR, 'state', 'queue', 'decisions'), { recursive: true });
}

function cleanup() {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   GIT OUTCOMES v1.0 TESTS');
console.log('   Deterministic parsing + idempotent append');
console.log('   Truthful PASS/FAIL - exit 1 on failure');
console.log('═══════════════════════════════════════════════════════════');

test('extractTokens finds eye/proposal/outcome tokens', () => {
  const t = mod.extractTokens('feat: ship it eye:moltbook_feed proposal:EYE-abc outcome:shipped');
  assert.deepStrictEqual(t.eyes, ['moltbook_feed']);
  assert.deepStrictEqual(t.proposals, ['EYE-abc']);
  assert.strictEqual(t.outcome, 'shipped');
});

test('parseGitLogLines parses sha and subject', () => {
  const raw = [
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\tfeat: x eye:x_trends',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\tchore: y'
  ].join('\n');
  const commits = mod.parseGitLogLines(raw);
  assert.strictEqual(commits.length, 2);
  assert.strictEqual(commits[0].sha.length, 40);
  assert.ok(commits[0].subject.includes('eye:x_trends'));
});

test('buildOutcomeEventsFromCommits requires eye:<id>', () => {
  const commits = [
    { sha: 'a'.repeat(40), subject: 'chore: no attribution' },
    { sha: 'b'.repeat(40), subject: 'feat: ship eye:moltbook_feed' }
  ];
  const ev = mod.buildOutcomeEventsFromCommits({ commits, defaultOutcome: 'shipped', dateStr: '2026-02-17' });
  assert.strictEqual(ev.length, 1);
  assert.strictEqual(ev[0].evidence_ref, 'eye:moltbook_feed');
  assert.strictEqual(ev[0].proposal_id, 'GIT-bbbbbbbb');
});

test('buildOutcomeEventsFromCommits multiplies eye x proposal tokens', () => {
  const commits = [
    { sha: 'c'.repeat(40), subject: 'feat: eye:x_trends eye:moltbook_feed proposal:EYE-1 proposal:EYE-2 outcome:no_change' }
  ];
  const ev = mod.buildOutcomeEventsFromCommits({ commits, defaultOutcome: 'shipped', dateStr: '2026-02-17' });
  // 2 eyes * 2 proposals = 4
  assert.strictEqual(ev.length, 4);
  assert.ok(ev.every(e => e.outcome === 'no_change'));
  assert.ok(ev.some(e => e.evidence_ref === 'eye:x_trends' && e.proposal_id === 'EYE-1'));
});

test('stableKeyForOutcomeEvent ignores ts and is stable', () => {
  const e1 = { proposal_id: 'P1', outcome: 'shipped', evidence_ref: 'eye:x', evidence_commit: 'abc', ts: 't1' };
  const e2 = { proposal_id: 'P1', outcome: 'shipped', evidence_ref: 'eye:x', evidence_commit: 'abc', ts: 't2' };
  assert.strictEqual(mod.stableKeyForOutcomeEvent(e1), mod.stableKeyForOutcomeEvent(e2));
});

test('appendOutcomesIdempotent appends once, then skips duplicates', () => {
  setup();
  const date = '2026-02-17';
  const repo = TEST_DIR;
  const decisionsPath = path.join(repo, 'state', 'queue', 'decisions', `${date}.jsonl`);

  const events = [
    {
      ts: new Date().toISOString(),
      type: 'outcome',
      date,
      proposal_id: 'EYE-1',
      outcome: 'shipped',
      evidence_ref: 'eye:moltbook_feed',
      evidence_commit: 'a'.repeat(40),
      evidence_subject: 'feat: eye:moltbook_feed proposal:EYE-1'
    }
  ];

  const r1 = mod.appendOutcomesIdempotent({ repo, dateStr: date, newEvents: events, dryRun: false });
  assert.strictEqual(r1.added, 1);
  assert.ok(fs.existsSync(decisionsPath));

  const r2 = mod.appendOutcomesIdempotent({ repo, dateStr: date, newEvents: events, dryRun: false });
  assert.strictEqual(r2.added, 0);
  assert.strictEqual(r2.skipped, 1);

  cleanup();
});

// Summary
console.log('\n═══════════════════════════════════════════════════════════');
if (failed) {
  console.log('   ❌ GIT OUTCOMES TESTS FAILED');
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(1);
}
console.log('   ✅ ALL GIT OUTCOMES TESTS PASS');
console.log('═══════════════════════════════════════════════════════════');
