#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-010.1, V6-WORKFLOW-010.2, V6-WORKFLOW-010.3,
// V6-WORKFLOW-010.4, V6-WORKFLOW-010.5, V6-WORKFLOW-010.6, V6-WORKFLOW-010.7,
// V6-WORKFLOW-010.8, V6-WORKFLOW-010.9

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

const bridge = require('../../client/runtime/systems/workflow/google_adk_bridge.ts');
const polyglot = require('../../adapters/polyglot/google_adk_runtime_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'google-adk-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const swarmStatePath = path.join(tmpDir, 'swarm-state.json');
  const approvalQueuePath = path.join(tmpDir, 'approvals.yaml');

  const a2a = bridge.registerA2aAgent({
    name: 'remote-researcher',
    language: 'python',
    transport: 'a2a',
    endpoint: 'grpc://remote-researcher',
    bridge_path: 'adapters/polyglot/google_adk_runtime_bridge.ts',
    supported_profiles: ['rich', 'pure'],
    capabilities: ['handoff', 'research'],
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(Boolean(a2a.agent.agent_id), true);

  const runtimeBridge = polyglot.registerBridge({
    name: 'python-gateway',
    language: 'python',
    provider: 'google',
    model_family: 'gemini',
    models: ['gemini-2.0-flash'],
    supported_profiles: ['rich', 'pure'],
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(Boolean(runtimeBridge.runtime_bridge.bridge_id), true);

  const route = polyglot.routeModel({
    bridge_id: runtimeBridge.runtime_bridge.bridge_id,
    language: 'python',
    provider: 'google',
    model: 'gemini-2.0-flash',
    profile: 'pure',
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(route.route.reason_code, 'polyglot_runtime_requires_rich_profile');

  const sent = bridge.sendA2aMessage({
    agent_id: a2a.agent.agent_id,
    message: 'collect evidence for incident triage',
    profile: 'pure',
    sender_label: 'dispatch',
    sender_task: 'incident-triage',
    handoff_reason: 'delegate_incident_research',
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath
  });
  assert.strictEqual(Boolean(sent.a2a_message.remote_session_id), true);

  const llmAgent = bridge.runLlmAgent({
    name: 'incident-coordinator',
    instruction: 'triage the incident and plan the response',
    mode: 'parallel',
    runtime_bridge_id: runtimeBridge.runtime_bridge.bridge_id,
    language: 'python',
    provider: 'google',
    model: 'gemini-2.0-flash',
    profile: 'rich',
    budget: 640,
    steps: [
      { id: 'research', budget: 192 },
      { id: 'draft', budget: 192 }
    ],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath
  });
  assert.strictEqual(llmAgent.agent.child_sessions.length, 2);

  const tool = bridge.registerToolManifest({
    name: 'approval-tool',
    kind: 'custom',
    bridge_path: 'adapters/polyglot/google_adk_runtime_bridge.ts',
    entrypoint: 'invoke',
    requires_approval: true,
    supported_profiles: ['rich'],
    state_path: statePath,
    history_path: historyPath
  });

  const pendingApproval = bridge.approvalCheckpoint({
    tool_id: tool.tool.tool_id,
    summary: 'approve risky tool',
    reason: 'requires operator ack',
    risk: 'high',
    state_path: statePath,
    history_path: historyPath,
    approval_queue_path: approvalQueuePath
  });
  assert.strictEqual(pendingApproval.approval.status, 'pending');

  const approved = bridge.approvalCheckpoint({
    action_id: pendingApproval.approval.action_id,
    decision: 'approve',
    tool_id: tool.tool.tool_id,
    state_path: statePath,
    history_path: historyPath,
    approval_queue_path: approvalQueuePath
  });
  assert.strictEqual(approved.approval.status, 'approved');

  const invocation = bridge.invokeToolManifest({
    tool_id: tool.tool.tool_id,
    profile: 'rich',
    approval_action_id: pendingApproval.approval.action_id,
    args: { op: 'status' },
    state_path: statePath,
    history_path: historyPath,
    approval_queue_path: approvalQueuePath
  });
  assert.strictEqual(invocation.invocation.mode, 'custom_function');

  const hierarchy = bridge.coordinateHierarchy({
    name: 'triage-hierarchy',
    profile: 'pure',
    coordinator_label: 'root-coordinator',
    agents: [
      { label: 'researcher', role: 'retriever', reason: 'collect_evidence', context: { topic: 'incident' } },
      { label: 'responder', role: 'synthesizer', reason: 'draft_response', context: { topic: 'response' } }
    ],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath
  });
  assert.strictEqual(hierarchy.hierarchy.degraded, true);
  assert.strictEqual(hierarchy.hierarchy.agents.length, 1);

  const rewind = bridge.rewindSession({
    session_id: llmAgent.agent.primary_session_id,
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath
  });
  assert.strictEqual(rewind.restored.session_id, llmAgent.agent.primary_session_id);

  const evaluation = bridge.recordEvaluation({
    session_id: llmAgent.agent.primary_session_id,
    profile: 'pure',
    score: 0.82,
    metrics: { success: 1, handoffs: 2 },
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(evaluation.evaluation.score, 0.82);

  const sandbox = bridge.sandboxExecute({
    language: 'python',
    profile: 'pure',
    cloud: 'gcp',
    bridge_path: 'adapters/polyglot/google_adk_runtime_bridge.ts',
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(sandbox.sandbox.reason_code, 'cloud_integration_requires_rich_profile');

  const deployment = bridge.deployShell({
    shell_name: 'google-adk-ui',
    shell_path: 'client/runtime/systems/workflow/google_adk_bridge.ts',
    target: 'local',
    artifact_path: 'apps/google-adk-ui',
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(deployment.deployment.authority_delegate, 'core://google-adk-bridge');

  const status = bridge.status({
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(status.a2a_agents, 1);
  assert.strictEqual(status.llm_agents, 1);
  assert.strictEqual(status.tool_manifests, 1);
  assert.strictEqual(status.hierarchies, 1);
  assert.strictEqual(status.approval_records, 1);
  assert.strictEqual(status.session_snapshots, 1);
  assert.strictEqual(status.evaluations, 1);
  assert.strictEqual(status.sandbox_runs, 1);
  assert.strictEqual(status.deployments, 1);
  assert.strictEqual(status.runtime_bridges, 1);

  console.log(JSON.stringify({ ok: true, type: 'google_adk_bridge_test' }));
}

run();
