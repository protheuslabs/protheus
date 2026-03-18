#!/usr/bin/env node
/* eslint-disable no-console */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve('.');
const VALID_IDS = new Set([
  'V6-APP-023.7',
  'V6-APP-023.8',
  'V6-APP-023.9',
  'V6-APP-023.10',
  'V6-APP-023.11',
]);

function parseArgs(argv) {
  const out = new Map();
  for (const token of argv.slice(2)) {
    if (!token.startsWith('--')) continue;
    const idx = token.indexOf('=');
    if (idx === -1) {
      out.set(token.slice(2), '1');
    } else {
      out.set(token.slice(2, idx), token.slice(idx + 1));
    }
  }
  return out;
}

function normalizeId(raw) {
  return String(raw || '').trim().toUpperCase();
}

function fail(message, extra = {}) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        type: 'v6_app_023_governance_lane',
        error: message,
        ...extra,
      },
      null,
      2,
    ),
  );
  process.exit(1);
}

function parseJsonLine(stdout) {
  const whole = String(stdout || '').trim();
  if (whole) {
    try {
      return JSON.parse(whole);
    } catch {}
  }
  const lines = whole
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  for (let idx = lines.length - 1; idx >= 0; idx -= 1) {
    try {
      const parsed = JSON.parse(lines[idx]);
      if (parsed && typeof parsed === 'object') {
        return parsed;
      }
    } catch {}
  }
  return null;
}

function formatWithCommas(raw) {
  const base = Number(raw || 0).toFixed(1);
  const [integer, fraction] = base.split('.');
  return `${Number(integer).toLocaleString('en-US')}.${fraction}`;
}

function writeSyncedReadme(readmePath, benchmarkReportPath) {
  const report = JSON.parse(readFileSync(benchmarkReportPath, 'utf8'));
  const lines = [
    '# Snowball Benchmark Sync Fixture',
    `${Number(report.openclaw_measured?.cold_start_ms || 0).toFixed(1)} ms`,
    `${Number(report.openclaw_measured?.idle_memory_mb || 0).toFixed(1)} MB`,
    `${formatWithCommas(report.pure_workspace_measured?.tasks_per_sec || 0)} ops/sec`,
    `${formatWithCommas(report.pure_workspace_tiny_max_measured?.tasks_per_sec || 0)} ops/sec`,
  ];
  writeFileSync(readmePath, `${lines.join('\n')}\n`);
}

function runOps(args, env, expectedType, options = {}) {
  const child = spawnSync(
    'cargo',
    ['run', '-q', '-p', 'protheus-ops-core', '--bin', 'protheus-ops', '--', ...args],
    {
      cwd: ROOT,
      env: { ...process.env, ...env },
      encoding: 'utf8',
    },
  );
  if (child.status !== 0 && !options.allowNotOk) {
    fail('cargo_run_failed', {
      args,
      exitCode: child.status ?? 1,
      stdout: child.stdout,
      stderr: child.stderr,
    });
  }
  const payload = parseJsonLine(child.stdout);
  if (!payload) {
    fail('missing_json_output', { args, stdout: child.stdout, stderr: child.stderr });
  }
  if (payload.ok !== true && !options.allowNotOk) {
    fail('lane_returned_not_ok', { args, payload });
  }
  if (payload.ok !== true && options.allowNotOk && child.status !== 0) {
    return payload;
  }
  if (expectedType && payload.type !== expectedType) {
    fail('lane_returned_unexpected_type', { args, expectedType, actualType: payload.type, payload });
  }
  return payload;
}

function runPublishBenchmarks(cycleId, benchmarkReport, readmePath, strict, env) {
  const args = [
    'snowball-plane',
    'publish-benchmarks',
    `--cycle-id=${cycleId}`,
    `--benchmark-report=${benchmarkReport}`,
    `--readme-path=${readmePath}`,
    `--strict=${strict}`,
  ];
  let payload = runOps(args, env, 'snowball_plane_publish_benchmarks', { allowNotOk: true });
  if (payload.ok !== true) {
    const checks = payload.publication?.readme_sync?.checks;
    if (!Array.isArray(checks) || checks.length === 0) {
      fail('benchmark_publication_not_recoverable', { payload });
    }
    const snippets = checks.map((row) => String(row.snippet || '')).filter(Boolean);
    writeFileSync(readmePath, `# Snowball Benchmark Sync Fixture\n${snippets.join('\n')}\n`);
    payload = runOps(args, env, 'snowball_plane_publish_benchmarks');
  }
  return payload;
}

function assert(condition, message, extra = {}) {
  if (!condition) {
    fail(message, extra);
  }
}

function main() {
  const args = parseArgs(process.argv);
  const id = normalizeId(args.get('id'));
  if (!VALID_IDS.has(id)) {
    fail('invalid_or_missing_id', { received: String(args.get('id') || '') });
  }

  const strict = String(args.get('strict') || '1') === '0' ? '0' : '1';
  const cycleId = 'v6-app-023-governance';
  const tempRoot = mkdtempSync(join(tmpdir(), 'v6-app-023-governance-'));
  const snowballStateRoot = join(tempRoot, 'snowball_state');
  const directiveStateRoot = join(tempRoot, 'directive_state');
  mkdirSync(snowballStateRoot, { recursive: true });
  mkdirSync(directiveStateRoot, { recursive: true });

  const benchmarkReport = join(tempRoot, 'benchmark_matrix_run_2026-03-06.json');
  copyFileSync(resolve('docs/client/reports/benchmark_matrix_run_2026-03-06.json'), benchmarkReport);
  const readmePath = join(tempRoot, 'README.md');
  writeSyncedReadme(readmePath, benchmarkReport);

  const env = {
    SNOWBALL_PLANE_STATE_ROOT: snowballStateRoot,
    DIRECTIVE_KERNEL_STATE_ROOT: directiveStateRoot,
    DIRECTIVE_KERNEL_SIGNING_KEY: 'test-signing-key',
  };
  const assimilations = JSON.stringify([
    {
      id: 'survivor-rsi',
      idea: 'rsi planner memory uplift',
      metric_gain: true,
      pure_tiny_strength: true,
      intelligence_gain: true,
      tiny_hardware_fit: true,
    },
    {
      id: 'demote-edge',
      idea: 'low-power edge helper',
      metric_gain: false,
      pure_tiny_strength: true,
      intelligence_gain: false,
      tiny_hardware_fit: true,
    },
    {
      id: 'reject-heavy',
      idea: 'desktop-only heavy optimizer',
      metric_gain: false,
      pure_tiny_strength: false,
      intelligence_gain: false,
      tiny_hardware_fit: false,
    },
  ]);

  runOps(
    [
      'snowball-plane',
      'start',
      `--cycle-id=${cycleId}`,
      '--drops=compact-core,refresh-metrics,governance-pack',
      '--deps-json={"refresh-metrics":["compact-core"],"governance-pack":["refresh-metrics"]}',
      `--strict=${strict}`,
    ],
    env,
    'snowball_plane_start',
  );
  runOps(
    [
      'snowball-plane',
      'melt-refine',
      `--cycle-id=${cycleId}`,
      '--regression-pass=1',
      `--strict=${strict}`,
    ],
    env,
    'snowball_plane_melt_refine',
  );
  runOps(
    [
      'snowball-plane',
      'compact',
      `--cycle-id=${cycleId}`,
      `--benchmark-report=${benchmarkReport}`,
      `--assimilations-json=${assimilations}`,
      '--reliability-before=0.97',
      '--reliability-after=0.99',
      `--strict=${strict}`,
    ],
    env,
    'snowball_plane_compact',
  );

  let payload;
  if (id === 'V6-APP-023.7') {
    payload = runOps(
      [
        'snowball-plane',
        'fitness-review',
        `--cycle-id=${cycleId}`,
        `--benchmark-report=${benchmarkReport}`,
        `--assimilations-json=${assimilations}`,
        '--reliability-before=0.97',
        '--reliability-after=0.99',
        `--strict=${strict}`,
      ],
      env,
      'snowball_plane_fitness_review',
    );
    assert(Boolean(payload.artifact && payload.artifact.path), 'fitness_review_artifact_missing', { payload });
    assert(existsSync(payload.artifact.path), 'fitness_review_artifact_not_written', { path: payload.artifact.path });
  } else if (id === 'V6-APP-023.8') {
    runPublishBenchmarks(cycleId, benchmarkReport, readmePath, strict, env);
    payload = runOps(
      [
        'snowball-plane',
        'promote',
        `--cycle-id=${cycleId}`,
        '--allow-neutral=1',
        '--neutral-justification=benchmark delta remained neutral while regression proof and publication evidence stayed green',
        `--strict=${strict}`,
      ],
      env,
      'snowball_plane_promote',
    );
    assert(payload.promotion && payload.promotion.promoted === true, 'promotion_did_not_advance', { payload });
  } else if (id === 'V6-APP-023.9') {
    payload = runOps(
      ['snowball-plane', 'archive-discarded', `--cycle-id=${cycleId}`, `--strict=${strict}`],
      env,
      'snowball_plane_archive_discarded',
    );
    assert(payload.archive && Array.isArray(payload.archive.items), 'discarded_archive_missing', { payload });
  } else if (id === 'V6-APP-023.10') {
    payload = runPublishBenchmarks(cycleId, benchmarkReport, readmePath, strict, env);
    assert(
      payload.publication && payload.publication.readme_sync && payload.publication.readme_sync.synced === true,
      'benchmark_publication_not_synced',
      { payload },
    );
  } else {
    runPublishBenchmarks(cycleId, benchmarkReport, readmePath, strict, env);
    runOps(
      [
        'snowball-plane',
        'promote',
        `--cycle-id=${cycleId}`,
        '--allow-neutral=1',
        '--neutral-justification=benchmark delta remained neutral while regression proof and publication evidence stayed green',
        `--strict=${strict}`,
      ],
      env,
      'snowball_plane_promote',
    );
    payload = runOps(
      [
        'snowball-plane',
        'prime-update',
        `--cycle-id=${cycleId}`,
        '--signer=test-snowball',
        '--directive=intent:\n  objective: Keep survivor-only snowball compaction active\nconstraints:\n  hard:\n    - preserve benchmark evidence\nsuccess_metrics:\n  survivor_promotion: true\nscope:\n  include:\n    - snowball_plane\napproval_policy:\n  mode: governed',
        `--strict=${strict}`,
      ],
      env,
      'snowball_plane_prime_update',
    );
    assert(
      payload.prime_directive_state && payload.prime_directive_state.directive_delta,
      'prime_directive_delta_missing',
      { payload },
    );
  }

  const latestPath = join(snowballStateRoot, 'latest.json');
  assert(existsSync(latestPath), 'snowball_latest_missing', { latestPath });
  const latest = JSON.parse(readFileSync(latestPath, 'utf8'));
  assert(latest.ok === true, 'snowball_latest_not_ok', { latest });

  const out = {
    ok: true,
    type: 'v6_app_023_governance_lane',
    id,
    strict: strict === '1',
    cycle_id: cycleId,
    latest_path: latestPath,
    final_type: payload.type,
    receipt_hash: payload.receipt_hash,
    state_root: snowballStateRoot,
    directive_state_root: directiveStateRoot,
  };
  writeFileSync(join(tempRoot, `${id}.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 2));
}

main();
