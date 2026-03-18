#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-015.1, V6-WORKFLOW-015.2, V6-WORKFLOW-015.3,
// V6-WORKFLOW-015.4, V6-WORKFLOW-015.5, V6-WORKFLOW-015.6, V6-WORKFLOW-015.7,
// V6-WORKFLOW-015.8, V6-WORKFLOW-015.9, V6-WORKFLOW-015.10

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const ts = require('typescript');

if (!require.extensions['.ts']) {
  require.extensions['.ts'] = function compileTs(module, filename) {
    const source = fs.readFileSync(filename, 'utf8');
    const transpiled = ts.transpileModule(source, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        moduleResolution: ts.ModuleResolutionKind.NodeJs,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true
      },
      fileName: filename,
      reportDiagnostics: false
    }).outputText;
    module._compile(transpiled, filename);
  };
}

const bridge = require('../../client/runtime/systems/workflow/pydantic_ai_bridge.ts');
const protocol = require('../../adapters/protocol/pydantic_ai_protocol_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pydantic-ai-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const swarmStatePath = path.join(tmpDir, 'swarm-state.json');
  const approvalQueuePath = path.join(tmpDir, 'approvals.json');
  const outputDir = `client/runtime/local/state/pydantic-shell-${process.pid}`;

  const agent = bridge.registerAgent({
    name: 'typed-incident-agent',
    input_required: ['question', 'context'],
    output_required: ['summary', 'confidence'],
    dependencies: ['memory_store'],
    dependency_schema: { memory_store: 'required' },
    output_schema: { summary: 'string', confidence: 'number' },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(agent.agent.agent_id), true);

  const validation = bridge.validateOutput({
    agent_id: agent.agent.agent_id,
    data: { summary: 'incident contained' },
    attempt: 1,
    max_retries: 1,
    profile: 'pure',
    nested_depth: 5,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(validation.validation.status, 'retry');
  assert.strictEqual(validation.validation.degraded, true);

  const toolContext = protocol.registerToolContext({
    name: 'risky-lookup',
    kind: 'custom',
    entrypoint: 'invoke',
    requires_approval: true,
    required_args: ['ticket_id'],
    required_dependencies: ['memory_store'],
    argument_schema: { ticket_id: 'string' },
    dependency_context: { memory_store: 'incident-memory' },
    supported_profiles: ['rich'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(toolContext.tool_context.tool_id), true);

  const pendingApproval = bridge.approvalCheckpoint({
    tool_id: toolContext.tool_context.tool_id,
    summary: 'approve risky lookup',
    reason: 'needs human check',
    risk: 'high',
    state_path: statePath,
    history_path: historyPath,
    approval_queue_path: approvalQueuePath,
  });
  assert.strictEqual(pendingApproval.approval.status, 'pending');

  const approved = bridge.approvalCheckpoint({
    action_id: pendingApproval.approval.action_id,
    decision: 'approve',
    tool_id: toolContext.tool_context.tool_id,
    state_path: statePath,
    history_path: historyPath,
    approval_queue_path: approvalQueuePath,
  });
  assert.strictEqual(approved.approval.status, 'approved');

  const invocation = protocol.invokeToolContext({
    tool_id: toolContext.tool_context.tool_id,
    profile: 'rich',
    approval_action_id: pendingApproval.approval.action_id,
    args: { ticket_id: 'INC-42' },
    dependency_keys: ['memory_store'],
    state_path: statePath,
    history_path: historyPath,
    approval_queue_path: approvalQueuePath,
  });
  assert.strictEqual(invocation.tool_invocation.mode, 'custom_function');

  const runtimeBridge = bridge.registerRuntimeBridge({
    name: 'python-gateway',
    language: 'python',
    provider: 'google',
    model_family: 'gemini',
    models: ['gemini-2.0-flash'],
    supported_profiles: ['rich', 'pure'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(runtimeBridge.runtime_bridge.bridge_id), true);

  const route = bridge.routeModel({
    bridge_id: runtimeBridge.runtime_bridge.bridge_id,
    language: 'python',
    provider: 'google',
    model: 'gemini-2.0-flash',
    profile: 'pure',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(route.route.degraded, true);

  const protocolEvent = protocol.bridgeProtocol({
    protocol_kind: 'a2a',
    agent_id: agent.agent.agent_id,
    message: 'investigate incident',
    sender_label: 'typed-dispatch',
    sender_task: 'triage',
    profile: 'rich',
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(Boolean(protocolEvent.protocol_event.delivery.remote_session_id), true);

  const durableRun = bridge.durableRun({
    name: 'durable-typed-agent',
    instruction: 'produce typed incident response',
    runtime_bridge_id: runtimeBridge.runtime_bridge.bridge_id,
    language: 'python',
    provider: 'google',
    model: 'gemini-2.0-flash',
    profile: 'rich',
    retry_count: 1,
    steps: [{ id: 'plan' }, { id: 'respond' }],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(Boolean(durableRun.durable_run.session_id), true);

  const resumed = bridge.durableRun({
    name: 'durable-typed-agent',
    instruction: 'resume typed incident response',
    runtime_bridge_id: runtimeBridge.runtime_bridge.bridge_id,
    language: 'python',
    provider: 'google',
    model: 'gemini-2.0-flash',
    profile: 'rich',
    retry_count: 2,
    resume_session_id: durableRun.durable_run.session_id,
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(resumed.durable_run.resumed, true);

  const logfire = bridge.recordLogfire({
    trace_id: 'pydantic-trace',
    event_name: 'validated-response',
    message: 'typed response emitted',
    tokens: 321,
    cost_usd: 0.02,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(logfire.logfire_event.tokens, 321);

  const graph = bridge.executeGraph({
    name: 'typed-graph',
    profile: 'pure',
    nodes: [
      { id: 'planner', kind: 'planner', budget: 96 },
      { id: 'responder', kind: 'worker', budget: 96 }
    ],
    edges: [{ from: 'planner', to: 'responder' }],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(graph.graph_run.node_count, 2);

  const stream = protocol.streamModel({
    bridge_id: runtimeBridge.runtime_bridge.bridge_id,
    language: 'python',
    provider: 'google',
    model: 'gemini-2.0-flash',
    profile: 'pure',
    structured_fields: ['summary', 'confidence'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(stream.stream.chunk_count >= 2, true);
  assert.strictEqual(stream.stream.route.degraded, true);

  const evaluation = bridge.recordEval({
    session_id: durableRun.durable_run.session_id,
    profile: 'pure',
    score: 0.91,
    metrics: { typed: 1, validated: 1 },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(evaluation.evaluation.score, 0.91);

  const intake = bridge.assimilateIntake({
    shell_name: 'pydantic-ai-shell',
    shell_path: 'client/runtime/systems/workflow/pydantic_ai_bridge.ts',
    target: 'local',
    artifact_path: outputDir,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(intake.deployment.authority_delegate, 'core://pydantic-ai-bridge');

  const status = bridge.status({ state_path: statePath, history_path: historyPath });
  assert.strictEqual(status.typed_agents, 1);
  assert.strictEqual(status.structured_validations >= 1, true);
  assert.strictEqual(status.tool_contexts, 1);
  assert.strictEqual(status.protocol_events, 1);
  assert.strictEqual(status.durable_runs, 2);
  assert.strictEqual(status.approval_records >= 1, true);
  assert.strictEqual(status.logfire_events, 1);
  assert.strictEqual(status.graph_runs, 1);
  assert.strictEqual(status.model_streams, 1);
  assert.strictEqual(status.evaluations, 1);

  console.log(JSON.stringify({ ok: true, type: 'pydantic_ai_bridge_test' }));
}

run();
