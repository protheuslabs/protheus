#!/usr/bin/env node
'use strict';
export {};

/**
 * nursery_bootstrap.js
 *
 * Creates and maintains the local LLM nursery/containment scaffold.
 * Keeps model binaries outside git-tracked workspace by default.
 *
 * Usage:
 *   node systems/nursery/nursery_bootstrap.js run [--policy=path] [--root=path] [--strict] [--no-pull]
 *   node systems/nursery/nursery_bootstrap.js status [--policy=path] [--root=path]
 *   node systems/nursery/nursery_bootstrap.js --help
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const {
  listLocalOllamaModels,
  pullLocalOllamaModel,
  normalizeModelName
} = require('../routing/llm_gateway');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'nursery_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'nursery');
const DEFAULT_STATE_PATH = path.join(DEFAULT_STATE_DIR, 'bootstrap_state.json');
const DEFAULT_HISTORY_PATH = path.join(DEFAULT_STATE_DIR, 'bootstrap_history.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/nursery/nursery_bootstrap.js run [--policy=path] [--root=path] [--strict] [--no-pull]');
  console.log('  node systems/nursery/nursery_bootstrap.js status [--policy=path] [--root=path]');
  console.log('  node systems/nursery/nursery_bootstrap.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function normalizeRelPath(rel) {
  const out = String(rel || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!out || out === '.' || out.includes('..')) return '';
  return out;
}

function expandTilde(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  if (raw === '~') return os.homedir();
  if (raw.startsWith('~/')) return path.join(os.homedir(), raw.slice(2));
  return raw;
}

function resolvePathFrom(baseDir, input) {
  const expanded = expandTilde(input);
  if (!expanded) return '';
  if (path.isAbsolute(expanded)) return path.resolve(expanded);
  return path.resolve(baseDir, expanded);
}

function boolFlag(value, fallback) {
  if (value == null) return fallback;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return Math.floor(n);
}

function relToRoot(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function isInside(baseDir, targetPath) {
  const rel = path.relative(baseDir, targetPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    auto_run_on_spine_init: true,
    strict_missing_required_models: false,
    root_dir: '~/.openclaw/nursery',
    fallback_repo_root_dir: 'state/nursery/containment',
    pull_timeout_ms: 60000,
    directories: {
      seeds: 'seeds',
      manifests: 'manifests',
      quarantine: 'quarantine',
      quarantine_checkpoints: 'quarantine/checkpoints',
      quarantine_training_data: 'quarantine/training-data',
      quarantine_evaluation_results: 'quarantine/evaluation-results',
      containment: 'containment',
      promotion: 'promotion',
      promotion_shadow_mode: 'promotion/shadow-mode',
      promotion_apprentice_mode: 'promotion/apprentice-mode',
      promotion_full_integration: 'promotion/full-integration',
      logs: 'logs'
    },
    containment: {
      policy_gates: {
        fs_scope: 'nursery_root_only',
        network_access: 'restricted',
        execution_mode: 'sandboxed',
        requires_human_promotion: true
      },
      permissions: {
        max_ram_mb: 2048,
        max_train_minutes: 30,
        cpu_only: true,
        allow_external_network_for_downloads: true
      }
    },
    model_artifacts: [
      {
        id: 'tinyllama_seed',
        provider: 'ollama',
        model: 'tinyllama:1.1b-chat-v1-q4_K_M',
        required: true,
        auto_pull: true
      },
      {
        id: 'red_team_seed',
        provider: 'ollama',
        model: 'qwen2.5:3b-instruct-q4_K_M',
        required: false,
        auto_pull: false
      }
    ]
  };
}

function normalizeArtifacts(rawArtifacts) {
  const rows = Array.isArray(rawArtifacts) ? rawArtifacts : [];
  const out = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim() || `artifact_${out.length + 1}`;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      provider: String(row.provider || 'ollama').trim().toLowerCase(),
      model: String(row.model || '').trim(),
      required: boolFlag(row.required, false),
      auto_pull: boolFlag(row.auto_pull, true)
    });
  }
  return out;
}

function normalizePolicy(rawPolicy) {
  const base = defaultPolicy();
  const raw = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const directories = {
    ...base.directories,
    ...(raw.directories && typeof raw.directories === 'object' ? raw.directories : {})
  };
  const normalizedDirs = {};
  for (const [key, val] of Object.entries(directories)) {
    const rel = normalizeRelPath(val);
    normalizedDirs[key] = rel || base.directories[key] || key;
  }

  return {
    ...base,
    ...raw,
    version: String(raw.version || base.version),
    enabled: boolFlag(raw.enabled, base.enabled),
    auto_run_on_spine_init: boolFlag(raw.auto_run_on_spine_init, base.auto_run_on_spine_init),
    strict_missing_required_models: boolFlag(raw.strict_missing_required_models, base.strict_missing_required_models),
    root_dir: String(raw.root_dir || base.root_dir),
    fallback_repo_root_dir: String(raw.fallback_repo_root_dir || base.fallback_repo_root_dir),
    pull_timeout_ms: clampInt(raw.pull_timeout_ms, 5000, 15 * 60 * 1000, base.pull_timeout_ms),
    directories: normalizedDirs,
    containment: {
      policy_gates: {
        ...base.containment.policy_gates,
        ...(raw.containment && raw.containment.policy_gates && typeof raw.containment.policy_gates === 'object'
          ? raw.containment.policy_gates
          : {})
      },
      permissions: {
        ...base.containment.permissions,
        ...(raw.containment && raw.containment.permissions && typeof raw.containment.permissions === 'object'
          ? raw.containment.permissions
          : {})
      }
    },
    model_artifacts: normalizeArtifacts(raw.model_artifacts)
  };
}

function loadPolicy(policyPath) {
  const raw = readJsonSafe(policyPath, {});
  return normalizePolicy(raw);
}

function resolveNurseryRoot(policy, args) {
  const argRoot = String(args.root || args['root-dir'] || '').trim();
  const envRoot = String(process.env.NURSERY_ROOT_DIR || process.env.PROTHEUS_NURSERY_ROOT || '').trim();
  const useRepoFallback = String(process.env.NURSERY_FORCE_REPO_ROOT || '') === '1';
  const selected = useRepoFallback
    ? String(policy.fallback_repo_root_dir || 'state/nursery/containment')
    : (argRoot || envRoot || String(policy.root_dir || '~/.openclaw/nursery'));
  return resolvePathFrom(ROOT, selected);
}

function buildDirectoryMap(rootDir, directories) {
  const out = {};
  for (const [name, rel] of Object.entries(directories || {})) {
    const abs = resolvePathFrom(rootDir, rel);
    if (!abs || !isInside(rootDir, abs)) {
      throw new Error(`invalid_nursery_directory:${name}`);
    }
    out[name] = abs;
  }
  return out;
}

function ensureDirectories(dirMap) {
  const created = [];
  for (const abs of Object.values(dirMap || {})) {
    const existed = fs.existsSync(abs);
    ensureDir(abs);
    if (!existed) created.push(abs);
  }
  return created;
}

function checkOllamaModelPresent(model, timeoutMs) {
  const list = listLocalOllamaModels({
    timeoutMs,
    source: 'nursery_bootstrap'
  });
  if (!list.ok) {
    return {
      ok: false,
      present: false,
      reason: String(list.stderr || `ollama_list_exit_${list.code || 1}`).trim().slice(0, 180)
    };
  }
  const names = Array.isArray(list.models) ? list.models.map((m) => normalizeModelName(m)) : [];
  const needle = normalizeModelName(model);
  if (!needle) return { ok: false, present: false, reason: 'model_required' };
  const exact = names.includes(needle);
  const prefix = names.some((name) => name.startsWith(`${needle}:`));
  const noTag = needle.includes(':')
    ? false
    : names.some((name) => name.split(':')[0] === needle);
  return { ok: true, present: exact || prefix || noTag, reason: null };
}

function pullOllamaModel(model, timeoutMs) {
  const pull = pullLocalOllamaModel({
    model,
    timeoutMs,
    source: 'nursery_bootstrap'
  });
  if (!pull.ok) {
    return {
      ok: false,
      reason: String(pull.error || pull.stderr || `ollama_pull_exit_${pull.code || 1}`).trim().slice(0, 220)
    };
  }
  return { ok: true, reason: null };
}

function localStubSeedPath(rootDir, dirMap, artifactId) {
  const seedsDir = dirMap.seeds || path.join(rootDir, 'seeds');
  const safe = String(artifactId || 'seed').replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(seedsDir, `${safe}.seed.json`);
}

function evaluateArtifact(artifact, options) {
  const provider = String(artifact.provider || '').trim().toLowerCase();
  const required = artifact.required === true;
  const model = String(artifact.model || '').trim();
  const autoPull = options.write === true
    && options.autoPullGlobal
    && artifact.auto_pull !== false
    && options.noPull !== true;

  const result = {
    id: String(artifact.id || ''),
    provider,
    model,
    required,
    auto_pull_enabled: autoPull,
    present: false,
    pull_attempted: false,
    pull_ok: null,
    reason: null,
    manifest_path: null
  };

  if (provider === 'ollama') {
    const check = checkOllamaModelPresent(model, options.checkTimeoutMs);
    if (check.ok && check.present) {
      result.present = true;
      result.reason = 'already_present';
      return result;
    }
    if (!autoPull) {
      result.present = false;
      result.reason = check.reason || 'missing_and_autopull_disabled';
      return result;
    }
    result.pull_attempted = true;
    const pull = pullOllamaModel(model, options.pullTimeoutMs);
    result.pull_ok = pull.ok === true;
    if (!pull.ok) {
      result.present = false;
      result.reason = pull.reason || 'pull_failed';
      return result;
    }
    const verify = checkOllamaModelPresent(model, options.checkTimeoutMs);
    result.present = verify.ok && verify.present;
    result.reason = result.present ? 'pulled' : (verify.reason || 'pull_verify_failed');
    return result;
  }

  if (provider === 'local_stub') {
    const fp = localStubSeedPath(options.rootDir, options.dirMap, result.id || 'seed');
    result.manifest_path = fp;
    if (fs.existsSync(fp)) {
      result.present = true;
      result.reason = 'already_present';
      return result;
    }
    if (!autoPull) {
      result.present = false;
      result.reason = 'missing_and_autopull_disabled';
      return result;
    }
    result.pull_attempted = true;
    writeJsonAtomic(fp, {
      schema_id: 'nursery_local_stub_seed',
      id: result.id,
      provider: provider,
      model: model || null,
      created_at: nowIso()
    });
    result.pull_ok = true;
    result.present = true;
    result.reason = 'created_stub_seed';
    return result;
  }

  result.reason = provider ? `unsupported_provider:${provider}` : 'provider_missing';
  return result;
}

function writeContainmentPolicies(rootDir, dirMap, policy) {
  const containmentDir = dirMap.containment || path.join(rootDir, 'containment');
  const policyGatesPath = path.join(containmentDir, 'policy-gates.json');
  const permissionsPath = path.join(containmentDir, 'permissions.json');

  writeJsonAtomic(policyGatesPath, {
    schema_id: 'nursery_policy_gates',
    ts: nowIso(),
    version: String(policy.version || '1.0'),
    ...policy.containment.policy_gates
  });
  writeJsonAtomic(permissionsPath, {
    schema_id: 'nursery_permissions',
    ts: nowIso(),
    version: String(policy.version || '1.0'),
    ...policy.containment.permissions
  });

  return { policy_gates_path: policyGatesPath, permissions_path: permissionsPath };
}

function buildManifest(rootDir, policyPath, policy, artifactRows) {
  const digest = crypto.createHash('sha256')
    .update(JSON.stringify({ policy, artifactRows }))
    .digest('hex');
  return {
    schema_id: 'nursery_seed_manifest',
    ts: nowIso(),
    policy_path: relToRoot(policyPath),
    policy_version: String(policy.version || '1.0'),
    nursery_root: rootDir,
    policy_hash: digest,
    artifacts: artifactRows.map((row) => ({
      id: row.id,
      provider: row.provider,
      model: row.model,
      required: row.required === true,
      present: row.present === true,
      pull_attempted: row.pull_attempted === true,
      pull_ok: row.pull_ok,
      reason: row.reason || null,
      manifest_path: row.manifest_path || null
    }))
  };
}

function runBootstrap(args, options) {
  const policyPath = resolvePathFrom(ROOT, args.policy || process.env.NURSERY_POLICY_PATH || DEFAULT_POLICY_PATH);
  const policy = loadPolicy(policyPath);
  const strict = args.strict === true
    || boolFlag(process.env.NURSERY_STRICT_MISSING, false)
    || (policy.strict_missing_required_models === true && boolFlag(process.env.NURSERY_STRICT_MISSING, true));

  if (!policy.enabled) {
    return {
      ok: true,
      type: 'nursery_bootstrap',
      ts: nowIso(),
      skipped: true,
      reason: 'policy_disabled',
      strict,
      policy_path: relToRoot(policyPath)
    };
  }

  const primaryRoot = resolveNurseryRoot(policy, args);
  const fallbackRoot = resolvePathFrom(ROOT, policy.fallback_repo_root_dir || 'state/nursery/containment');
  let rootDir = primaryRoot;
  let fallbackApplied = false;
  let fallbackReason = null;

  let dirMap;
  let createdDirs = [];
  let containment;
  try {
    dirMap = buildDirectoryMap(rootDir, policy.directories || {});
    createdDirs = options.write === true ? ensureDirectories(dirMap) : [];
    containment = options.write === true
      ? writeContainmentPolicies(rootDir, dirMap, policy)
      : {
          policy_gates_path: path.join(dirMap.containment || path.join(rootDir, 'containment'), 'policy-gates.json'),
          permissions_path: path.join(dirMap.containment || path.join(rootDir, 'containment'), 'permissions.json')
        };
  } catch (err) {
    const msg = String(err && err.message ? err.message : err || 'nursery_root_unavailable');
    const permissionLike = /\\bEPERM\\b|\\bEACCES\\b|permission denied|operation not permitted/i.test(msg);
    const canFallback = options.write === true && permissionLike && fallbackRoot && fallbackRoot !== rootDir;
    if (!canFallback) throw err;
    rootDir = fallbackRoot;
    fallbackApplied = true;
    fallbackReason = msg.slice(0, 180);
    dirMap = buildDirectoryMap(rootDir, policy.directories || {});
    createdDirs = ensureDirectories(dirMap);
    containment = writeContainmentPolicies(rootDir, dirMap, policy);
  }

  const autoPullGlobal = boolFlag(process.env.NURSERY_AUTO_PULL, true);
  const noPull = args['no-pull'] === true || args.no_pull === true;
  const artifactRows = [];
  for (const artifact of policy.model_artifacts || []) {
    const row = evaluateArtifact(artifact, {
      rootDir,
      dirMap,
      noPull,
      autoPullGlobal,
      write: options.write === true,
      checkTimeoutMs: 8000,
      pullTimeoutMs: clampInt(process.env.NURSERY_PULL_TIMEOUT_MS, 5000, 20 * 60 * 1000, Number(policy.pull_timeout_ms || 60000))
    });
    artifactRows.push(row);
  }

  const requiredMissing = artifactRows.filter((row) => row.required === true && row.present !== true);
  const warnings = [];

  if (isInside(ROOT, rootDir)) {
    warnings.push('nursery_root_inside_workspace');
  }

  const manifest = buildManifest(rootDir, policyPath, policy, artifactRows);
  const manifestPath = path.join(dirMap.manifests || path.join(rootDir, 'manifests'), 'seed_manifest.json');
  if (options.write === true) {
    writeJsonAtomic(manifestPath, manifest);
  }

  const out = {
    ok: requiredMissing.length === 0 || !strict,
    type: 'nursery_bootstrap',
    ts: nowIso(),
    strict,
    write: options.write === true,
    policy_path: relToRoot(policyPath),
    policy_version: String(policy.version || '1.0'),
    primary_nursery_root: primaryRoot,
    nursery_root: rootDir,
    nursery_root_inside_workspace: isInside(ROOT, rootDir),
    fallback_applied: fallbackApplied,
    fallback_reason: fallbackReason,
    created_directories: createdDirs.map((abs) => path.relative(rootDir, abs).replace(/\\/g, '/')),
    directories_total: Object.keys(dirMap).length,
    containment,
    artifacts_total: artifactRows.length,
    artifacts_ready: artifactRows.filter((row) => row.present === true).length,
    required_missing: requiredMissing.map((row) => ({ id: row.id, model: row.model, reason: row.reason || null })),
    artifacts: artifactRows,
    warnings,
    manifest_path: manifestPath,
    state_path: DEFAULT_STATE_PATH,
    history_path: DEFAULT_HISTORY_PATH
  };

  if (options.write === true) {
    writeJsonAtomic(DEFAULT_STATE_PATH, out);
    appendJsonl(DEFAULT_HISTORY_PATH, out);
  }

  return out;
}

function cmdRun(args) {
  const out = runBootstrap(args, { write: true });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdStatus(args) {
  const out = runBootstrap(args, { write: false });
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!out.ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }

  if (cmd === 'run' || cmd === 'bootstrap') {
    cmdRun(args);
    return;
  }
  if (cmd === 'status') {
    cmdStatus(args);
    return;
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'nursery_bootstrap',
      error: String(err && err.message ? err.message : err || 'nursery_bootstrap_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  runBootstrap
};
