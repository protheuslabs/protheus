#!/usr/bin/env node
/**
 * directive_enforcement.test.js - Tiered Directives Enforcement Tests
 * 
 * Tests for T0 invariant blocking and approval gating.
 */

const assert = require('assert');
const { 
  createActionEnvelope, 
  ACTION_TYPES, 
  RISK_LEVELS 
} = require('../../../lib/action_envelope.js');
const { 
  validateAction, 
  loadActiveDirectives,
  mergeConstraints
} = require('../../../lib/directive_resolver.js');
const {
  queueForApproval,
  approveAction,
  denyAction,
  loadQueue,
  saveQueue
} = require('../../../lib/approval_gate.js');
const fs = require('fs');
const path = require('path');

function runTests() {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('        TIERED DIRECTIVES ENFORCEMENT TESTS');
  console.log('═══════════════════════════════════════════════════════════');
  
  // Pre-check: Verify all ACTIVE.yaml directives exist
  console.log('\n0. Verifying ACTIVE.yaml directive files exist...');
  try {
    const DIRECTIVES_DIR = path.join(__dirname, '..', '..', '..', 'config', 'directives');
    const activeFile = path.join(DIRECTIVES_DIR, 'ACTIVE.yaml');
    
    if (!fs.existsSync(activeFile)) {
      throw new Error('ACTIVE.yaml not found');
    }
    
    // Quick check that all listed directives have files
    const activeContent = fs.readFileSync(activeFile, 'utf8');
    const activeLines = activeContent.split('\n');
    const missingFiles = [];
    
    for (const line of activeLines) {
      const idMatch = line.match(/^\s+-\s+id:\s*(.+)$/);
      if (idMatch) {
        const id = idMatch[1].trim();
        const fileName = id.endsWith('.yaml') ? id : `${id}.yaml`;
        const filePath = path.join(DIRECTIVES_DIR, fileName);
        if (!fs.existsSync(filePath)) {
          missingFiles.push(id);
        }
      }
    }
    
    if (missingFiles.length > 0) {
      throw new Error(
        `ACTIVE.yaml references missing directive files:\n` +
        missingFiles.map(id => `  - ${id}`).join('\n')
      );
    }
    
    console.log('   ✅ All directive files found');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    process.exit(1);
    return;
  }
  
  // Test 1: T0 blocks publish_publicly without approval
  console.log('\n1. Testing T0 blocks publish_publicly without approval...');
  try {
    const action = createActionEnvelope({
      type: ACTION_TYPES.PUBLISH_PUBLICLY,
      summary: 'Post to Moltbook about new strategy',
      risk: RISK_LEVELS.HIGH,
      tier: 2
    });
    
    const validation = validateAction(action);
    
    assert.strictEqual(validation.allowed, true, 'Should be allowed (not blocked)');
    assert.strictEqual(validation.requires_approval, true, 'Should require approval');
    assert.ok(validation.approval_reason.includes('publish_publicly') || 
              validation.approval_reason.includes('T0'), 
              'Should mention publishing or T0 in reason');
    
    console.log('   ✅ publish_publicly correctly requires approval');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 2: T0 blocks spend_money without approval
  console.log('\n2. Testing T0 blocks spend_money without approval...');
  try {
    const action = createActionEnvelope({
      type: ACTION_TYPES.SPEND_MONEY,
      summary: 'Purchase $500 of API credits',
      risk: RISK_LEVELS.HIGH,
      tier: 2,
      payload: { amount: 500, currency: 'USD' }
    });
    
    const validation = validateAction(action);
    
    assert.strictEqual(validation.allowed, true, 'Should be allowed (not blocked)');
    assert.strictEqual(validation.requires_approval, true, 'Should require approval');
    
    console.log('   ✅ spend_money correctly requires approval');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 3: T0 blocks change_credentials without approval
  console.log('\n3. Testing T0 blocks change_credentials without approval...');
  try {
    const action = createActionEnvelope({
      type: ACTION_TYPES.CHANGE_CREDENTIALS,
      summary: 'Rotate API key for production',
      risk: RISK_LEVELS.HIGH,
      tier: 2
    });
    
    const validation = validateAction(action);
    
    assert.strictEqual(validation.allowed, true, 'Should be allowed (not blocked)');
    assert.strictEqual(validation.requires_approval, true, 'Should require approval');
    
    console.log('   ✅ change_credentials correctly requires approval');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 4: Low-risk research passes without approval
  console.log('\n4. Testing low-risk research passes without approval...');
  try {
    const action = createActionEnvelope({
      type: ACTION_TYPES.RESEARCH,
      summary: 'Search for best practices',
      risk: RISK_LEVELS.LOW,
      tier: 2
    });
    
    const validation = validateAction(action);
    
    assert.strictEqual(validation.allowed, true, 'Should be allowed');
    assert.strictEqual(validation.requires_approval, false, 'Should NOT require approval for research');
    assert.strictEqual(validation.blocked_reason, null, 'Should not be blocked');
    
    console.log('   ✅ Low-risk research passes without approval');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 5: Tier 4 action still requires approval for publishing (T0 invariant applies)
  console.log('\n5. Testing Tier 4 action respects T0 constraints...');
  try {
    // Create an action at Tier 4 that involves publishing (T0 requires approval)
    const action = createActionEnvelope({
      type: ACTION_TYPES.PUBLISH_PUBLICLY,
      summary: 'Tier 4 publishing attempt',
      risk: RISK_LEVELS.HIGH,
      tier: 4,
      payload: {
        content: 'Some post content'
      }
    });
    
    const validation = validateAction(action);
    
    // Even at Tier 4, publishing requires approval per T0
    assert.strictEqual(validation.allowed, true, 'Should be allowed (not hard-blocked)');
    assert.strictEqual(validation.requires_approval, true, 'T0 requires publishing approval even for tier 4');
    assert.ok(validation.approval_reason.includes('T0') || 
              validation.approval_reason.includes('publishing') ||
              validation.approval_reason.includes('publish'),
              'Approval reason should mention T0 or publishing');
    
    console.log('   ✅ Tier 4 correctly respects T0 approval requirements');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 6: Approval queue workflow
  console.log('\n6. Testing approval queue workflow...');
  try {
    const action = createActionEnvelope({
      type: ACTION_TYPES.PUBLISH_PUBLICLY,
      summary: 'Test approval queue',
      risk: RISK_LEVELS.HIGH,
      tier: 2
    });
    
    // Queue for approval
    const queueResult = queueForApproval(action, 'Test approval reason');
    assert.strictEqual(queueResult.status, 'PENDING', 'Should be pending');
    
    // Check queue state
    const queue = loadQueue();
    const found = queue.pending && queue.pending.find(e => e.action_id === action.action_id);
    assert.ok(found, 'Action should be in pending queue');
    
    // Approve the action
    const approval = approveAction(action.action_id);
    assert.strictEqual(approval.success, true, 'Should approve successfully');
    
    // Check it's in approved list
    const queue2 = loadQueue();
    const approved = queue2.approved && queue2.approved.find(e => e.action_id === action.action_id);
    assert.ok(approved, 'Action should be in approved list');
    
    console.log('   ✅ Approval queue workflow works correctly');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  // Test 7: Approval queue round-trip (write -> load -> write)
  console.log('\n7. Testing approval queue round-trip...');
  try {
    // Clear queue first
    const queueFile = path.join(__dirname, '..', '..', '..', 'state', 'approvals_queue.yaml');
    fs.writeFileSync(queueFile, '# Approval Queue\npending: []\napproved: []\ndenied: []\nhistory: []', 'utf8');
    
    // Create test entry using saveQueue
    const testEntry = {
      action_id: 'act_test_roundtrip_xyz123',
      timestamp: '2026-02-16T20:00:00.000Z',
      directive_id: 'T0_invariants',
      type: 'test_action',
      summary: 'Test round-trip entry',
      reason: 'Testing round-trip',
      status: 'PENDING',
      payload_pointer: 'act_test_roundtrip_xyz123'
    };
    
    // Load, add entry, save
    const queue1 = loadQueue();
    queue1.pending.push(testEntry);
    saveQueue(queue1);
    
    // Load and verify
    const queue2 = loadQueue();
    assert.strictEqual(queue2.pending.length, 1, 'Should have 1 pending entry');
    assert.strictEqual(queue2.pending[0].action_id, 'act_test_roundtrip_xyz123', 'Action ID should match');
    assert.strictEqual(queue2.pending[0].summary, 'Test round-trip entry', 'Summary should match');
    
    // Save again
    saveQueue(queue2);
    
    // Load again and verify still good
    const queue3 = loadQueue();
    assert.strictEqual(queue3.pending.length, 1, 'Should still have 1 pending entry after round-trip');
    assert.strictEqual(queue3.pending[0].action_id, 'act_test_roundtrip_xyz123', 'Action ID should persist');
    assert.strictEqual(queue3.pending[0].summary, 'Test round-trip entry', 'Summary should persist');
    
    console.log('   ✅ Approval queue round-trip works correctly');
  } catch (err) {
    console.error('   ❌ FAILED:', err.message);
    throw err;
  }
  
  console.log('\n═══════════════════════════════════════════════════════════');
  console.log('   ✅ ALL TIERED DIRECTIVES TESTS PASS');
  console.log('═══════════════════════════════════════════════════════════');
}

// Cleanup function
function cleanup() {
  const queueFile = path.join(__dirname, '..', '..', '..', 'state', 'approvals_queue.yaml');
  if (fs.existsSync(queueFile)) {
    fs.writeFileSync(queueFile, '# Approval Queue\npending: []\napproved: []\ndenied: []\nhistory: []', 'utf8');
  }
}

// Run tests
runTests();
cleanup();