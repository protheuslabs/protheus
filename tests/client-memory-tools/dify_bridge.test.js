#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-005.1, V6-WORKFLOW-005.2, V6-WORKFLOW-005.3,
// V6-WORKFLOW-005.4, V6-WORKFLOW-005.5, V6-WORKFLOW-005.6, V6-WORKFLOW-005.7

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

const bridge = require('../../client/runtime/systems/workflow/dify_bridge.ts');
const adapter = require('../../adapters/protocol/dify_connector_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dify-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const swarmStatePath = path.join(tmpDir, 'swarm.json');
  const tracePath = path.join(tmpDir, 'audit_trace.jsonl');
  const dashboardDir = path.join(tmpDir, 'dashboard-shell');

  const canvas = bridge.registerCanvas({
    name: 'support_canvas',
    nodes: [
      { id: 'input', kind: 'trigger' },
      { id: 'retrieve', kind: 'retriever' },
      { id: 'answer', kind: 'llm' }
    ],
    edges: [
      { from: 'input', to: 'retrieve', condition: { field: 'route', equals: 'kb' } },
      { from: 'retrieve', to: 'answer', default: true }
    ],
    drag_and_drop: true,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(canvas.canvas.canvas_id), true);
  assert.strictEqual(canvas.canvas.conditional_edge_count, 1);

  const kb = adapter.syncKnowledgeBase({
    knowledge_base_name: 'support_kb',
    profile: 'tiny-max',
    query: 'billing',
    documents: [
      { id: 'doc-1', title: 'Billing FAQ', text: 'Billing cycles and invoices', modality: 'text' },
      { id: 'doc-2', title: 'Invoice Screenshot', text: 'Billing screenshot', modality: 'image' }
    ],
    context_budget: 2048,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(kb.knowledge_base.degraded, true);
  assert.strictEqual(kb.knowledge_base.bridge_path, 'adapters/protocol/dify_connector_bridge.ts');
  assert.strictEqual(kb.knowledge_base.retrieval_hits.length >= 1, true);

  const app = adapter.registerAgentApp({
    app_name: 'support_agent',
    tools: [
      { name: 'kb_search', kind: 'retrieval' },
      { name: 'delete_customer', kind: 'destructive' }
    ],
    plugins: ['slack', 'zendesk'],
    modalities: ['text', 'image'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(app.agent_app.allowed_tools.length, 1);
  assert.strictEqual(app.agent_app.denied_tools.length, 1);

  const dashboard = bridge.publishDashboard({
    dashboard_name: 'support_dashboard',
    team: 'ops',
    environment: 'staging',
    publish_action: 'deploy',
    deploy_target: 'internal-cluster',
    dashboard_dir: dashboardDir,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(dashboard.dashboard.dashboard_id), true);
  assert.strictEqual(fs.existsSync(dashboardDir), true);

  const route = adapter.routeProvider({
    profile: 'pure',
    modality: 'image',
    prefer_local: true,
    local_models: ['qwen-vl-local'],
    providers: ['openai'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(route.provider_route.selected_route.route_kind, 'local_model');
  assert.strictEqual(route.provider_route.degraded, false);

  const flow = bridge.runConditionalFlow({
    flow_name: 'support_flow',
    profile: 'tiny-max',
    context: { route: 'kb', retry: true, handoff: 'agent' },
    branches: [
      { id: 'kb_branch', condition: { field: 'route', equals: 'kb' }, target: 'retrieve' },
      { id: 'fallback', default: true, target: 'answer' }
    ],
    loop: { max_iterations: 4, continue_while: { field: 'retry', equals: true } },
    handoffs: [
      { when: { field: 'handoff', equals: 'agent' }, target: 'support_agent' }
    ],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(flow.flow_run.selected_branch.target, 'retrieve');
  assert.strictEqual(flow.flow_run.iterations, 2);
  assert.strictEqual(flow.flow_run.degraded, true);
  assert.strictEqual(flow.flow_run.handoff_target, 'support_agent');
  const swarmRecord = JSON.parse(fs.readFileSync(swarmStatePath, 'utf8'));
  assert.strictEqual(swarmRecord.selected_target, 'retrieve');

  const trace = bridge.recordAuditTrace({
    stage: 'deploy',
    message: 'published support dashboard',
    metrics: { latency_ms: 31 },
    logs: ['deploy requested', 'deploy approved'],
    bridge_path: 'client/runtime/lib/dify_bridge.ts',
    state_path: statePath,
    history_path: historyPath,
    trace_path: tracePath,
  });
  assert.strictEqual(trace.audit_trace.bridge_path, 'client/runtime/lib/dify_bridge.ts');
  assert.strictEqual(fs.existsSync(tracePath), true);

  const status = bridge.status({ state_path: statePath, history_path: historyPath });
  assert.strictEqual(status.canvases, 1);
  assert.strictEqual(status.knowledge_bases, 1);
  assert.strictEqual(status.agent_apps, 1);
  assert.strictEqual(status.dashboards, 1);
  assert.strictEqual(status.provider_routes, 1);
  assert.strictEqual(status.flow_runs, 1);
  assert.strictEqual(status.audit_traces, 1);

  console.log(JSON.stringify({ ok: true, type: 'dify_bridge_test' }));
}

run();
