#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-009.1, V6-WORKFLOW-009.2, V6-WORKFLOW-009.3,
// V6-WORKFLOW-009.4, V6-WORKFLOW-009.5, V6-WORKFLOW-009.6, V6-WORKFLOW-009.7

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

const bridge = require('../../client/runtime/systems/workflow/llamaindex_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llamaindex-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const swarmStatePath = path.join(tmpDir, 'swarm-state.json');

  const index = bridge.registerIndex({
    name: 'llamaindex-ops',
    retrieval_modes: ['hybrid', 'vector', 'graph'],
    query_engine: 'router',
    documents: [
      { text: 'llamaindex hybrid retrieval composes vector search with graph context', metadata: { kind: 'graph', source: 'guide-1' } },
      { text: 'agent workflows route tool calls through the authoritative swarm runtime', metadata: { kind: 'text', source: 'guide-2' } },
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(index.index.index_id), true);

  const query = bridge.query({
    index_id: index.index.index_id,
    query: 'hybrid retrieval graph context',
    mode: 'hybrid',
    top_k: 2,
    profile: 'rich',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(query.results.length >= 1, true);

  const workflow = bridge.runAgentWorkflow({
    name: 'llamaindex-agent-team',
    query: 'triage a support incident',
    budget: 480,
    agent_label: 'llamaindex-coordinator',
    tools: [
      {
        name: 'mcp_gateway',
        bridge_path: 'adapters/cognition/skills/mcp/mcp_gateway.ts',
        entrypoint: 'invoke',
        args: { op: 'status' }
      }
    ],
    handoffs: [
      { label: 'researcher', role: 'retriever', task: 'retrieve support evidence', budget: 180, reason: 'collect_evidence', importance: 0.82 },
      { label: 'responder', role: 'synthesizer', task: 'draft final answer', budget: 180, reason: 'respond', importance: 0.76 },
    ],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(Boolean(workflow.workflow.primary_session_id), true);
  assert.strictEqual(workflow.workflow.handoffs.length, 2);

  const ingestion = bridge.ingestMultimodal({
    loader_name: 'llamaindex-pdf-loader',
    modality: 'image',
    profile: 'pure',
    bridge_path: 'adapters/cognition/skills/mcp/mcp_gateway.ts',
    assets: ['guide.pdf', 'diagram.png'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(ingestion.ingestion.degraded, true);

  const evaluation = bridge.recordMemoryEval({
    memory_key: 'incident-memory',
    entries: [
      { id: 'mem-1', text: 'Hybrid retrieval should surface graph-backed context.' },
      { id: 'mem-2', text: 'Swarm handoffs must be receipted.' }
    ],
    expected_hits: ['mem-1', 'mem-2'],
    actual_hits: ['mem-1'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(evaluation.evaluation.recall, 0.5);

  const conditional = bridge.runConditionalWorkflow({
    name: 'llamaindex-router',
    context: { intent: 'support' },
    steps: [
      { id: 'start', condition: { field: 'intent', equals: 'support' }, next: 'support-lane', else: 'generic-lane', checkpoint_key: 'cp-start' },
      { id: 'support-lane', checkpoint_key: 'cp-support' },
      { id: 'generic-lane', checkpoint_key: 'cp-generic' }
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(conditional.workflow.visited[0].matched, true);

  const trace = bridge.emitTrace({
    trace_id: 'llx-trace-1',
    stage: 'retrieval',
    message: 'llamaindex query trace recorded',
    data: { top_k: 2 },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(trace.trace.trace_id, 'llx-trace-1');

  const connector = bridge.registerConnector({
    name: 'llamaindex-mcp',
    bridge_path: 'adapters/cognition/skills/mcp/mcp_gateway.ts',
    capabilities: ['load', 'query'],
    supported_profiles: ['rich', 'pure'],
    documents: [
      { text: 'mcp connectors expose governed loader manifests', metadata: { source: 'mcp-docs' } },
      { text: 'connector query receipts fail closed when unsupported', metadata: { source: 'policy' } }
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  const connectorQuery = bridge.connectorQuery({
    connector_id: connector.connector.connector_id,
    query: 'governed loader manifests',
    profile: 'rich',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(connectorQuery.results.length >= 1, true);

  const status = bridge.status({
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(status.indexes, 1);
  assert.strictEqual(status.agent_workflows, 1);
  assert.strictEqual(status.ingestions, 1);
  assert.strictEqual(status.evaluations, 1);
  assert.strictEqual(status.conditional_workflows, 1);
  assert.strictEqual(status.traces, 1);
  assert.strictEqual(status.connectors, 1);

  console.log(JSON.stringify({ ok: true, type: 'llamaindex_bridge_test' }));
}

run();
