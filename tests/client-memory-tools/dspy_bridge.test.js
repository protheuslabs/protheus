#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-017.1, V6-WORKFLOW-017.2, V6-WORKFLOW-017.3,
// V6-WORKFLOW-017.4, V6-WORKFLOW-017.5, V6-WORKFLOW-017.6, V6-WORKFLOW-017.7,
// V6-WORKFLOW-017.8

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

const bridge = require('../../client/runtime/systems/workflow/dspy_bridge.ts');
const protocol = require('../../adapters/protocol/dspy_program_bridge.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dspy-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const swarmStatePath = path.join(tmpDir, 'swarm-state.json');

  const signature = bridge.registerSignature({
    name: 'incident_signature',
    predictor_type: 'chain_of_thought',
    input_fields: ['question', 'context'],
    output_fields: ['answer', 'confidence'],
    examples: [{ question: 'What failed?', answer: 'billing' }],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(signature.signature.signature_id), true);

  const compiled = bridge.compileProgram({
    name: 'incident_program',
    profile: 'rich',
    modules: [
      {
        label: 'retrieve',
        signature_id: signature.signature.signature_id,
        strategy: 'predict',
        prompt_template: 'Retrieve evidence for {{question}}'
      },
      {
        label: 'answer',
        signature_id: signature.signature.signature_id,
        strategy: 'chain_of_thought',
        prompt_template: 'Answer {{question}} using {{context}}'
      }
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(compiled.program.program_id), true);

  const optimized = bridge.optimizeProgram({
    program_id: compiled.program.program_id,
    optimizer_kind: 'teleprompter',
    profile: 'pure',
    max_trials: 6,
    baseline_score: 0.42,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(optimized.optimization.degraded, true);
  assert.strictEqual(optimized.optimization.executed_trials, 2);

  const assertion = bridge.assertProgram({
    program_id: compiled.program.program_id,
    assertions: [{ field: 'answer' }, { field: 'confidence' }],
    candidate_output: { answer: 'billing outage' },
    attempt: 1,
    max_retries: 1,
    context_budget: 512,
    profile: 'rich',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(assertion.assertion.status, 'retry');

  const integration = protocol.importIntegration({
    name: 'dspy-retriever',
    kind: 'retriever',
    source: 'hybrid search backend',
    capabilities: ['retrieve', 'rank'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(integration.integration.integration_id), true);

  const multihop = protocol.executeMultihop({
    name: 'incident-multihop',
    program_id: compiled.program.program_id,
    integration_ids: [integration.integration.integration_id],
    profile: 'pure',
    hops: [
      { label: 'plan', signature_id: signature.signature.signature_id, query: 'plan the search', tool_tags: ['plan'] },
      { label: 'retrieve', signature_id: signature.signature.signature_id, query: 'retrieve incident evidence', tool_tags: ['retrieve'] },
      { label: 'answer', signature_id: signature.signature.signature_id, query: 'produce answer', tool_tags: ['answer'] }
    ],
    state_path: statePath,
    history_path: historyPath,
    swarm_state_path: swarmStatePath,
  });
  assert.strictEqual(multihop.multihop.degraded, true);
  assert.strictEqual(multihop.multihop.hop_count, 2);
  assert.strictEqual(Boolean(multihop.multihop.coordinator_session_id), true);

  const benchmark = protocol.recordBenchmark({
    program_id: compiled.program.program_id,
    benchmark_name: 'incident_eval',
    profile: 'rich',
    score: 0.77,
    metrics: { exact_match: 0.8, latency_ms: 420 },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(benchmark.benchmark.score, 0.77);

  const trace = bridge.recordOptimizationTrace({
    program_id: compiled.program.program_id,
    optimization_id: optimized.optimization.optimization_id,
    profile: 'rich',
    seed: 13,
    reproducible: true,
    message: 'teleprompter candidate improved recall',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(trace.optimization_trace.reproducible, true);

  const intake = bridge.assimilateIntake({
    shell_name: 'dspy-shell',
    shell_path: 'client/runtime/systems/workflow/dspy_bridge.ts',
    target: 'local',
    artifact_path: 'adapters/protocol/dspy_program_bridge.ts',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(intake.intake.authority_delegate, 'core://dspy-bridge');

  const status = bridge.status({ state_path: statePath, history_path: historyPath });
  assert.strictEqual(status.signatures, 1);
  assert.strictEqual(status.compiled_programs, 1);
  assert.strictEqual(status.optimization_runs, 1);
  assert.strictEqual(status.assertion_runs, 1);
  assert.strictEqual(status.integrations, 1);
  assert.strictEqual(status.multihop_runs, 1);
  assert.strictEqual(status.benchmarks, 1);
  assert.strictEqual(status.optimization_traces, 1);
  assert.strictEqual(status.intakes, 1);

  console.log(JSON.stringify({ ok: true, type: 'dspy_bridge_test' }));
}

run();
