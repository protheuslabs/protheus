#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const bridge = require('../../client/runtime/systems/autonomy/swarm_sessions_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-sessions-bridge-'));
  const state = path.join(tmpDir, 'state.json');

  // Test 2 parity: recursive decomposition with explicit parent-child lineage.
  const root = bridge.sessionsSpawn({
    task: 'root recursive task',
    state_path: state,
  });
  const level1 = bridge.sessionsSpawn({
    task: 'spawn level1 child',
    session_id: root.session_id,
    state_path: state,
  });
  const level2 = bridge.sessionsSpawn({
    task: 'spawn level2 child',
    session_id: level1.session_id,
    state_path: state,
  });
  const level1State = bridge.sessionsState({
    session_id: level1.session_id,
    state_path: state,
  });
  assert(
    Array.isArray(level1.tool_access) && level1.tool_access.includes('sessions_send'),
    'expected spawned sessions to advertise sessions_send in tool_access'
  );
  assert(
    level1.tool_manifest && Array.isArray(level1.tool_manifest.tool_access),
    'expected spawned sessions to expose an authoritative tool manifest'
  );
  assert.strictEqual(level2.payload.payload.parent_id, level1.session_id);
  assert(
    Array.isArray(level1State.payload.session.children)
      && level1State.payload.session.children.includes(level2.session_id),
    'expected level1 to track spawned child lineage'
  );

  // Test 3 parity: byzantine mode in test context.
  const byzantine = bridge.sessionsSpawn({
    task: 'calculate 2+2',
    testMode: 'byzantine',
    faultPattern: JSON.stringify({ type: 'corruption', value: '2+2=5' }),
    state_path: state,
  });
  const byzantineState = bridge.sessionsState({
    session_id: byzantine.session_id,
    state_path: state,
  });
  assert.strictEqual(byzantineState.payload.session.byzantine, true);
  assert.strictEqual(
    String(byzantineState.payload.session.corruption_type || '').length > 0,
    true,
    'expected corruption_type to be present in byzantine mode'
  );

  // Test 5 parity: persistent sessions survive tick/check-in cycles.
  const persistent = bridge.sessionsSpawn({
    task: 'monitor and report',
    sessionType: 'persistent',
    ttlMinutes: 5,
    checkpointInterval: 1,
    state_path: state,
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
  const persistentState = bridge.sessionsState({
    session_id: persistent.session_id,
    timeline: 1,
    state_path: state,
  });
  assert.strictEqual(Boolean(persistentState.payload.session.persistent), true);
  assert.strictEqual(
    persistentState.payload.session.status === 'persistent_running'
      || persistentState.payload.session.status === 'running',
    true,
    'expected persistent session to remain active after tick'
  );

  // Test 6 parity: direct inter-agent messaging with delivery + ack.
  const commParent = bridge.sessionsSpawn({
    task: 'communication parent',
    state_path: state,
  });
  const sender = bridge.sessionsSpawn({
    task: 'sender',
    session_id: commParent.session_id,
    state_path: state,
  });
  const receiver = bridge.sessionsSpawn({
    task: 'receiver',
    session_id: commParent.session_id,
    state_path: state,
  });
  const send = bridge.sessionsSend({
    sender: sender.session_id,
    session_id: receiver.session_id,
    message: 'process:[1,2,3]',
    delivery: 'at_least_once',
    state_path: state,
  });
  assert.strictEqual(Boolean(send.message_id), true);
  const inbox = bridge.sessionsReceive({
    session_id: receiver.session_id,
    limit: 8,
    state_path: state,
  });
  assert(inbox.message_count >= 1, 'expected receiver inbox to contain messages');
  const message = inbox.messages.find((row) => row.message_id === send.message_id);
  assert(message, 'expected sent message to be receivable by target session');
  const ack = bridge.sessionsAck({
    session_id: receiver.session_id,
    message_id: send.message_id,
    state_path: state,
  });
  assert.strictEqual(ack.payload.acknowledged, true);

  // Hierarchical budget reservation + settlement.
  const budgetParent = bridge.sessionsSpawn({
    task: 'budget-parent',
    max_tokens: 500,
    on_budget_exhausted: 'fail',
    state_path: state,
  });
  const budgetChild = bridge.sessionsSpawn({
    task: 'budget-child',
    session_id: budgetParent.session_id,
    max_tokens: 200,
    on_budget_exhausted: 'fail',
    state_path: state,
  });
  const budgetChildState = bridge.sessionsState({
    session_id: budgetChild.session_id,
    state_path: state,
  });
  const budgetParentState = bridge.sessionsState({
    session_id: budgetParent.session_id,
    state_path: state,
  });
  assert.strictEqual(
    budgetChildState.payload.session.budget_parent_session_id,
    budgetParent.session_id,
    'expected child session to record hierarchical budget parent'
  );
  assert(
    Number(budgetParentState.payload.session.budget.settled_child_tokens || 0) > 0,
    'expected parent budget to settle child token usage'
  );

  // Test 7 parity: service discovery + result query.
  bridge.sessionsSpawn({
    task: 'calc-fast',
    role: 'calculator',
    agentLabel: 'swarm-test-7-calc-fast',
    auto_publish_results: 1,
    state_path: state,
  });
  bridge.sessionsSpawn({
    task: 'calc-thorough',
    role: 'calculator',
    agentLabel: 'swarm-test-7-calc-thorough',
    auto_publish_results: 1,
    state_path: state,
  });
  const query = bridge.sessionsQuery({
    agentRole: 'calculator',
    agentLabel: 'swarm-test-7-calc-*',
    wait: 1,
    min_count: 2,
    timeout_sec: 10,
    state_path: state,
  });
  assert(query.result_count >= 2, 'expected calculator result registry entries');
  assert(
    query.discovery
      && Array.isArray(query.discovery.instances)
      && query.discovery.instances.length >= 2,
    'expected role discovery to return active calculator instances'
  );

  // Test 4 parity: hard token budget enforcement, not advisory only.
  let hardBudgetRejected = false;
  try {
    bridge.sessionsSpawn({
      task: 'summarize largest programming language communities',
      max_tokens: 80,
      on_budget_exhausted: 'fail',
      state_path: state,
    });
  } catch (err) {
    hardBudgetRejected = /token_budget_exceeded/.test(String(err && err.message));
  }
  assert.strictEqual(hardBudgetRejected, true, 'expected hard budget fail-close rejection');

  // Dead-letter expiry + retry recovery.
  const dlqParent = bridge.sessionsSpawn({ task: 'dlq-parent', state_path: state });
  const dlqSender = bridge.sessionsSpawn({
    task: 'dlq-sender',
    session_id: dlqParent.session_id,
    state_path: state,
  });
  const dlqReceiver = bridge.sessionsSpawn({
    task: 'dlq-receiver',
    session_id: dlqParent.session_id,
    state_path: state,
  });
  bridge.sessionsSend({
    sender: dlqSender.session_id,
    session_id: dlqReceiver.session_id,
    message: 'expire-me',
    delivery: 'at_least_once',
    ttl_ms: 1,
    state_path: state,
  });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  bridge.sessionsState({ session_id: dlqReceiver.session_id, state_path: state });
  const deadLetters = bridge.sessionsDeadLetters({
    session_id: dlqReceiver.session_id,
    state_path: state,
  });
  assert(deadLetters.payload.dead_letter_count >= 1, 'expected a dead-lettered message');
  const deadLetterMessageId = deadLetters.payload.dead_letters[0].message.message_id;
  const retried = bridge.sessionsRetryDeadLetter({
    message_id: deadLetterMessageId,
    state_path: state,
  });
  const recoveredInbox = bridge.sessionsReceive({
    session_id: dlqReceiver.session_id,
    limit: 8,
    state_path: state,
  });
  assert(
    recoveredInbox.messages.some((row) => row.message_id === retried.payload.retry_result.message_id),
    'expected retried dead-letter message to return to receiver inbox'
  );

  // Persistent resume / restart recovery command.
  const resumed = bridge.sessionsResume({
    session_id: persistent.session_id,
    state_path: state,
  });
  assert.strictEqual(resumed.payload.status, 'persistent_running');
}

run();
console.log(
  JSON.stringify({
    ok: true,
    type: 'swarm_sessions_bridge_test',
  })
);
