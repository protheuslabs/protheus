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

function parseArgs(argv) {
  const out = {
    count: 100,
    extendLanes: null,
    laneOnly: null,
    laneTimeoutMs: 120000,
  };
  for (const rawArg of argv || []) {
    const arg = String(rawArg || '').trim();
    if (!arg) continue;
    if (arg.startsWith('--count=')) {
      const value = Number(arg.slice('--count='.length));
      if (Number.isFinite(value) && value > 0) {
        out.count = Math.max(1, Math.floor(value));
      }
      continue;
    }
    if (arg === '--extend-lanes' || arg === '--extend-lanes=1') {
      out.extendLanes = true;
      continue;
    }
    if (arg === '--extend-lanes=0' || arg === '--no-extend-lanes') {
      out.extendLanes = false;
      continue;
    }
    if (arg === '--lane-only' || arg === '--lane-only=1') {
      out.laneOnly = true;
      continue;
    }
    if (arg === '--lane-only=0' || arg === '--no-lane-only') {
      out.laneOnly = false;
      continue;
    }
    if (arg.startsWith('--lane-timeout-ms=')) {
      const value = Number(arg.slice('--lane-timeout-ms='.length));
      if (Number.isFinite(value) && value > 0) {
        out.laneTimeoutMs = Math.max(1000, Math.floor(value));
      }
    }
  }
  if (out.extendLanes === null) {
    out.extendLanes = out.count > 100;
  }
  if (out.laneOnly === null) {
    out.laneOnly = out.count > 100;
  }
  return out;
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

function laneScore(name) {
  const id = String(name || '').toLowerCase();
  let score = 0;
  if (id.includes('-sec-') || id.includes(':v6-sec-') || id.includes(':v10-sec-')) score += 120;
  if (id.includes('-autonomy-') || id.includes('-swarm-')) score += 95;
  if (id.includes('-memory-') || id.includes('-persist-')) score += 90;
  if (id.includes('-mcp-') || id.includes('-network-')) score += 80;
  if (id.includes('-f100-') || id.includes('-canyon-') || id.includes('-top1-')) score += 75;
  if (id.includes('-workflow-') || id.includes('-parse-')) score += 65;
  if (id.includes('-research-') || id.includes('-model-')) score += 55;
  if (id.includes('-batch')) score += 20;
  if (id.includes(':v10-')) score += 50;
  else if (id.includes(':v9-')) score += 40;
  else if (id.includes(':v8-')) score += 30;
  else if (id.includes(':v7-')) score += 20;
  else if (id.includes(':v6-')) score += 10;
  return score;
}

function buildLaneExtensionMoves(scripts, needed, laneTimeoutMs) {
  if (needed <= 0) return [];
  const laneNames = Object.keys(scripts || {})
    .filter((name) => name.startsWith('lane:') && name.endsWith(':run'))
    .sort((a, b) => {
      const as = laneScore(a);
      const bs = laneScore(b);
      if (as !== bs) return bs - as;
      return a.localeCompare(b);
    });
  return laneNames.slice(0, needed).map((laneName) => ({
    title: `Lane execute ${laneName}`,
    kind: 'cmd',
    cmd: 'npm',
    args: ['run', '-s', laneName],
    timeout_ms: laneTimeoutMs,
    lane_score: laneScore(laneName),
  }));
}

function buildMoves(options = {}) {
  const targetCount = Math.max(1, Number(options.count || 100));
  const extendLanes = Boolean(options.extendLanes);
  const laneOnly = Boolean(options.laneOnly);
  const laneTimeoutMs = Number(options.laneTimeoutMs || 120000);
  const moves = [];
  const scripts = readPackageScripts();
  const push = (move) => moves.push(move);
  const swarm = (...args) => ({
    kind: 'cmd',
    cmd: 'node',
    args: ['client/runtime/systems/ops/run_protheus_ops.js', 'swarm-runtime', ...args, `--state-path=${STATE}`],
  });

  if (!laneOnly) {
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
      'test:ops:dashboard-ui',
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
  }

  if (!laneOnly && moves.length !== 100) {
    throw new Error(`roi100_move_count_invalid:${moves.length}`);
  }

  if (extendLanes && targetCount > moves.length) {
    const needed = targetCount - moves.length;
    const extensionMoves = buildLaneExtensionMoves(scripts, needed, laneTimeoutMs);
    moves.push(...extensionMoves);
  }

  if (moves.length < targetCount) {
    throw new Error(`roi_move_count_insufficient:have=${moves.length}:need=${targetCount}`);
  }
  return moves.slice(0, targetCount).map((move, idx) => ({ id: mkId(idx + 1), ...move }));
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const startedAt = nowIso();
  const moves = buildMoves(options);
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
    type: moves.length === 100 ? 'roi100_moves_run' : 'roi_moves_run',
    started_at: startedAt,
    finished_at: finishedAt,
    requested_count: options.count,
    extend_lanes: options.extendLanes,
    lane_only: options.laneOnly,
    lane_timeout_ms: options.laneTimeoutMs,
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
  mdLines.push(`# ROI${payload.summary.total} Moves Run`);
  mdLines.push('');
  mdLines.push(`- started: ${startedAt}`);
  mdLines.push(`- finished: ${finishedAt}`);
  mdLines.push(`- requested_count: ${payload.requested_count}`);
  mdLines.push(`- extend_lanes: ${payload.extend_lanes ? 'yes' : 'no'}`);
  mdLines.push(`- lane_only: ${payload.lane_only ? 'yes' : 'no'}`);
  mdLines.push(`- lane_timeout_ms: ${payload.lane_timeout_ms}`);
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
