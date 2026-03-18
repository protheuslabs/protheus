#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-004.1, V6-WORKFLOW-004.2, V6-WORKFLOW-004.3,
// V6-WORKFLOW-004.4, V6-WORKFLOW-004.5, V6-WORKFLOW-004.6,
// V6-WORKFLOW-004.7, V6-WORKFLOW-004.8, V6-WORKFLOW-004.9, V6-WORKFLOW-004.10

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

const bridge = require('../../client/runtime/systems/workflow/crewai_bridge.ts');
const adapter = require('../../adapters/protocol/crewai_tool_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crewai-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const swarmStatePath = path.join(tmpDir, 'swarm.json');
  const approvalQueuePath = path.join(tmpDir, 'reviews.yaml');
  const tracePath = path.join(tmpDir, 'amp_trace.jsonl');

  const crew = bridge.registerCrew({
    crew_name: 'launch_crew',
    process_type: 'hierarchical',
    manager_role: 'manager',
    goal: 'ship validated launch plan',
    agents: [
      { role: 'manager', goal: 'coordinate', backstory: 'chief', tools: ['plan', 'approve'] },
      { role: 'researcher', goal: 'gather facts', backstory: 'analyst', tools: ['search', 'summarize'] },
      { role: 'writer', goal: 'draft copy', backstory: 'editor', tools: ['write', 'edit'], multimodal: true }
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(crew.crew.crew_id), true);

  const processRun = bridge.runProcess({
    crew_id: crew.crew.crew_id,
    process_type: 'hierarchical',
    profile: 'pure',
    tasks: [
      { name: 'research', description: 'collect evidence', role_hint: 'researcher', required_tool: 'search' },
      { name: 'draft', description: 'draft launch note', role_hint: 'writer', required_tool: 'write' },
      { name: 'review', description: 'manager approval', role_hint: 'manager', required_tool: 'approve' }
    ],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(processRun.process_run.degraded, true);
  assert.strictEqual(processRun.process_run.child_sessions.length, 2);

  const flow = bridge.runFlow({
    crew_id: crew.crew.crew_id,
    flow_name: 'launch_flow',
    trigger_event: 'task_completed',
    decorators: ['@start', '@listen'],
    listeners: ['task_completed', 'manager_review'],
    context: { stage: 'draft' },
    routes: [
      { event: 'task_completed', condition: { field: 'stage', equals: 'draft' }, target: 'manager_review' },
      { default: true, target: 'done' }
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(flow.flow.selected_route.target, 'manager_review');

  const memory = bridge.memoryBridge({
    crew_id: crew.crew.crew_id,
    thread_id: 'launch-thread',
    summary: 'crew context',
    recall_query: 'launch',
    memories: [
      { scope: 'crew', text: 'launch campaign requires accurate dates' },
      { scope: 'agent', agent_id: 'researcher', text: 'launch metrics sourced from analytics' }
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(memory.memory.recall_hits.length >= 1, true);

  const config = adapter.ingestConfig({
    config_yaml: 'crew:\n  name: launch_crew\nagents:\n  - role: researcher\n    goal: gather facts\ntasks:\n  - name: research\nflows:\n  - name: launch_flow\n',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(config.config.agent_count, 1);
  assert.strictEqual(config.config.adapter_path, 'adapters/protocol/crewai_tool_bridge.ts');

  const delegation = adapter.routeDelegation({
    crew_id: crew.crew.crew_id,
    profile: 'pure',
    task: 'collect launch evidence',
    role_hint: 'researcher',
    required_tool: 'search',
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(delegation.delegation.selected_agent.role, 'researcher');

  const review = bridge.reviewCrew({
    crew_id: crew.crew.crew_id,
    run_id: processRun.process_run.run_id,
    operator_id: 'human-approver',
    action: 'approve',
    notes: 'looks good',
    state_path: statePath,
    history_path: historyPath,
    approval_queue_path: approvalQueuePath,
  });
  assert.strictEqual(review.review.action, 'approve');
  assert.strictEqual(fs.existsSync(approvalQueuePath), true);

  const trace = bridge.recordAmpTrace({
    crew_id: crew.crew.crew_id,
    run_id: processRun.process_run.run_id,
    stage: 'delegation',
    message: 'delegated research task',
    metrics: { latency_ms: 42 },
    controls: { profile: 'pure' },
    state_path: statePath,
    history_path: historyPath,
    trace_path: tracePath,
  });
  assert.strictEqual(trace.trace.stage, 'delegation');
  assert.strictEqual(fs.existsSync(tracePath), true);

  const benchmark = bridge.benchmarkParity({
    profile: 'pure',
    metrics: { cold_start_ms: 3.2, throughput_ops_sec: 4800.0, memory_mb: 7.5 },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(benchmark.benchmark.parity_ok, true);

  const route = adapter.routeModel({
    profile: 'pure',
    modality: 'image',
    prefer_local: true,
    local_models: ['llava-local'],
    providers: ['openai'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(route.model_route.selected_route.route_kind, 'local_model');
  assert.strictEqual(route.model_route.degraded, false);

  const status = bridge.status({ state_path: statePath, history_path: historyPath });
  assert.strictEqual(status.crews, 1);
  assert.strictEqual(status.process_runs, 1);
  assert.strictEqual(status.flow_runs, 1);
  assert.strictEqual(status.memory_records, 1);
  assert.strictEqual(status.configs, 1);
  assert.strictEqual(status.delegations, 1);
  assert.strictEqual(status.reviews, 1);
  assert.strictEqual(status.traces, 1);
  assert.strictEqual(status.benchmarks, 1);
  assert.strictEqual(status.model_routes, 1);

  console.log(JSON.stringify({ ok: true, type: 'crewai_bridge_test' }));
}

run();
