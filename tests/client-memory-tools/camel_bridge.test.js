#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-013.1, V6-WORKFLOW-013.2, V6-WORKFLOW-013.3,
// V6-WORKFLOW-013.4, V6-WORKFLOW-013.5, V6-WORKFLOW-013.6, V6-WORKFLOW-013.7,
// V6-WORKFLOW-013.8

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

const bridge = require('../../client/runtime/systems/workflow/camel_bridge.ts');
const connector = require('../../adapters/protocol/camel_connector_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'camel-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const swarmStatePath = path.join(tmpDir, 'swarm-state.json');
  const outputDir = `client/runtime/local/state/camel-shell-${process.pid}`;

  const society = bridge.registerSociety({
    name: 'incident-society',
    roles: [
      { label: 'planner', role: 'coordinator', goal: 'plan response' },
      { label: 'researcher', role: 'retriever', goal: 'gather evidence' },
      { label: 'critic', role: 'reviewer', goal: 'check risks' }
    ],
    supported_profiles: ['rich', 'pure', 'tiny-max'],
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(Boolean(society.society.society_id), true);

  const runSociety = bridge.runSociety({
    society_id: society.society.society_id,
    profile: 'pure',
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath
  });
  assert.strictEqual(runSociety.run.degraded, true);
  assert.strictEqual(runSociety.run.sessions.length, 2);

  const simulation = bridge.simulateWorld({
    world_name: 'billing-world',
    profile: 'pure',
    seed_state: { region: 'us-west' },
    events: [
      { id: 'e1', kind: 'incident' },
      { id: 'e2', kind: 'rumor' },
      { id: 'e3', kind: 'update' }
    ],
    agents_informed: ['planner', 'researcher'],
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(simulation.simulation.degraded, true);

  const dataset = connector.importDataset({
    name: 'incident-dataset',
    dataset_kind: 'society',
    records: [
      { prompt: 'triage', completion: 'collect evidence' },
      { prompt: 'respond', completion: 'draft summary' }
    ],
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(dataset.dataset.record_count, 2);

  const conversation = bridge.routeConversation({
    name: 'incident-chat',
    profile: 'pure',
    code_prompt: 'def solve(issue): return issue',
    turns: [
      { speaker: 'planner', text: 'collect data' },
      { speaker: 'researcher', text: 'billing service down' },
      { speaker: 'critic', text: 'watch customer impact' },
      { speaker: 'planner', text: 'draft mitigation' }
    ],
    language_routes: ['python', 'markdown'],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath
  });
  assert.strictEqual(conversation.conversation.degraded, true);

  const benchmark = bridge.recordCrabBenchmark({
    name: 'incident-crab',
    profile: 'pure',
    tasks: ['ocr', 'retrieval'],
    artifacts: [
      { media_type: 'image/png', path: 'adapters/assets/incident.png' },
      { media_type: 'text/plain', path: 'adapters/assets/incident.txt' }
    ],
    metrics: { success: 0.82 },
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(benchmark.benchmark.degraded, true);

  const gateway = connector.registerToolGateway({
    name: 'incident-tools',
    bridge_path: 'adapters/protocol/camel_connector_bridge.ts',
    tools: [
      { name: 'search', supported_profiles: ['rich', 'pure'] },
      { name: 'email', supported_profiles: ['rich', 'pure'], requires_approval: true }
    ],
    state_path: statePath,
    history_path: historyPath
  });
  const invocation = connector.invokeToolGateway({
    gateway_id: gateway.tool_gateway.gateway_id,
    tool_name: 'email',
    profile: 'pure',
    approved: false,
    args: { subject: 'incident' },
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(invocation.invocation.status, 'denied');

  const observation = bridge.recordScalingObservation({
    society_id: society.society.society_id,
    agent_count: 128,
    message_count: 4096,
    coherence: 0.33,
    risk_signals: ['herding', 'feedback_loop'],
    metrics: { entropy: 0.71 },
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(observation.observation.emergent_risk, 'elevated');

  const intake = bridge.assimilateIntake({
    package_name: 'camel-shell',
    output_dir: outputDir,
    state_path: statePath,
    history_path: historyPath
  });
  assert.strictEqual(Boolean(intake.intake.intake_id), true);
  assert.strictEqual(fs.existsSync(path.join(process.cwd(), outputDir, 'package.json')), true);

  const status = bridge.status({ state_path: statePath, history_path: historyPath });
  assert.strictEqual(status.societies, 1);
  assert.strictEqual(status.society_runs, 1);
  assert.strictEqual(status.world_simulations, 1);
  assert.strictEqual(status.datasets, 1);
  assert.strictEqual(status.conversation_routes, 1);
  assert.strictEqual(status.benchmarks, 1);
  assert.strictEqual(status.tool_gateways, 1);
  assert.strictEqual(status.tool_invocations, 1);
  assert.strictEqual(status.scaling_observations, 1);
  assert.strictEqual(status.intakes, 1);

  fs.rmSync(path.join(process.cwd(), outputDir), { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, type: 'camel_bridge_test' }));
}

run();
