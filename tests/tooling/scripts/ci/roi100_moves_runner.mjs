#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const OUT_DIR = path.join(ROOT, 'local', 'state', 'ops', 'roi100_moves');
const LATEST_JSON = path.join(OUT_DIR, 'latest.json');
const LATEST_MD = path.join(OUT_DIR, 'latest.md');
const STATE = path.join(
  os.tmpdir(),
  `swarm-runtime-roi100-${Date.now()}-${Math.floor(Math.random() * 1e6)}.json`
);

function nowIso() {
  return new Date().toISOString();
}

function mkId(n) {
  return `ROI-${String(n).padStart(3, '0')}`;
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

function runCmd(cmd, args, timeoutMs = 120000) {
  const start = Date.now();
  const proc = spawnSync(cmd, args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env,
  });
  const end = Date.now();
  const status = Number.isFinite(Number(proc.status)) ? Number(proc.status) : 1;
  const stdout = String(proc.stdout || '');
  const stderr = String(proc.stderr || '');
  const payload = parseLastJson(stdout);
  return {
    ok: status === 0,
    status,
    duration_ms: end - start,
    stdout_tail: stdout.split('\n').slice(-8).join('\n'),
    stderr_tail: stderr.split('\n').slice(-8).join('\n'),
    payload,
  };
}

function exists(relPath) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function readPackageScripts() {
  const pkgPath = path.join(ROOT, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  return pkg.scripts || {};
}

function buildMoves() {
  const moves = [];
  const scripts = readPackageScripts();
  const push = (move) => moves.push(move);
  const swarm = (...args) => ({
    kind: 'cmd',
    cmd: 'node',
    args: ['client/runtime/systems/ops/run_protheus_ops.js', 'swarm-runtime', ...args, `--state-path=${STATE}`],
  });

  // Baseline runtime health
  push({ title: 'Swarm status responds', ...swarm('status') });
  push({ title: 'Queue metrics JSON export', ...swarm('metrics', 'queue', '--format=json') });
  push({ title: 'Queue metrics Prometheus export', ...swarm('metrics', 'queue', '--format=prometheus') });
  push({ title: 'Byzantine test mode enable', ...swarm('byzantine-test', 'enable') });

  // Recursive decomposition reliability
  for (const levels of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    push({ title: `Recursive lane level ${levels}`, ...swarm('test', 'recursive', `--levels=${levels}`) });
  }

  // Concurrency storm stability
  for (const agents of [3, 5, 8, 10, 12, 14, 16, 18, 20, 24]) {
    push({
      title: `Concurrency lane agents=${agents}`,
      ...swarm('test', 'concurrency', `--agents=${agents}`, '--metrics=detailed'),
    });
  }

  // Byzantine fault tolerance
  for (const [agents, corrupt] of [
    [3, 1],
    [4, 1],
    [5, 1],
    [5, 2],
    [6, 2],
    [7, 2],
    [8, 2],
    [9, 3],
    [10, 3],
    [12, 4],
  ]) {
    push({
      title: `Byzantine lane agents=${agents} corrupt=${corrupt}`,
      ...swarm('test', 'byzantine', `--agents=${agents}`, `--corrupt=${corrupt}`),
    });
  }

  // Inter-agent messaging guarantees
  const commModes = ['at_most_once', 'at_least_once', 'exactly_once'];
  for (const delivery of commModes) {
    push({
      title: `Communication delivery=${delivery} fail-first=0`,
      ...swarm('test', 'communication', `--delivery=${delivery}`, '--simulate-first-attempt-fail=0'),
    });
    push({
      title: `Communication delivery=${delivery} fail-first=1`,
      ...swarm('test', 'communication', `--delivery=${delivery}`, '--simulate-first-attempt-fail=1'),
    });
  }
  for (const extra of [1, 2, 3, 4]) {
    push({
      title: `Communication stress variant ${extra}`,
      ...swarm('test', 'communication', '--delivery=at_least_once', '--simulate-first-attempt-fail=1'),
    });
  }

  // Token budget enforcement
  const budgetActions = ['fail', 'warn', 'compact'];
  const budgets = [120, 200, 280, 360];
  for (const action of budgetActions) {
    for (const budget of budgets) {
      const shouldFail = action === 'fail' && budget <= 130;
      push({
        title: `Budget lane action=${action} budget=${budget}`,
        ...swarm(
          'test',
          'budget',
          `--budget=${budget}`,
          '--warning-at=0.5',
          `--on-budget-exhausted=${action}`,
          `--assert-hard-enforcement=${shouldFail ? 1 : 0}`,
          shouldFail ? '--expect-fail=1' : '--expect-fail=0',
          '--task=summarize largest programming language communities'
        ),
      });
    }
  }

  // Persistent sessions
  for (const [life, interval] of [
    [180, 30],
    [300, 60],
    [420, 70],
    [600, 120],
  ]) {
    push({
      title: `Persistent lane lifespan=${life} interval=${interval}`,
      ...swarm(
        'test',
        'persistent',
        `--lifespan-sec=${life}`,
        `--check-in-interval-sec=${interval}`,
        `--advance-ms=${life * 1000}`
      ),
    });
  }

  // Heterogeneous/coordinator consensus
  for (const timeout of [6, 8, 10, 15]) {
    push({
      title: `Heterogeneous lane timeout=${timeout}`,
      ...swarm('test', 'heterogeneous', '--min-count=2', `--timeout-sec=${timeout}`),
    });
  }

  // Thin client swarm runtime wrapper
  for (const team of [2, 3, 4, 5]) {
    push({
      title: `Wrapper run objective=generic team=${team}`,
      kind: 'cmd',
      cmd: 'node',
      args: [
        'client/runtime/systems/autonomy/swarm_orchestration_runtime.ts',
        'run',
        '--objective=generic',
        `--team_size=${team}`,
        `--state-path=${STATE}`,
      ],
    });
  }
  push({
    title: 'Wrapper test id=2',
    kind: 'cmd',
    cmd: 'node',
    args: ['client/runtime/systems/autonomy/swarm_orchestration_runtime.ts', 'test', '--id=2', `--state-path=${STATE}`],
  });
  push({
    title: 'Wrapper test id=3',
    kind: 'cmd',
    cmd: 'node',
    args: ['client/runtime/systems/autonomy/swarm_orchestration_runtime.ts', 'test', '--id=3', `--state-path=${STATE}`],
  });
  push({
    title: 'Wrapper test id=6',
    kind: 'cmd',
    cmd: 'node',
    args: ['client/runtime/systems/autonomy/swarm_orchestration_runtime.ts', 'test', '--id=6', `--state-path=${STATE}`],
  });
  push({
    title: 'Wrapper test id=all',
    kind: 'cmd',
    cmd: 'node',
    args: ['client/runtime/systems/autonomy/swarm_orchestration_runtime.ts', 'test', '--id=all', `--state-path=${STATE}`],
  });

  // Regression suites
  for (const script of ['test:autonomy:swarm-runtime', 'test:autonomy:swarm-smoothness']) {
    push({
      title: `NPM ${script}`,
      kind: 'cmd',
      cmd: 'npm',
      args: ['run', '-s', script],
      timeout_ms: 180000,
    });
  }

  // Core integration lanes
  for (const testName of [
    'recursive_test_reaches_five_levels_with_parent_child_chain',
    'byzantine_test_mode_enables_corrupted_reports',
    'channels_create_publish_poll_and_communication_test_pass',
    'heterogeneous_test_suite_completes_with_consensus',
    'queue_metrics_command_supports_prometheus_format',
  ]) {
    push({
      title: `Core integration ${testName}`,
      kind: 'cmd',
      cmd: 'cargo',
      args: ['test', '-p', 'protheus-ops-core', '--test', 'v9_swarm_runtime_integration', testName],
      timeout_ms: 180000,
    });
  }

  // Governance/security boundaries
  for (const script of [
    'test:security:truth-gate',
    'ops:dependency-boundary:check',
    'ops:client-layer:boundary',
  ]) {
    push({
      title: `NPM ${script}`,
      kind: 'cmd',
      cmd: 'npm',
      args: ['run', '-s', script],
      timeout_ms: 120000,
    });
  }

  // Packaging/command registry surfaces
  for (const scriptName of [
    'autonomy:swarm-runtime:run',
    'autonomy:swarm:test2',
    'autonomy:swarm:test3',
    'autonomy:swarm:test6',
    'autonomy:swarm:test236',
  ]) {
    push({
      title: `Package script exists: ${scriptName}`,
      kind: 'check',
      check: () => ({
        ok: Boolean(scripts[scriptName]),
        detail: scripts[scriptName] || 'missing_script',
      }),
    });
  }

  // File existence invariants (thin-client + Rust authority evidence surfaces)
  for (const relPath of [
    'client/runtime/systems/autonomy/swarm_orchestration_runtime.ts',
    'tests/client-memory-tools/swarm_orchestration_runtime.test.js',
    'tests/client-memory-tools/swarm_runtime_smoothness.test.js',
    'client/runtime/systems/ops/run_protheus_ops.js',
    'core/layer0/ops/src/swarm_runtime.rs',
    'core/layer0/ops/tests/v9_swarm_runtime_integration.rs',
    'docs/workspace/codex_enforcer.md',
    'docs/workspace/DEFINITION_OF_DONE.md',
    'client/runtime/config/client_layer_boundary_policy.json',
  ]) {
    push({
      title: `File exists: ${relPath}`,
      kind: 'check',
      check: () => ({ ok: exists(relPath), detail: relPath }),
    });
  }

  // Top-level sanity checks using swarm core routes
  for (const checkCmd of [
    ['status'],
    ['metrics', 'queue', '--format=json'],
    ['byzantine-test', 'status'],
    ['results', 'query', '--role=calculator'],
  ]) {
    push({
      title: `Swarm route sanity: ${checkCmd.join(' ')}`,
      ...swarm(...checkCmd),
    });
  }

  if (moves.length !== 100) {
    throw new Error(`roi100_move_count_invalid:${moves.length}`);
  }
  return moves.map((move, idx) => ({ id: mkId(idx + 1), ...move }));
}

function main() {
  const startedAt = nowIso();
  const moves = buildMoves();
  const results = [];
  let passed = 0;
  let failed = 0;

  for (const move of moves) {
    const start = Date.now();
    let result;
    if (move.kind === 'check') {
      const out = move.check();
      result = {
        ok: Boolean(out && out.ok),
        status: out && out.ok ? 0 : 1,
        duration_ms: Date.now() - start,
        stdout_tail: '',
        stderr_tail: '',
        payload: out || null,
      };
    } else {
      result = runCmd(move.cmd, move.args || [], move.timeout_ms || 120000);
    }
    results.push({
      id: move.id,
      title: move.title,
      kind: move.kind || 'cmd',
      command: move.kind === 'check' ? null : [move.cmd, ...(move.args || [])].join(' '),
      ...result,
    });
    if (result.ok) passed += 1;
    else failed += 1;
  }

  const finishedAt = nowIso();
  const payload = {
    type: 'roi100_moves_run',
    started_at: startedAt,
    finished_at: finishedAt,
    summary: {
      total: results.length,
      passed,
      failed,
      pass: failed === 0,
    },
    state_path: STATE,
    results,
  };

  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LATEST_JSON, `${JSON.stringify(payload, null, 2)}\n`);

  const mdLines = [];
  mdLines.push('# ROI100 Moves Run');
  mdLines.push('');
  mdLines.push(`- started: ${startedAt}`);
  mdLines.push(`- finished: ${finishedAt}`);
  mdLines.push(`- total: ${payload.summary.total}`);
  mdLines.push(`- passed: ${payload.summary.passed}`);
  mdLines.push(`- failed: ${payload.summary.failed}`);
  mdLines.push('');
  mdLines.push('## Results');
  mdLines.push('');
  for (const row of results) {
    mdLines.push(
      `- ${row.id} ${row.ok ? 'PASS' : 'FAIL'} :: ${row.title}${row.command ? ` \`${row.command}\`` : ''}`
    );
    if (!row.ok) {
      if (row.stderr_tail) mdLines.push(`  - stderr: \`${row.stderr_tail.replace(/\n/g, ' ')}\``);
      if (row.stdout_tail) mdLines.push(`  - stdout: \`${row.stdout_tail.replace(/\n/g, ' ')}\``);
    }
  }
  fs.writeFileSync(LATEST_MD, `${mdLines.join('\n')}\n`);

  console.log(JSON.stringify(payload, null, 2));
  process.exit(payload.summary.pass ? 0 : 1);
}

main();
