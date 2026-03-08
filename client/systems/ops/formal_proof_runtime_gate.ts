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
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.FORMAL_PROOF_RUNTIME_GATE_POLICY_PATH
  ? path.resolve(process.env.FORMAL_PROOF_RUNTIME_GATE_POLICY_PATH)
  : path.join(ROOT, 'client', 'config', 'formal_proof_runtime_gate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node client/systems/ops/formal_proof_runtime_gate.js run [--strict=1|0] [--runner=local|docker] [--policy=<path>]');
  console.log('  node client/systems/ops/formal_proof_runtime_gate.js status [--policy=<path>]');
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
    commands: [
      {
        id: 'formal_spec_guard',
        bin: 'npm',
        args: ['run', '-s', 'ops:formal-spec:check'],
        required: true,
        timeout_ms: 180000
      },
      {
        id: 'critical_path_formal',
        bin: 'node',
        args: ['client/systems/security/critical_path_formal_verifier.js', 'run', '--strict=1'],
        required: true,
        timeout_ms: 180000
      },
      {
        id: 'formal_invariants',
        bin: 'npm',
        args: ['run', '-s', 'formal:invariants:run'],
        required: true,
        timeout_ms: 180000
      },
      {
        id: 'critical_protocol_suite',
        bin: 'node',
        args: ['client/systems/ops/critical_protocol_formal_suite.js', 'run', '--strict=1'],
        required: true,
        timeout_ms: 180000
      },
      {
        id: 'kani_toolchain',
        bin: 'cargo',
        args: ['kani', '--version'],
        required: false,
        timeout_ms: 30000
      },
      {
        id: 'prusti_toolchain',
        bin: 'prusti-rustc',
        args: ['--version'],
        required: false,
        timeout_ms: 30000
      },
      {
        id: 'lean_toolchain',
        bin: 'lean',
        args: ['--version'],
        required: false,
        timeout_ms: 30000
      }
    ],
    paths: {
      latest_path: 'client/local/state/ops/formal_proof_runtime_gate/latest.json',
      receipts_path: 'client/local/state/ops/formal_proof_runtime_gate/receipts.jsonl',
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

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const docker = raw.docker && typeof raw.docker === 'object' ? raw.docker : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const commands = Array.isArray(raw.commands) ? raw.commands : base.commands;
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
    commands: commands.map((row: any) => ({
      id: normalizeToken(row.id || '', 80) || `proof_${Math.random().toString(36).slice(2, 10)}`,
      bin: cleanText(row.bin || '', 120),
      args: Array.isArray(row.args) ? row.args.map((v: unknown) => cleanText(v, 240)).filter(Boolean) : [],
      required: toBool(row.required, true),
      timeout_ms: clampInt(row.timeout_ms, 1000, 600000, 180000)
    })).filter((row: any) => row.bin),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      proof_pack_dir: resolvePath(paths.proof_pack_dir, base.paths.proof_pack_dir)
    }
  };
}

function runCmd(row: any, runner: string, dockerCfg: any) {
  const localRun = () => spawnSync(row.bin, row.args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: row.timeout_ms,
    env: process.env
  });

  if (runner !== 'docker') {
    return localRun();
  }

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
    row.bin,
    ...row.args
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: row.timeout_ms,
    env: process.env
  });
}

function runGate(args: any, policy: any) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const requestedRunner = normalizeToken(args.runner || policy.runner_default, 24);
  const runner = requestedRunner === 'docker' ? 'docker' : 'local';

  const commands = policy.commands.map((row: any) => {
    const started = Date.now();
    const proc = runCmd(row, runner, policy.docker);
    const elapsedMs = Date.now() - started;
    const payload = parseJson(proc.stdout || '');
    const missingTool = String(proc.stderr || '').includes('not found') || String(proc.error && proc.error.message || '').includes('ENOENT') || String(proc.stderr || '').includes('docker_unavailable');
    const status = Number.isFinite(proc.status) ? Number(proc.status) : 1;
    const ok = status === 0;
    return {
      id: row.id,
      required: row.required === true,
      ok,
      status,
      elapsed_ms: elapsedMs,
      runner,
      missing_toolchain: missingTool,
      stdout_summary: cleanText(proc.stdout || '', 400),
      stderr_summary: cleanText(proc.stderr || '', 400),
      payload
    };
  });

  const requiredFailed = commands.filter((row: any) => row.required && row.ok !== true).map((row: any) => row.id);
  const optionalMissing = commands.filter((row: any) => row.required !== true && row.missing_toolchain === true).map((row: any) => row.id);
  const ok = requiredFailed.length === 0;
  const ts = nowIso();
  const out = {
    ok,
    type: 'formal_proof_runtime_gate',
    ts,
    strict,
    shadow_only: policy.shadow_only,
    runner,
    git_head: gitHead(),
    required_failed: requiredFailed,
    optional_missing_toolchains: optionalMissing,
    commands
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);

  const stamp = ts.replace(/[:.]/g, '-');
  const proofArtifactPath = path.join(policy.paths.proof_pack_dir, `formal_proof_runtime_${stamp}.json`);
  writeJsonAtomic(proofArtifactPath, out);
  writeJsonAtomic(path.join(policy.paths.proof_pack_dir, 'formal_proof_runtime_latest.json'), out);
  out.proof_artifact = path.relative(ROOT, proofArtifactPath).replace(/\\/g, '/');

  if (strict && !ok) emit(out, 1);
  emit(out);
}

function status(policy: any) {
  emit({
    ok: true,
    type: 'formal_proof_runtime_gate_status',
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
  if (!policy.enabled) emit({ ok: false, error: 'formal_proof_runtime_gate_disabled' }, 1);

  if (cmd === 'run') return runGate(args, policy);
  if (cmd === 'status') return status(policy);
  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
