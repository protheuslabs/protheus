#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  clampNumber,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.PROOF_PACK_THRESHOLD_GATE_POLICY_PATH
  ? path.resolve(process.env.PROOF_PACK_THRESHOLD_GATE_POLICY_PATH)
  : path.join(ROOT, 'client', 'config', 'proof_pack_threshold_gate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node client/systems/ops/proof_pack_threshold_gate.js run [--strict=1|0] [--runner=local|docker] [--policy=<path>]');
  console.log('  node client/systems/ops/proof_pack_threshold_gate.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_default: true,
    runner_default: 'local',
    docker: {
      image: 'node:22-bookworm',
      workspace_mount: '/workspace'
    },
    commands: {
      mech_benchmark: {
        bin: 'node',
        args: ['client/systems/ops/mech_suit_benchmark.js', 'run'],
        timeout_ms: 360000
      },
      harness_6m: {
        bin: 'node',
        args: ['client/systems/autonomy/autonomy_simulation_harness.js', 'run', '--days=180', '--strict=0', '--write=1'],
        timeout_ms: 240000
      },
      protheus_vs_openclaw: {
        bin: 'node',
        args: ['client/systems/ops/narrow_agent_parity_harness.js', 'run', '--days=180', '--strict=0'],
        timeout_ms: 240000
      },
      formal_invariants: {
        bin: 'npm',
        args: ['run', '-s', 'formal:invariants:run'],
        timeout_ms: 180000
      }
    },
    thresholds: {
      mech_min_token_reduction_pct: 15,
      mech_require_ambient_mode: true,
      mech_require_no_host_timeout: true,
      harness_allowed_verdicts: ['pass', 'warn'],
      harness_min_shipped: 5,
      parity_min_pass_ratio: 0.3333,
      parity_min_weighted_score_avg: 0.74,
      parity_allow_insufficient_data: true,
      invariants_require_ok: true
    },
    paths: {
      latest_path: 'client/local/state/ops/proof_pack_threshold_gate/latest.json',
      receipts_path: 'client/local/state/ops/proof_pack_threshold_gate/receipts.jsonl',
      proof_pack_dir: 'client/docs/reports/runtime_snapshots/ops/proof_pack'
    }
  };
}

function parseJson(stdout: string) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function readGitHeadFromDotGit(repoRoot: string) {
  try {
    const gitDir = path.join(repoRoot, '.git');
    const headPath = path.join(gitDir, 'HEAD');
    if (!fs.existsSync(headPath)) return null;
    const headRaw = cleanText(fs.readFileSync(headPath, 'utf8'), 512);
    if (!headRaw) return null;
    if (!headRaw.startsWith('ref:')) {
      const detached = cleanText(headRaw, 80);
      return detached || null;
    }
    const ref = cleanText(headRaw.slice(4), 400);
    if (!ref) return null;
    const refPath = path.join(gitDir, ref);
    if (fs.existsSync(refPath)) {
      const hash = cleanText(fs.readFileSync(refPath, 'utf8'), 80);
      if (hash) return hash;
    }
    const packedRefs = path.join(gitDir, 'packed-refs');
    if (fs.existsSync(packedRefs)) {
      const lines = String(fs.readFileSync(packedRefs, 'utf8') || '').split('\n');
      for (const line of lines) {
        const txt = String(line || '').trim();
        if (!txt || txt.startsWith('#') || txt.startsWith('^')) continue;
        const parts = txt.split(' ');
        if (parts.length < 2) continue;
        if (parts[1] === ref) {
          const hash = cleanText(parts[0], 80);
          if (hash) return hash;
        }
      }
    }
  } catch {}
  return null;
}

function gitHead() {
  const envHead = cleanText(process.env.GITHUB_SHA || process.env.PROTHEUS_GIT_HEAD || '', 80);
  if (envHead) return envHead;
  const roots = Array.from(
    new Set([
      ROOT,
      process.cwd(),
      path.resolve(ROOT, '..'),
      path.resolve(ROOT, '..', '..')
    ])
  );
  for (const cwd of roots) {
    const dotGitHead = readGitHeadFromDotGit(cwd);
    if (dotGitHead) return dotGitHead;
  }
  const gitBins = ['git', '/usr/bin/git', '/opt/homebrew/bin/git'];
  for (const cwd of roots) {
    for (const gitBin of gitBins) {
      const run = spawnSync(gitBin, ['rev-parse', 'HEAD'], { cwd, encoding: 'utf8', timeout: 15000 });
      if (Number(run.status || 1) === 0) {
        const head = cleanText(run.stdout || '', 80);
        if (head) return head;
      }
    }
    const shellRun = spawnSync(process.env.SHELL || '/bin/sh', ['-lc', 'git rev-parse HEAD'], {
      cwd,
      encoding: 'utf8',
      timeout: 15000
    });
    if (Number(shellRun.status || 1) === 0) {
      const head = cleanText(shellRun.stdout || '', 80);
      if (head) return head;
    }
  }
  return null;
}

function normalizeCommand(raw: any, fallback: any) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    bin: cleanText(src.bin || fallback.bin, 120),
    args: Array.isArray(src.args) ? src.args.map((v: unknown) => cleanText(v, 240)).filter(Boolean) : fallback.args.slice(0),
    timeout_ms: clampInt(src.timeout_ms, 1000, 900000, fallback.timeout_ms)
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const docker = raw.docker && typeof raw.docker === 'object' ? raw.docker : {};
  const thresholds = raw.thresholds && typeof raw.thresholds === 'object' ? raw.thresholds : {};
  const commandsRaw = raw.commands && typeof raw.commands === 'object' ? raw.commands : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    runner_default: normalizeToken(raw.runner_default || base.runner_default, 24) || 'local',
    docker: {
      image: cleanText(docker.image || base.docker.image, 120) || base.docker.image,
      workspace_mount: cleanText(docker.workspace_mount || base.docker.workspace_mount, 120) || base.docker.workspace_mount
    },
    commands: {
      mech_benchmark: normalizeCommand(commandsRaw.mech_benchmark, base.commands.mech_benchmark),
      harness_6m: normalizeCommand(commandsRaw.harness_6m, base.commands.harness_6m),
      protheus_vs_openclaw: normalizeCommand(commandsRaw.protheus_vs_openclaw, base.commands.protheus_vs_openclaw),
      formal_invariants: normalizeCommand(commandsRaw.formal_invariants, base.commands.formal_invariants)
    },
    thresholds: {
      mech_min_token_reduction_pct: clampNumber(thresholds.mech_min_token_reduction_pct, 0, 100, base.thresholds.mech_min_token_reduction_pct),
      mech_require_ambient_mode: toBool(thresholds.mech_require_ambient_mode, base.thresholds.mech_require_ambient_mode),
      mech_require_no_host_timeout: toBool(thresholds.mech_require_no_host_timeout, base.thresholds.mech_require_no_host_timeout),
      harness_allowed_verdicts: Array.isArray(thresholds.harness_allowed_verdicts) && thresholds.harness_allowed_verdicts.length
        ? thresholds.harness_allowed_verdicts.map((v: unknown) => normalizeToken(v, 16)).filter(Boolean)
        : base.thresholds.harness_allowed_verdicts.slice(0),
      harness_min_shipped: clampInt(thresholds.harness_min_shipped, 0, 100000, base.thresholds.harness_min_shipped),
      parity_min_pass_ratio: clampNumber(thresholds.parity_min_pass_ratio, 0, 1, base.thresholds.parity_min_pass_ratio),
      parity_min_weighted_score_avg: clampNumber(thresholds.parity_min_weighted_score_avg, 0, 1, base.thresholds.parity_min_weighted_score_avg),
      parity_allow_insufficient_data: toBool(thresholds.parity_allow_insufficient_data, base.thresholds.parity_allow_insufficient_data),
      invariants_require_ok: toBool(thresholds.invariants_require_ok, base.thresholds.invariants_require_ok)
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      proof_pack_dir: resolvePath(paths.proof_pack_dir, base.paths.proof_pack_dir)
    }
  };
}

function runCommand(cmd: any, runner: string, dockerCfg: any) {
  const runLocal = () => spawnSync(cmd.bin, cmd.args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: cmd.timeout_ms,
    env: process.env
  });

  if (runner !== 'docker') return runLocal();

  const dockerCheck = spawnSync('docker', ['--version'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000
  });
  if (Number(dockerCheck.status || 1) !== 0) {
    return {
      status: 127,
      stdout: '',
      stderr: 'docker_unavailable',
      error: new Error('docker_unavailable')
    };
  }

  const mount = cleanText(dockerCfg.workspace_mount || '/workspace', 120) || '/workspace';
  return spawnSync('docker', [
    'run',
    '--rm',
    '-v',
    `${ROOT}:${mount}`,
    '-w',
    mount,
    cleanText(dockerCfg.image || 'node:22-bookworm', 120) || 'node:22-bookworm',
    cmd.bin,
    ...cmd.args
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: cmd.timeout_ms,
    env: process.env
  });
}

function execWithMeta(id: string, cmd: any, runner: string, dockerCfg: any) {
  const started = Date.now();
  const proc = runCommand(cmd, runner, dockerCfg);
  const elapsed = Date.now() - started;
  const status = Number.isFinite(proc.status) ? Number(proc.status) : 1;
  return {
    id,
    ok: status === 0,
    status,
    elapsed_ms: elapsed,
    stdout_summary: cleanText(proc.stdout || '', 400),
    stderr_summary: cleanText(proc.stderr || '', 400),
    payload: parseJson(proc.stdout || '')
  };
}

function getNum(v: unknown, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function runGate(args: any, policy: any) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const requestedRunner = normalizeToken(args.runner || policy.runner_default, 24);
  const runner = requestedRunner === 'docker' ? 'docker' : 'local';

  const mechRun = execWithMeta('mech_benchmark', policy.commands.mech_benchmark, runner, policy.docker);
  const harnessRun = execWithMeta('harness_6m', policy.commands.harness_6m, runner, policy.docker);
  const parityRun = execWithMeta('protheus_vs_openclaw', policy.commands.protheus_vs_openclaw, runner, policy.docker);
  const invariantsRun = execWithMeta('formal_invariants', policy.commands.formal_invariants, runner, policy.docker);

  const mech = mechRun.payload && typeof mechRun.payload === 'object' ? mechRun.payload : {};
  const mechReduction = getNum(
    mech.summary && mech.summary.token_burn_reduction_pct != null
      ? mech.summary.token_burn_reduction_pct
      : mech.token_burn_reduction_pct,
    0
  );
  const mechAmbient = mech.ambient_mode_active === true;
  const mechHostTimeout = mech.host_fault && mech.host_fault.timeout_detected === true;

  const harness = harnessRun.payload && typeof harnessRun.payload === 'object' ? harnessRun.payload : {};
  const harnessVerdict = normalizeToken(harness.verdict_effective || harness.verdict || '', 24);
  const harnessShipped = getNum(
    harness.effective_counters && harness.effective_counters.shipped != null
      ? harness.effective_counters.shipped
      : harness.counters && harness.counters.shipped,
    0
  );

  const parity = parityRun.payload && typeof parityRun.payload === 'object' ? parityRun.payload : {};
  const parityPassRatio = getNum(parity.aggregate && parity.aggregate.pass_ratio, 0);
  const parityWeighted = getNum(parity.aggregate && parity.aggregate.weighted_score_avg, 0);
  const insufficientData = !!(parity.insufficient_data && parity.insufficient_data.active === true);

  const invariants = invariantsRun.payload && typeof invariantsRun.payload === 'object' ? invariantsRun.payload : {};

  const checks = {
    mech_command_ok: mechRun.ok === true,
    mech_token_reduction_threshold: mechReduction >= policy.thresholds.mech_min_token_reduction_pct,
    mech_ambient_mode: policy.thresholds.mech_require_ambient_mode ? mechAmbient : true,
    mech_no_host_timeout: policy.thresholds.mech_require_no_host_timeout ? !mechHostTimeout : true,
    harness_command_ok: harnessRun.ok === true,
    harness_verdict_allowed: policy.thresholds.harness_allowed_verdicts.includes(harnessVerdict),
    harness_min_shipped: harnessShipped >= policy.thresholds.harness_min_shipped,
    parity_command_ok: parityRun.ok === true,
    parity_pass_ratio: parityPassRatio >= policy.thresholds.parity_min_pass_ratio,
    parity_weighted_score: parityWeighted >= policy.thresholds.parity_min_weighted_score_avg,
    parity_insufficient_data_policy: policy.thresholds.parity_allow_insufficient_data ? true : !insufficientData,
    invariants_command_ok: invariantsRun.ok === true,
    invariants_ok: policy.thresholds.invariants_require_ok ? invariants.ok === true : true
  };

  const failed = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const ok = failed.length === 0;
  const ts = nowIso();
  const out = {
    ok,
    type: 'proof_pack_threshold_gate',
    ts,
    strict,
    shadow_only: policy.shadow_only,
    runner,
    git_head: gitHead(),
    checks,
    failed_checks: failed,
    metrics: {
      mech_token_reduction_pct: mechReduction,
      mech_ambient_mode_active: mechAmbient,
      mech_host_timeout_detected: mechHostTimeout,
      harness_verdict: harnessVerdict,
      harness_shipped: harnessShipped,
      parity_pass_ratio: parityPassRatio,
      parity_weighted_score_avg: parityWeighted,
      parity_insufficient_data_active: insufficientData,
      invariants_ok: invariants.ok === true
    },
    runs: {
      mech_benchmark: mechRun,
      harness_6m: harnessRun,
      protheus_vs_openclaw: parityRun,
      formal_invariants: invariantsRun
    }
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);

  const stamp = ts.replace(/[:.]/g, '-');
  const artifactPath = path.join(policy.paths.proof_pack_dir, `threshold_gate_${stamp}.json`);
  writeJsonAtomic(artifactPath, out);
  writeJsonAtomic(path.join(policy.paths.proof_pack_dir, 'threshold_gate_latest.json'), out);
  out.proof_artifact = path.relative(ROOT, artifactPath).replace(/\\/g, '/');

  if (strict && !ok) emit(out, 1);
  emit(out);
}

function status(policy: any) {
  emit({
    ok: true,
    type: 'proof_pack_threshold_gate_status',
    latest: readJson(policy.paths.latest_path, {})
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 60) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'proof_pack_threshold_gate_disabled' }, 1);

  if (cmd === 'run') return runGate(args, policy);
  if (cmd === 'status') return status(policy);
  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
