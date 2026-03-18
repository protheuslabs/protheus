#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-002.1, V6-WORKFLOW-002.2, V6-WORKFLOW-002.3,
// V6-WORKFLOW-002.4, V6-WORKFLOW-002.5, V6-WORKFLOW-002.6

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

const bridge = require('../../client/runtime/systems/workflow/langgraph_bridge.ts');
const protocol = require('../../adapters/protocol/langgraph_trace_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'langgraph-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const swarmStatePath = path.join(tmpDir, 'swarm.json');
  const tracePath = path.join(tmpDir, 'native-trace.jsonl');

  const graph = bridge.registerGraph({
    name: 'incident_graph',
    entry_node: 'triage',
    nodes: [
      { id: 'triage', kind: 'planner' },
      { id: 'retrieve', kind: 'retriever' },
      { id: 'respond', kind: 'responder' }
    ],
    edges: [
      { from: 'triage', to: 'retrieve', label: 'need_context', condition: { field: 'route', equals: 'retrieve' } },
      { from: 'triage', to: 'respond', label: 'default', default: true },
      { from: 'retrieve', to: 'respond', label: 'answer', default: true }
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(graph.graph.graph_id), true);
  assert.strictEqual(graph.graph.conditional_edge_count, 1);

  const checkpoint = bridge.checkpointRun({
    graph_id: graph.graph.graph_id,
    thread_id: 'incident-thread',
    checkpoint_label: 'after_triage',
    state_snapshot: { ticket: 'INC-42', route: 'retrieve', priority: 'high' },
    replay_enabled: true,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(checkpoint.checkpoint.checkpoint_id), true);
  assert.strictEqual(Boolean(checkpoint.checkpoint.replay_token), true);

  const inspection = bridge.inspectState({
    checkpoint_id: checkpoint.checkpoint.checkpoint_id,
    operator_id: 'human-reviewer',
    view_fields: ['ticket', 'priority'],
    intervention_patch: { priority: 'urgent' },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(inspection.inspection.change_applied, true);
  assert.strictEqual(inspection.inspection.inspection_mode, 'intervened');

  const coordination = bridge.coordinateSubgraph({
    graph_id: graph.graph.graph_id,
    profile: 'pure',
    subgraphs: [
      { name: 'triage-subgraph', role: 'planner', task: 'triage incoming report' },
      { name: 'retrieval-subgraph', role: 'retriever', task: 'collect evidence' },
      { name: 'response-subgraph', role: 'responder', task: 'draft reply' }
    ],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(coordination.coordination.degraded, true);
  assert.strictEqual(coordination.coordination.child_sessions.length, 2);

  const trace = protocol.recordTrace({
    graph_id: graph.graph.graph_id,
    stage: 'transition',
    message: 'triage routed into retrieval',
    transitions: [{ from: 'triage', to: 'retrieve', reason: 'need_context' }],
    metrics: { latency_ms: 48 },
    state_path: statePath,
    history_path: historyPath,
    trace_path: tracePath,
  });
  assert.strictEqual(trace.trace.bridge_path, 'adapters/protocol/langgraph_trace_bridge.ts');
  assert.strictEqual(fs.existsSync(tracePath), true);

  const stream = protocol.streamGraph({
    graph_id: graph.graph.graph_id,
    profile: 'pure',
    stream_mode: 'updates',
    context: { route: 'retrieve' },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(stream.stream.degraded, true);
  assert.strictEqual(stream.stream.visited[0], 'triage');
  assert.strictEqual(stream.stream.events.some((row) => row.event === 'edge_selected'), true);

  const status = bridge.status({ state_path: statePath, history_path: historyPath });
  assert.strictEqual(status.graphs, 1);
  assert.strictEqual(status.checkpoints, 1);
  assert.strictEqual(status.inspections, 1);
  assert.strictEqual(status.subgraphs, 1);
  assert.strictEqual(status.traces, 1);
  assert.strictEqual(status.streams, 1);

  console.log(JSON.stringify({ ok: true, type: 'langgraph_bridge_test' }));
}

run();
