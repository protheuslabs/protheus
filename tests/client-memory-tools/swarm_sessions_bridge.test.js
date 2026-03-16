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
}

run();
console.log(
  JSON.stringify({
    ok: true,
    type: 'swarm_sessions_bridge_test',
  })
);
