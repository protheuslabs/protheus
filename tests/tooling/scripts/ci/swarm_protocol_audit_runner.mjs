#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..', '..', '..');
const OPS = path.join(ROOT, 'client', 'runtime', 'systems', 'ops', 'run_protheus_ops.js');
const bridge = require(path.join(ROOT, 'client', 'runtime', 'systems', 'autonomy', 'swarm_sessions_bridge.ts'));

const OUT_JSON = path.join(ROOT, 'local', 'state', 'ops', 'swarm_runtime', 'audit', 'latest.json');

function nowIso() {
  return new Date().toISOString();
}

function receiptHash(payload) {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

function parseLastJson(stdout) {
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line.startsWith('{')) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function runOps(args) {
  const run = spawnSync(process.execPath, [OPS].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const status = Number.isFinite(Number(run.status)) ? Number(run.status) : 1;
  return {
    status,
    stdout: String(run.stdout || ''),
    stderr: String(run.stderr || ''),
    payload: parseLastJson(run.stdout),
  };
}

function pass(name, details = {}) {
  return { name, ok: true, details };
}

function fail(name, reason, details = {}) {
  return { name, ok: false, reason, details };
}

function runConcurrencyTest(statePath) {
  const out = runOps([
    'swarm-runtime',
    'test',
    'concurrency',
    '--agents=10',
    '--metrics=detailed',
    `--state-path=${statePath}`,
  ]);
  if (out.status !== 0 || !out.payload || out.payload.ok !== true) {
    return fail('test_1_concurrency_storm', 'runtime_failed', {
      status: out.status,
      stderr: out.stderr,
      stdout: out.stdout,
    });
  }
  const metrics = out.payload.metrics || {};
  const queueWait = Number(metrics.queue_wait_avg_ms || 0);
  const execution = Number(metrics.execution_avg_ms || 0);
  return pass('test_1_concurrency_storm', {
    agents: out.payload.agents || null,
    queue_wait_avg_ms: queueWait,
    execution_avg_ms: execution,
  });
}

function runRecursiveTest(statePath) {
  try {
    const root = bridge.sessionsSpawn({ task: 'root', state_path: statePath });
    const level1 = bridge.sessionsSpawn({
      task: 'level1',
      session_id: root.session_id,
      state_path: statePath,
    });
    const level2 = bridge.sessionsSpawn({
      task: 'level2',
      session_id: level1.session_id,
      state_path: statePath,
    });
    const state = bridge.sessionsState({ session_id: level1.session_id, state_path: statePath });
    const linked = Array.isArray(state.payload.session.children)
      && state.payload.session.children.includes(level2.session_id);
    if (!linked) {
      return fail('test_2_recursive_decomposition', 'lineage_not_linked', {
        level1: level1.session_id,
        level2: level2.session_id,
      });
    }
    return pass('test_2_recursive_decomposition', {
      root: root.session_id,
      level1: level1.session_id,
      level2: level2.session_id,
      parent_of_level2: level2.payload.payload.parent_id,
    });
  } catch (err) {
    return fail('test_2_recursive_decomposition', 'bridge_exception', {
      error: String(err && err.message ? err.message : err),
    });
  }
}

function runByzantineTest(statePath) {
  try {
    const spawned = bridge.sessionsSpawn({
      task: 'calculate 2+2',
      testMode: 'byzantine',
      faultPattern: JSON.stringify({ type: 'corruption', value: '2+2=5' }),
      state_path: statePath,
    });
    const state = bridge.sessionsState({ session_id: spawned.session_id, state_path: statePath });
    const byzantine = state.payload?.session?.byzantine === true;
    if (!byzantine) {
      return fail('test_3_byzantine_fault_tolerance', 'byzantine_flag_missing', {
        session_id: spawned.session_id,
      });
    }
    return pass('test_3_byzantine_fault_tolerance', {
      session_id: spawned.session_id,
      corruption_type: state.payload?.session?.corruption_type || null,
    });
  } catch (err) {
    return fail('test_3_byzantine_fault_tolerance', 'bridge_exception', {
      error: String(err && err.message ? err.message : err),
    });
  }
}

function runBudgetTest(statePath) {
  let failClosed = false;
  let failMessage = '';
  try {
    bridge.sessionsSpawn({
      task: 'summarize largest programming language communities',
      max_tokens: 80,
      on_budget_exhausted: 'fail',
      state_path: statePath,
    });
  } catch (err) {
    failMessage = String(err && err.message ? err.message : err);
    failClosed = /token_budget_exceeded/.test(failMessage);
  }
  if (!failClosed) {
    return fail('test_4_token_budget_starvation', 'budget_not_fail_closed', {
      message: failMessage,
    });
  }
  const warn = bridge.sessionsSpawn({
    task: 'summarize largest programming language communities',
    max_tokens: 80,
    on_budget_exhausted: 'warn',
    state_path: statePath,
  });
  return pass('test_4_token_budget_starvation', {
    fail_close: true,
    warn_mode_session: warn.session_id,
  });
}

function runPersistentTest(statePath) {
  try {
    const persistent = bridge.sessionsSpawn({
      task: 'monitor',
      sessionType: 'persistent',
      ttlMinutes: 5,
      checkpointInterval: 1,
      state_path: statePath,
    });
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1300);
    const state = bridge.sessionsState({
      session_id: persistent.session_id,
      timeline: 1,
      state_path: statePath,
    });
    const runtime = state.payload?.session?.persistent || null;
    if (!runtime) {
      return fail('test_5_long_running_saturation', 'persistent_runtime_missing', {
        session_id: persistent.session_id,
      });
    }
    return pass('test_5_long_running_saturation', {
      session_id: persistent.session_id,
      check_in_count: runtime.check_in_count || 0,
      status: state.payload?.session?.status || null,
    });
  } catch (err) {
    return fail('test_5_long_running_saturation', 'bridge_exception', {
      error: String(err && err.message ? err.message : err),
    });
  }
}

function runCommunicationTest(statePath) {
  try {
    const parent = bridge.sessionsSpawn({ task: 'comm-parent', state_path: statePath });
    const sender = bridge.sessionsSpawn({
      task: 'sender',
      session_id: parent.session_id,
      state_path: statePath,
    });
    const receiver = bridge.sessionsSpawn({
      task: 'receiver',
      session_id: parent.session_id,
      state_path: statePath,
    });
    if (!Array.isArray(sender.tool_access) || !sender.tool_access.includes('sessions_send')) {
      return fail('test_6_inter_agent_communication', 'sessions_send_not_advertised', {
        sender: sender.session_id,
        tool_access: sender.tool_access || null,
      });
    }
    const sent = bridge.sessionsSend({
      sender: sender.session_id,
      session_id: receiver.session_id,
      message: 'payload:[1,2,3]',
      delivery: 'at_least_once',
      state_path: statePath,
    });
    const inbox = bridge.sessionsReceive({
      session_id: receiver.session_id,
      limit: 8,
      state_path: statePath,
    });
    const message = (inbox.messages || []).find((row) => row.message_id === sent.message_id);
    if (!message) {
      return fail('test_6_inter_agent_communication', 'message_missing_in_inbox', {
        sender: sender.session_id,
        receiver: receiver.session_id,
        message_id: sent.message_id,
      });
    }
    const ack = bridge.sessionsAck({
      session_id: receiver.session_id,
      message_id: sent.message_id,
      state_path: statePath,
    });
    return pass('test_6_inter_agent_communication', {
      sender: sender.session_id,
      receiver: receiver.session_id,
      message_id: sent.message_id,
      acknowledged: ack.payload?.acknowledged === true,
    });
  } catch (err) {
    return fail('test_6_inter_agent_communication', 'bridge_exception', {
      error: String(err && err.message ? err.message : err),
    });
  }
}

function runHeterogeneousTest(statePath) {
  try {
    bridge.sessionsSpawn({
      task: 'calc-fast',
      role: 'calculator',
      agentLabel: 'swarm-test-7-calc-fast',
      auto_publish_results: 1,
      state_path: statePath,
    });
    bridge.sessionsSpawn({
      task: 'calc-thorough',
      role: 'calculator',
      agentLabel: 'swarm-test-7-calc-thorough',
      auto_publish_results: 1,
      state_path: statePath,
    });
    const query = bridge.sessionsQuery({
      agentRole: 'calculator',
      agentLabel: 'swarm-test-7-calc-*',
      wait: 1,
      min_count: 2,
      timeout_sec: 10,
      state_path: statePath,
    });
    const instanceCount = query.discovery?.instances?.length || 0;
    if ((query.result_count || 0) < 2 || instanceCount < 2) {
      return fail('test_7_heterogeneous_swarm', 'registry_or_discovery_incomplete', {
        result_count: query.result_count || 0,
        instance_count: instanceCount,
      });
    }
    return pass('test_7_heterogeneous_swarm', {
      result_count: query.result_count,
      instance_count: instanceCount,
    });
  } catch (err) {
    return fail('test_7_heterogeneous_swarm', 'bridge_exception', {
      error: String(err && err.message ? err.message : err),
    });
  }
}

function ensureOutDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-protocol-audit-'));
  const statePath = path.join(tmpDir, 'swarm-runtime-state.json');

  const tests = [
    runConcurrencyTest(statePath),
    runRecursiveTest(statePath),
    runByzantineTest(statePath),
    runBudgetTest(statePath),
    runPersistentTest(statePath),
    runCommunicationTest(statePath),
    runHeterogeneousTest(statePath),
  ];

  const passed = tests.filter((row) => row.ok).length;
  const failed = tests.length - passed;
  const payload = {
    ok: failed === 0,
    type: 'swarm_protocol_audit',
    generated_at: nowIso(),
    state_path: statePath,
    summary: {
      total: tests.length,
      passed,
      failed,
    },
    tests,
  };
  payload.receipt_hash = receiptHash(payload);

  ensureOutDir(OUT_JSON);
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(payload));
  process.exit(payload.ok ? 0 : 1);
}

main();
