#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-CONF-005
 * N-API build surface compatibility contract.
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.NAPI_BUILD_SURFACE_COMPAT_POLICY_PATH
  ? path.resolve(process.env.NAPI_BUILD_SURFACE_COMPAT_POLICY_PATH)
  : path.join(ROOT, 'config', 'napi_build_surface_compat_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/napi_build_surface_compat.js build [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/memory/napi_build_surface_compat.js postinstall [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/memory/napi_build_surface_compat.js status [--policy=<path>]');
}

function parseJsonFromStdout(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function normalizeList(v: unknown) {
  if (Array.isArray(v)) return v.map((row) => cleanText(row, 280)).filter(Boolean);
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return raw.split(',').map((row) => cleanText(row, 280)).filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    default_runtime_transport: 'daemon_first',
    strict_build_requires_cargo: false,
    commands: {
      rust_build: ['cargo', 'build', '--manifest-path', 'systems/memory/rust/Cargo.toml', '--release'],
      rust_probe: ['cargo', 'run', '--quiet', '--manifest-path', 'systems/memory/rust/Cargo.toml', '--', 'probe', '--root=.']
    },
    matrix: {
      profiles: [
        {
          id: 'daemon_first',
          role: 'production_default',
          description: 'Daemon-first transport with deterministic fallback (napi -> daemon -> cli -> js emergency).',
          run_command: 'node systems/memory/memory_recall.js query --q="probe" --top=1'
        },
        {
          id: 'napi_optional',
          role: 'performance_optional',
          description: 'In-process N-API lane when native module exists; fallback remains daemon/cli.',
          run_command: 'MEMORY_RECALL_RUST_NAPI_ENABLED=1 node systems/memory/memory_recall.js query --q="probe" --top=1'
        },
        {
          id: 'cli_compat',
          role: 'legacy_compat',
          description: 'Direct Rust CLI path for compatibility and diagnostics.',
          run_command: 'cargo run --manifest-path systems/memory/rust/Cargo.toml -- query-index --q probe --root=.'
        }
      ]
    },
    paths: {
      state_path: 'state/memory/napi_build_surface_compat/state.json',
      latest_path: 'state/memory/napi_build_surface_compat/latest.json',
      receipts_path: 'state/memory/napi_build_surface_compat/receipts.jsonl',
      matrix_json_path: 'state/memory/napi_build_surface_compat/build_matrix.json',
      matrix_md_path: 'docs/MEMORY_BUILD_SURFACE.md'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const commands = raw.commands && typeof raw.commands === 'object' ? raw.commands : {};
  const matrix = raw.matrix && typeof raw.matrix === 'object' ? raw.matrix : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const profilesRaw = Array.isArray(matrix.profiles) ? matrix.profiles : base.matrix.profiles;
  const profiles = profilesRaw
    .map((row: any) => ({
      id: cleanText(row && row.id || '', 80),
      role: cleanText(row && row.role || '', 80),
      description: cleanText(row && row.description || '', 420),
      run_command: cleanText(row && row.run_command || '', 520)
    }))
    .filter((row: any) => row.id && row.run_command);

  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: toBool(raw.enabled, true),
    default_runtime_transport: cleanText(raw.default_runtime_transport || base.default_runtime_transport, 80) || base.default_runtime_transport,
    strict_build_requires_cargo: toBool(raw.strict_build_requires_cargo, base.strict_build_requires_cargo),
    commands: {
      rust_build: normalizeList(commands.rust_build || base.commands.rust_build),
      rust_probe: normalizeList(commands.rust_probe || base.commands.rust_probe)
    },
    matrix: {
      profiles: profiles.length > 0 ? profiles : base.matrix.profiles
    },
    paths: {
      state_path: resolvePath(paths.state_path || base.paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path || base.paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path || base.paths.receipts_path, base.paths.receipts_path),
      matrix_json_path: resolvePath(paths.matrix_json_path || base.paths.matrix_json_path, base.paths.matrix_json_path),
      matrix_md_path: resolvePath(paths.matrix_md_path || base.paths.matrix_md_path, base.paths.matrix_md_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function runCommand(command: string[], timeoutMs = 120_000) {
  const cmd = Array.isArray(command) ? command.slice(0) : [];
  if (cmd.length < 1) return { ok: false, status: 127, error: 'missing_command', payload: null };
  const proc = spawnSync(cmd[0], cmd.slice(1), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const payload = parseJsonFromStdout(proc.stdout);
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    payload,
    stdout: cleanText(proc.stdout || '', 600),
    stderr: cleanText(proc.stderr || '', 600)
  };
}

function markdownForMatrix(policy: Record<string, any>, result: Record<string, any>) {
  const rows = policy.matrix.profiles || [];
  const lines = [];
  lines.push('# Memory Build Surface Compatibility');
  lines.push('');
  lines.push(`Generated: ${nowIso()}`);
  lines.push('');
  lines.push(`Default runtime transport: \`${cleanText(policy.default_runtime_transport, 80)}\``);
  lines.push('');
  lines.push('| Profile | Role | Run Command |');
  lines.push('|---|---|---|');
  for (const row of rows) {
    lines.push(`| ${row.id} | ${row.role} | \`${String(row.run_command || '').replace(/\|/g, '\\|')}\` |`);
  }
  lines.push('');
  lines.push('## Build Checks');
  lines.push('');
  lines.push(`- Rust build ok: ${result.rust_build_ok === true ? 'yes' : 'no'}`);
  lines.push(`- Rust probe ok: ${result.rust_probe_ok === true ? 'yes' : 'no'}`);
  lines.push(`- Daemon-first default enforced: ${result.daemon_first_default === true ? 'yes' : 'no'}`);
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function loadState(policy: Record<string, any>) {
  const src = readJson(policy.paths.state_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'napi_build_surface_compat_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      build_runs: 0,
      postinstall_runs: 0,
      last_result: null
    };
  }
  return {
    schema_id: 'napi_build_surface_compat_state',
    schema_version: '1.0',
    updated_at: src.updated_at || nowIso(),
    build_runs: Math.max(0, Number(src.build_runs || 0)),
    postinstall_runs: Math.max(0, Number(src.postinstall_runs || 0)),
    last_result: src.last_result || null
  };
}

function saveState(policy: Record<string, any>, state: Record<string, any>) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'napi_build_surface_compat_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    build_runs: Math.max(0, Number(state.build_runs || 0)),
    postinstall_runs: Math.max(0, Number(state.postinstall_runs || 0)),
    last_result: state.last_result || null
  });
}

function evaluateBuild(policy: Record<string, any>, options: Record<string, any>) {
  const apply = options.apply === true;
  const strict = options.strict === true;
  const rustBuild = apply ? runCommand(policy.commands.rust_build) : { ok: true, status: 0, payload: null, stdout: 'dry_run', stderr: '' };
  const rustProbe = runCommand(policy.commands.rust_probe);
  const daemonDefault = cleanText(policy.default_runtime_transport, 80) === 'daemon_first';

  const out = {
    ok: daemonDefault && rustProbe.ok && (rustBuild.ok || (!strict && policy.strict_build_requires_cargo !== true)),
    type: 'napi_build_surface_compat_build',
    ts: nowIso(),
    apply,
    strict,
    daemon_first_default: daemonDefault,
    rust_build_ok: rustBuild.ok,
    rust_probe_ok: rustProbe.ok,
    rust_build_status: rustBuild.status,
    rust_probe_status: rustProbe.status
  };

  const matrix = {
    schema_id: 'memory_build_surface_matrix',
    schema_version: '1.0',
    generated_at: nowIso(),
    default_runtime_transport: policy.default_runtime_transport,
    profiles: policy.matrix.profiles,
    checks: {
      rust_build_ok: out.rust_build_ok,
      rust_probe_ok: out.rust_probe_ok,
      daemon_first_default: out.daemon_first_default
    }
  };
  writeJsonAtomic(policy.paths.matrix_json_path, matrix);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  writeJsonAtomic(policy.paths.matrix_md_path, { placeholder: false }); // guard for path existence in write below
  const md = markdownForMatrix(policy, out);
  require('fs').writeFileSync(policy.paths.matrix_md_path, md, 'utf8');

  const state = loadState(policy);
  state.build_runs += 1;
  state.last_result = out;
  saveState(policy, state);
  return out;
}

function runPostinstall(policy: Record<string, any>, options: Record<string, any>) {
  const apply = options.apply === true;
  const strict = options.strict === true;
  const result = evaluateBuild(policy, { apply, strict });
  const out = {
    ok: result.ok,
    type: 'napi_build_surface_compat_postinstall',
    ts: nowIso(),
    apply,
    strict,
    build_result: result,
    guidance: {
      npm_script_build_memory: 'npm run build:memory',
      npm_script_postinstall_memory: 'npm run postinstall:memory',
      production_runtime_default: 'daemon_first'
    }
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  const state = loadState(policy);
  state.postinstall_runs += 1;
  state.last_result = out;
  saveState(policy, state);
  return out;
}

function runStatus(policy: Record<string, any>) {
  const state = loadState(policy);
  emit({
    ok: true,
    type: 'napi_build_surface_compat_status',
    state,
    matrix_json_path: policy.paths.matrix_json_path,
    matrix_md_path: policy.paths.matrix_md_path,
    default_runtime_transport: policy.default_runtime_transport
  }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) emit({ ok: false, error: 'policy_disabled' }, 2);
  const apply = toBool(args.apply, cmd !== 'status');
  const strict = toBool(args.strict, false);
  if (cmd === 'build') return emit(evaluateBuild(policy, { apply, strict }), 0);
  if (cmd === 'postinstall') return emit(runPostinstall(policy, { apply, strict }), 0);
  if (cmd === 'status') return runStatus(policy);
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

main();
