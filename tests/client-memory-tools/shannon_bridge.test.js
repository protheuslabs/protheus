#!/usr/bin/env node
'use strict';

// SRS coverage: V6-WORKFLOW-001.1, V6-WORKFLOW-001.2, V6-WORKFLOW-001.3,
// V6-WORKFLOW-001.4, V6-WORKFLOW-001.5, V6-WORKFLOW-001.6,
// V6-WORKFLOW-001.7, V6-WORKFLOW-001.8, V6-WORKFLOW-001.9,
// V6-WORKFLOW-001.10, V6-WORKFLOW-001.11, V6-WORKFLOW-001.12

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

const bridge = require('../../client/runtime/systems/workflow/shannon_bridge.ts');
const adapter = require('../../adapters/protocol/shannon_gateway_bridge.ts');
const desktop = require('../../client/runtime/systems/workflow/shannon_desktop_shell.ts');

function run() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shannon-bridge-'));
  const statePath = path.join(tmpDir, 'state.json');
  const historyPath = path.join(tmpDir, 'history.jsonl');
  const replayDir = path.join(tmpDir, 'replays');
  const approvalQueuePath = path.join(tmpDir, 'approvals.yaml');
  const tracePath = path.join(tmpDir, 'observability.jsonl');
  const metricsPath = path.join(tmpDir, 'metrics.prom');
  const desktopHistoryPath = path.join(tmpDir, 'desktop.json');

  const pattern = bridge.registerPattern({
    pattern_name: 'triage_router',
    strategies: ['planner', 'executor', 'reviewer'],
    stages: ['plan', 'delegate', 'review'],
    handoff_graph: [{ from: 'planner', to: 'executor' }],
    profile: 'rich',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(pattern.pattern.pattern_id), true);
  assert.strictEqual(pattern.pattern.allowed_parallelism, 4);

  const budget = bridge.guardBudget({
    session_id: 'session-1',
    token_budget: 1200,
    estimated_tokens: 2400,
    current_model: 'gpt-5.4',
    fallback_models: ['gpt-5.4-mini'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(budget.budget_guard.action, 'fallback');
  assert.strictEqual(budget.budget_guard.selected_model, 'gpt-5.4-mini');

  const memory = bridge.memoryBridge({
    workspace_id: 'workspace-1',
    query: 'launch readiness',
    profile: 'pure',
    context_budget: 3,
    recent_items: [
      { id: 'm1', text: 'recent launch note' },
      { id: 'm2', text: 'recent release checklist' }
    ],
    semantic_items: [
      { id: 'm2', text: 'recent release checklist' },
      { id: 'm3', text: 'semantic launch faq' }
    ],
    hierarchy: { root: ['recent', 'semantic'] },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(memory.memory_workspace.selected_items.length, 3);

  const replay = bridge.replayRun({
    run_id: 'run-1',
    events: [{ stage: 'plan' }, { stage: 'execute' }],
    receipt_refs: [pattern.pattern.pattern_id],
    replay_dir: replayDir,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(Boolean(replay.replay.replay_hash), true);
  assert.strictEqual(fs.existsSync(path.join(replayDir, 'run-1.json')), true);

  const approval = bridge.approvalCheckpoint({
    action_id: 'action-1',
    title: 'Approve launch action',
    reason: 'operator review required',
    operator: 'human-reviewer',
    status: 'pending',
    approval_queue_path: approvalQueuePath,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(approval.approval_checkpoint.status, 'pending');
  assert.strictEqual(fs.existsSync(approvalQueuePath), true);

  const sandbox = bridge.sandboxExecute({
    tenant_id: 'tenant-a',
    sandbox_mode: 'wasi',
    read_only: true,
    command: 'cargo test --lib',
    fs_paths: ['core/', 'client/'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(sandbox.sandbox_run.read_only, true);

  const observability = bridge.recordObservability({
    run_id: 'run-1',
    message: 'captured workflow spans',
    spans: [{ name: 'plan', duration_ms: 12 }],
    metrics: { latency_ms: 12.0, tokens: 320.0 },
    observability_trace_path: tracePath,
    observability_metrics_path: metricsPath,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(observability.trace_path.endsWith('observability.jsonl'), true);
  assert.strictEqual(fs.existsSync(tracePath), true);
  assert.strictEqual(fs.existsSync(metricsPath), true);

  const gateway = adapter.gatewayRoute({
    request_id: 'gateway-1',
    compat_mode: '/v1/chat/completions',
    providers: ['openai', 'anthropic'],
    model: 'vision-pro',
    streaming: true,
    profile: 'tiny-max',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(gateway.gateway_route.degraded, true);
  assert.strictEqual(gateway.gateway_route.bridge_path, 'adapters/protocol/shannon_gateway_bridge.ts');

  const tooling = adapter.registerTooling({
    skills: ['timeline', 'summarize'],
    mcp_tools: [
      { name: 'filesystem', unsafe: false },
      { name: 'calendar', unsafe: false }
    ],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(tooling.tool_registry.skills.length, 2);

  const schedule = bridge.scheduleRun({
    job_name: 'nightly-replay',
    cron: '0 2 * * *',
    pattern_id: pattern.pattern.pattern_id,
    priority: 7,
    budget: { tokens: 2048 },
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(schedule.schedule.priority, 7);

  const notify = desktop.notify({
    title: 'Launch update',
    message: 'desktop shell relayed',
    desktop_history_path: desktopHistoryPath,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(notify.desktop_event.surface, 'notify');
  const tray = desktop.trayStatus({
    title: 'Tray state',
    message: 'ready',
    desktop_history_path: desktopHistoryPath,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(tray.desktop_event.surface, 'tray');
  const history = desktop.offlineHistory({
    title: 'Offline snapshot',
    message: 'history captured',
    desktop_history_path: desktopHistoryPath,
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(history.desktop_event.surface, 'history');
  assert.strictEqual(fs.existsSync(desktopHistoryPath), true);

  const p2p = adapter.p2pReliability({
    peer_id: 'peer-1',
    version: 'v1',
    supported_versions: ['v1', 'v2'],
    message_ids: ['m1', 'm1', 'm2', 'm3'],
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(p2p.p2p_reliability.deduplicated_messages, 3);

  const intake = bridge.assimilateIntake({
    shell_path: 'client/runtime/systems/workflow/shannon_desktop_shell.ts',
    bridge_path: 'adapters/protocol/shannon_gateway_bridge.ts',
    state_path: statePath,
    history_path: historyPath,
  });
  assert.strictEqual(intake.intake.deletable, true);

  const status = bridge.status({ state_path: statePath, history_path: historyPath });
  assert.strictEqual(status.patterns, 1);
  assert.strictEqual(status.budget_guards, 1);
  assert.strictEqual(status.memory_workspaces, 1);
  assert.strictEqual(status.replays, 1);
  assert.strictEqual(status.approvals, 1);
  assert.strictEqual(status.sandbox_runs, 1);
  assert.strictEqual(status.observability, 1);
  assert.strictEqual(status.gateway_routes, 1);
  assert.strictEqual(status.tool_registrations, 1);
  assert.strictEqual(status.schedules, 1);
  assert.strictEqual(status.desktop_events, 3);
  assert.strictEqual(status.p2p_reliability, 1);
  assert.strictEqual(status.intakes, 1);

  console.log(JSON.stringify({ ok: true, type: 'shannon_bridge_test' }));
}

run();
