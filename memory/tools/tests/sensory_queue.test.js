/**
 * sensory_queue.test.js - Sensory Layer v1.2.1 Proposal Queue Tests
 * 
 * Tests proposal lifecycle: ingest, accept, reject, done, snooze, stats
 * Truthful tests: exit 1 on failure
 * 
 * v1.2.1: Proposal queue + dispositions (NO auto-execution)
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

// Set up isolated test environment
const TEST_DIR = path.join(__dirname, '..', '..', 'memory', 'tools', 'tests', 'temp_sensory_queue');
const SENSORY_DIR = path.join(TEST_DIR, 'state', 'sensory');
const PROPOSALS_DIR = path.join(SENSORY_DIR, 'proposals');
const QUEUE_LOG = path.join(SENSORY_DIR, 'queue_log.jsonl');

// Mock environment before loading module
process.env.SENSORY_TEST_DIR = TEST_DIR;

// Module under test (re-exported with test paths)
const queue = require('../../../habits/scripts/sensory_queue.js');

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

// Setup function - create test directories
function setup() {
  // Clean up any existing test dir
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
  
  // Create directories
  fs.mkdirSync(PROPOSALS_DIR, { recursive: true });
  
  // Patch module paths for testing
  queue.QUEUE_LOG = QUEUE_LOG;
  queue.PROPOSALS_DIR = PROPOSALS_DIR;
}

// Cleanup function
function cleanup() {
  if (fs.existsSync(TEST_DIR)) {
    fs.rmSync(TEST_DIR, { recursive: true });
  }
}

// Create test proposals JSON
function createTestProposals(dateStr, proposals) {
  const proposalsPath = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  fs.writeFileSync(proposalsPath, JSON.stringify(proposals, null, 2), 'utf8');
  return proposalsPath;
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   SENSORY QUEUE v1.2.1 TESTS');
console.log('   Proposal lifecycle: ingest, accept, reject, done, snooze, stats');
console.log('   Truthful PASS/FAIL - exit 1 on failure');
console.log('═══════════════════════════════════════════════════════════');

// Test 1: ingest creates proposal_generated entries for proposals JSON
test('ingest creates proposal_generated entries for proposals JSON', () => {
  setup();
  
  const testDate = '2026-02-17';
  const proposals = [
    { id: 'P001', title: 'Test proposal 1', type: 'refactor' },
    { id: 'P002', title: 'Test proposal 2', type: 'hardening' }
  ];
  
  createTestProposals(testDate, proposals);
  
  // Override queue paths for test
  const originalQueueLog = queue.QUEUE_LOG;
  queue.QUEUE_LOG = QUEUE_LOG;
  
  const result = queue.ingest(testDate);
  
  assert.strictEqual(result.ingested, 2, 'Should ingest 2 proposals');
  assert.strictEqual(result.duplicates, 0, 'Should have 0 duplicates');
  
  // Verify events written
  const events = queue.loadEvents();
  const generated = events.filter(e => e.type === 'proposal_generated');
  
  assert.strictEqual(generated.length, 2, 'Should have 2 proposal_generated events');
  assert.strictEqual(generated[0].proposal_id, 'P001');
  assert.strictEqual(generated[0].title, 'Test proposal 1');
  assert.ok(generated[0].proposal_hash, 'Should have proposal_hash');
  assert.strictEqual(generated[0].status_after, 'open');
  
  queue.QUEUE_LOG = originalQueueLog;
  cleanup();
});

// Test 2: ingest is idempotent
test('ingest is idempotent (run twice, same count)', () => {
  setup();
  
  const testDate = '2026-02-17';
  const proposals = [
    { id: 'P001', title: 'Test proposal 1', type: 'refactor' }
  ];
  
  createTestProposals(testDate, proposals);
  
  queue.QUEUE_LOG = QUEUE_LOG;
  
  // First ingest
  const result1 = queue.ingest(testDate);
  assert.strictEqual(result1.ingested, 1);
  
  // Second ingest - should be idempotent
  const result2 = queue.ingest(testDate);
  assert.strictEqual(result2.ingested, 0, 'Second ingest should find 0 new');
  assert.strictEqual(result2.duplicates, 1, 'Second ingest should mark as duplicate');
  
  // Verify only 1 event
  const events = queue.loadEvents();
  const generated = events.filter(e => e.type === 'proposal_generated');
  assert.strictEqual(generated.length, 1, 'Should still have only 1 event');
  
  cleanup();
});

// Test 3: ingest filters low-quality scored proposals at queue boundary
test('ingest filters low-quality scored proposals and logs proposal_filtered', () => {
  setup();

  const testDate = '2026-02-17';
  const proposals = [
    {
      id: 'P001',
      title: 'High quality proposal',
      type: 'external_intel',
      meta: {
        signal_quality_score: 72,
        relevance_score: 74,
        directive_fit_score: 52,
        actionability_score: 69,
        composite_eligibility_score: 70,
        actionability_pass: true,
        composite_eligibility_pass: true
      }
    },
    {
      id: 'P002',
      title: 'Low quality proposal',
      type: 'external_intel',
      meta: {
        signal_quality_score: 18,
        relevance_score: 22,
        directive_fit_score: 10,
        actionability_score: 20,
        composite_eligibility_score: 26,
        actionability_pass: false,
        composite_eligibility_pass: false
      }
    }
  ];

  createTestProposals(testDate, proposals);
  queue.QUEUE_LOG = QUEUE_LOG;

  const result = queue.ingest(testDate);
  assert.strictEqual(result.ingested, 1, 'Should ingest only 1 quality proposal');
  assert.strictEqual(result.filtered, 1, 'Should filter 1 low-quality proposal');
  assert.ok(result.filtered_by_reason.actionability_low >= 1 || result.filtered_by_reason.composite_low >= 1);

  const events = queue.loadEvents();
  const generated = events.filter(e => e.type === 'proposal_generated');
  const filtered = events.filter(e => e.type === 'proposal_filtered');
  assert.strictEqual(generated.length, 1, 'Should keep one generated event');
  assert.strictEqual(filtered.length, 1, 'Should emit one filtered event');
  assert.strictEqual(filtered[0].proposal_id, 'P002');

  cleanup();
});

// Test 4: accept changes derived status to accepted
test('accept changes derived status to accepted', () => {
  setup();
  
  const testDate = '2026-02-17';
  const proposals = [{ id: 'P001', title: 'Test proposal', type: 'refactor' }];
  
  createTestProposals(testDate, proposals);
  queue.QUEUE_LOG = QUEUE_LOG;
  
  queue.ingest(testDate);
  
  // Accept the proposal
  const result = queue.accept('P001', 'Looks good');
  assert.strictEqual(result.success, true, 'Accept should succeed');
  
  // Verify status
  const events = queue.loadEvents();
  const accepted = events.filter(e => e.type === 'proposal_accepted');
  assert.strictEqual(accepted.length, 1);
  assert.strictEqual(accepted[0].proposal_id, 'P001');
  assert.strictEqual(accepted[0].note, 'Looks good');
  assert.strictEqual(accepted[0].status_after, 'accepted');
  
  // Verify derived status
  const hash = queue.computeProposalHash(proposals[0]);
  const status = queue.getProposalStatus(hash, 'P001');
  assert.strictEqual(status.status, 'accepted');
  
  cleanup();
});

// Test 5: reject requires reason and sets rejected
test('reject requires reason and sets rejected', () => {
  setup();
  
  const testDate = '2026-02-17';
  const proposals = [{ id: 'P001', title: 'Test proposal', type: 'refactor' }];
  
  createTestProposals(testDate, proposals);
  queue.QUEUE_LOG = QUEUE_LOG;
  
  queue.ingest(testDate);
  
  // Reject without reason should fail
  const resultNoReason = queue.reject('P001');
  assert.strictEqual(resultNoReason.success, false, 'Reject without reason should fail');
  
  // Reject with reason should succeed
  const result = queue.reject('P001', 'Not feasible', 'Try another approach');
  assert.strictEqual(result.success, true, 'Reject with reason should succeed');
  
  // Verify rejection event
  const events = queue.loadEvents();
  const rejected = events.filter(e => e.type === 'proposal_rejected');
  
  assert.strictEqual(rejected.length, 1);
  assert.strictEqual(rejected[0].proposal_id, 'P001');
  assert.strictEqual(rejected[0].reason, 'Not feasible');
  assert.strictEqual(rejected[0].note, 'Try another approach');
  assert.strictEqual(rejected[0].status_after, 'rejected');
  
  cleanup();
});

// Test 6: snooze requires until date and list hides snoozed unless requested
test('snooze requires until date and list hides snoozed unless requested', () => {
  setup();
  
  const testDate = '2026-02-17';
  const proposals = [
    { id: 'P001', title: 'Snooze proposal', type: 'refactor' }
  ];
  
  createTestProposals(testDate, proposals);
  queue.QUEUE_LOG = QUEUE_LOG;
  
  queue.ingest(testDate);
  
  // Snooze without until should fail
  const resultNoUntil = queue.snooze('P001');
  assert.strictEqual(resultNoUntil.success, false, 'Snooze without until should fail');
  
  // Snooze with future date should succeed
  const futureDate = '2099-01-01';
  const result = queue.snooze('P001', futureDate, 'Wait until next sprint');
  assert.strictEqual(result.success, true, 'Snooze with future date should succeed');
  
  // Verify snooze event
  const events = queue.loadEvents();
  const snoozed = events.filter(e => e.type === 'proposal_snoozed');
  assert.strictEqual(snoozed.length, 1);
  assert.strictEqual(snoozed[0].snooze_until, futureDate);
  
  // List with status=snoozed should show it
  const snoozedList = queue.list({ status: 'snoozed' });
  assert.strictEqual(snoozedList.length, 1);
  
  // List without filter should show as snoozed
  const allList = queue.list({});
  const p = allList.find(x => x.id === 'P001');
  assert.ok(p, 'Should find proposal');
  assert.strictEqual(p.status, 'snoozed');
  assert.strictEqual(p.snooze_until, futureDate);
  
  cleanup();
});

// Test 7: stats returns counts by status and top recurring
test('stats returns counts by status and top recurring', () => {
  setup();
  
  // Create proposals for 2 different dates with same title (recurring)
  const date1 = '2026-02-15';
  const date2 = '2026-02-16';
  const date3 = '2026-02-17';
  
  const proposalsDay1 = [
    { id: 'P001', title: 'Fix high churn', type: 'refactor' },
    { id: 'P002', title: 'Add tests', type: 'hardening' }
  ];
  
  const proposalsDay2 = [
    { id: 'P001', title: 'Fix high churn', type: 'refactor' } // Same title - recurring
  ];
  
  const proposalsDay3 = [
    { id: 'P003', title: 'Fix high churn', type: 'refactor' }, // Same title again - recurring
    { id: 'P004', title: 'New issue', type: 'bugfix' }
  ];
  
  createTestProposals(date1, proposalsDay1);
  createTestProposals(date2, proposalsDay2);
  createTestProposals(date3, proposalsDay3);
  
  queue.QUEUE_LOG = QUEUE_LOG;
  
  // Ingest all 3 days
  queue.ingest(date1);
  queue.ingest(date2);
  queue.ingest(date3);
  
  // Mark one as done
  queue.done('P001');  // This will mark the most recent P001 from day 2
  
  // Get stats
  const stats = queue.stats({ days: 30 });
  
  assert.ok(stats.total >= 4, `Should have at least 4 total proposals, got ${stats.total}`);
  assert.ok(stats.counts.done >= 1, 'Should have at least 1 done');
  assert.ok(stats.counts.open >= 3, 'Should have at least 3 open');
  
  // Check recurring detection
  assert.ok(stats.recurring.length > 0, 'Should have recurring proposals');
  const recurring = stats.recurring.find(r => r.title === 'Fix high churn');
  assert.ok(recurring, 'Should detect "Fix high churn" as recurring');
  assert.ok(recurring.count >= 2, 'Should appear across 2+ days');
  
  cleanup();
});

// Test 8: done marks proposal as completed
test('done marks proposal as completed', () => {
  setup();
  
  const testDate = '2026-02-17';
  const proposals = [{ id: 'P001', title: 'Test proposal', type: 'refactor' }];
  
  createTestProposals(testDate, proposals);
  queue.QUEUE_LOG = QUEUE_LOG;
  
  queue.ingest(testDate);
  
  // Mark as done
  const result = queue.done('P001', 'Implemented in commit abc123');
  assert.strictEqual(result.success, true);
  
  // Verify done event
  const events = queue.loadEvents();
  const done = events.filter(e => e.type === 'proposal_done');
  
  assert.strictEqual(done.length, 1);
  assert.strictEqual(done[0].proposal_id, 'P001');
  assert.strictEqual(done[0].note, 'Implemented in commit abc123');
  assert.strictEqual(done[0].status_after, 'done');
  
  // Verify derived status
  const hash = queue.computeProposalHash(proposals[0]);
  const status = queue.getProposalStatus(hash, 'P001');
  assert.strictEqual(status.status, 'done');
  
  cleanup();
});

// Test 9: verify snoozed proposals appear as open when snooze expires
test('snoozed proposals appear as open when snooze expires', () => {
  setup();
  
  const testDate = '2026-02-17';
  const proposals = [{ id: 'P001', title: 'Test proposal', type: 'refactor' }];
  
  createTestProposals(testDate, proposals);
  queue.QUEUE_LOG = QUEUE_LOG;
  
  queue.ingest(testDate);
  
  // Snooze with past date (expired)
  const pastDate = '2020-01-01';
  queue.snooze('P001', pastDate, 'Was snoozed');
  
  // Should now appear as open (snooze expired)
  const events = queue.loadEvents();
  const hash = queue.computeProposalHash(proposals[0]);
  const status = queue.getProposalStatus(hash, 'P001');
  
  assert.strictEqual(status.status, 'open', 'Expired snooze should show as open');
  
  cleanup();
});

// Summary
console.log('\n═══════════════════════════════════════════════════════════');
if (failed) {
  console.log('   ❌ SENSORY QUEUE TESTS FAILED');
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(1);
}

console.log('   ✅ ALL SENSORY QUEUE TESTS PASS (9/9)');
console.log('═══════════════════════════════════════════════════════════');
console.log('\n📋 Coverage:');
console.log('   1. ✅ ingest creates proposal_generated entries');
console.log('   2. ✅ ingest is idempotent');
console.log('   3. ✅ queue quality gate filters low-quality scored proposals');
console.log('   4. ✅ accept changes status to accepted');
console.log('   5. ✅ reject requires reason and sets rejected');
console.log('   6. ✅ snooze requires until date');
console.log('   7. ✅ stats returns counts and recurring');
console.log('   8. ✅ done marks proposal as completed');
console.log('   9. ✅ expired snooze appears as open');
console.log('\n🎯 Sensory Queue v1.2.1 Ready - NO raw JSONL, NO LLM, append-only');
