#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const os = require('os');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.EMBODIMENT_LAYER_ROOT
  ? path.resolve(process.env.EMBODIMENT_LAYER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.EMBODIMENT_LAYER_POLICY_PATH
  ? path.resolve(process.env.EMBODIMENT_LAYER_POLICY_PATH)
  : path.join(ROOT, 'config', 'embodiment_layer_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  return Math.floor(clampNum(v, lo, hi, fallback));
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/hardware/embodiment_layer.js sense [--profile=auto|phone|desktop|cluster] [--policy=<path>]');
  console.log('  node systems/hardware/embodiment_layer.js verify-parity [--profiles=phone,desktop,cluster] [--policy=<path>] [--strict=1|0]');
  console.log('  node systems/hardware/embodiment_layer.js status [--policy=<path>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(v: unknown) {
  const text = cleanText(v || '', 320);
  if (!text) return ROOT;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    schema_id: 'embodiment_layer_policy',
    schema_version: '1.0',
    enabled: true,
    required_contract_fields: [
      'profile_id',
      'capabilities',
      'surface_budget',
      'capability_envelope',
      'runtime_modes'
    ],
    parity_ignore_fields: [
      'measured_at',
      'hardware_fingerprint',
      'surface_budget.score',
      'capabilities.cpu_threads',
      'capabilities.ram_gb',
      'capabilities.storage_gb'
    ],
    profiles: {
      phone: {
        max_parallel_workflows: 2,
        inversion_depth_cap: 1,
        dream_intensity_cap: 1,
        heavy_lanes_disabled: true,
        min_surface_budget_score: 0.2
      },
      desktop: {
        max_parallel_workflows: 6,
        inversion_depth_cap: 3,
        dream_intensity_cap: 3,
        heavy_lanes_disabled: false,
        min_surface_budget_score: 0.35
      },
      cluster: {
        max_parallel_workflows: 24,
        inversion_depth_cap: 5,
        dream_intensity_cap: 5,
        heavy_lanes_disabled: false,
        min_surface_budget_score: 0.5
      }
    },
    latest_path: 'state/hardware/embodiment/latest.json',
    receipts_path: 'state/hardware/embodiment/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const requiredFields = Array.isArray(raw.required_contract_fields)
    ? raw.required_contract_fields.map((v: unknown) => cleanText(v, 80)).filter(Boolean)
    : base.required_contract_fields;
  const parityIgnore = Array.isArray(raw.parity_ignore_fields)
    ? raw.parity_ignore_fields.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
    : base.parity_ignore_fields;
  const profilesRaw = raw.profiles && typeof raw.profiles === 'object' ? raw.profiles : base.profiles;

  const profiles: AnyObj = {};
  for (const [key, value] of Object.entries(profilesRaw)) {
    const profileId = normalizeToken(key, 40);
    if (!profileId) continue;
    const row = value && typeof value === 'object' ? value as AnyObj : {};
    profiles[profileId] = {
      max_parallel_workflows: clampInt(row.max_parallel_workflows, 1, 1000, 2),
      inversion_depth_cap: clampInt(row.inversion_depth_cap, 0, 32, 1),
      dream_intensity_cap: clampInt(row.dream_intensity_cap, 0, 32, 1),
      heavy_lanes_disabled: row.heavy_lanes_disabled === true,
      min_surface_budget_score: clampNum(row.min_surface_budget_score, 0, 1, 0.2)
    };
  }

  return {
    schema_id: 'embodiment_layer_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    required_contract_fields: requiredFields,
    parity_ignore_fields: parityIgnore,
    profiles: Object.keys(profiles).length ? profiles : base.profiles,
    latest_path: resolvePath(raw.latest_path || base.latest_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function envNum(name: string, fallback: number) {
  if (process.env[name] == null) return fallback;
  const n = Number(process.env[name]);
  return Number.isFinite(n) ? n : fallback;
}

function measureHardware() {
  const cpuThreads = Math.max(1, clampInt(envNum('EMBODIMENT_CPU_THREADS', os.cpus().length), 1, 4096, 1));
  const totalMemGb = clampNum(envNum('EMBODIMENT_RAM_GB', os.totalmem() / (1024 ** 3)), 0.25, 262144, 1);
  const freeMemGb = clampNum(envNum('EMBODIMENT_FREE_RAM_GB', os.freemem() / (1024 ** 3)), 0, totalMemGb, totalMemGb / 2);
  const storageGb = clampNum(envNum('EMBODIMENT_STORAGE_GB', 512), 1, 10_000_000, 512);
  const battery = clampNum(envNum('EMBODIMENT_BATTERY', 1), 0, 1, 1);
  const thermal = clampNum(envNum('EMBODIMENT_THERMAL', 0.3), 0, 1, 0.3);
  const network = clampNum(envNum('EMBODIMENT_NETWORK', 0.8), 0, 1, 0.8);

  return {
    measured_at: nowIso(),
    cpu_threads: cpuThreads,
    ram_gb: Number(totalMemGb.toFixed(3)),
    free_ram_gb: Number(freeMemGb.toFixed(3)),
    storage_gb: Number(storageGb.toFixed(3)),
    battery,
    thermal,
    network,
    platform: cleanText(process.env.EMBODIMENT_PLATFORM || os.platform(), 40) || os.platform(),
    arch: cleanText(process.env.EMBODIMENT_ARCH || os.arch(), 40) || os.arch()
  };
}

function chooseProfile(measured: AnyObj, requestedProfile: string) {
  const req = normalizeToken(requestedProfile || 'auto', 40);
  if (req && req !== 'auto') return req;
  if (measured.cpu_threads >= 32 && measured.ram_gb >= 64) return 'cluster';
  if (measured.cpu_threads <= 8 || measured.ram_gb <= 12) return 'phone';
  return 'desktop';
}

function surfaceBudget(measured: AnyObj, profileCfg: AnyObj) {
  const cpuScore = Math.min(1, Number(measured.cpu_threads || 1) / Math.max(1, Number(profileCfg.max_parallel_workflows || 1)));
  const memRatio = Number(measured.ram_gb || 1) <= 0 ? 0 : Number(measured.free_ram_gb || 0) / Number(measured.ram_gb || 1);
  const memScore = clampNum(memRatio, 0, 1, 0);
  const thermalScore = 1 - clampNum(measured.thermal, 0, 1, 1);
  const batteryScore = clampNum(measured.battery, 0, 1, 1);
  const networkScore = clampNum(measured.network, 0, 1, 1);
  const score = clampNum((cpuScore * 0.25) + (memScore * 0.25) + (thermalScore * 0.2) + (batteryScore * 0.15) + (networkScore * 0.15), 0, 1, 0);

  return {
    score: Number(score.toFixed(4)),
    factors: {
      cpu_score: Number(cpuScore.toFixed(4)),
      memory_score: Number(memScore.toFixed(4)),
      thermal_score: Number(thermalScore.toFixed(4)),
      battery_score: Number(batteryScore.toFixed(4)),
      network_score: Number(networkScore.toFixed(4))
    },
    min_required: Number(profileCfg.min_surface_budget_score || 0),
    healthy: score >= Number(profileCfg.min_surface_budget_score || 0)
  };
}

function makeEmbodimentSnapshot(policy: AnyObj, profileIdRaw: string) {
  const measured = measureHardware();
  const profileId = chooseProfile(measured, profileIdRaw);
  const profileCfg = policy.profiles[profileId] || policy.profiles.desktop || policy.profiles.phone;
  const budget = surfaceBudget(measured, profileCfg);

  return {
    schema_id: 'hardware_embodiment_snapshot',
    schema_version: '1.0',
    measured_at: measured.measured_at,
    profile_id: profileId,
    capabilities: {
      cpu_threads: measured.cpu_threads,
      ram_gb: measured.ram_gb,
      free_ram_gb: measured.free_ram_gb,
      storage_gb: measured.storage_gb,
      platform: measured.platform,
      arch: measured.arch,
      supports_heavy_lanes: profileCfg.heavy_lanes_disabled !== true,
      supports_local_training: measured.cpu_threads >= 12 && measured.ram_gb >= 16
    },
    surface_budget: budget,
    capability_envelope: {
      max_parallel_workflows: Number(profileCfg.max_parallel_workflows || 1),
      inversion_depth_cap: Number(profileCfg.inversion_depth_cap || 0),
      dream_intensity_cap: Number(profileCfg.dream_intensity_cap || 0),
      heavy_lanes_disabled: profileCfg.heavy_lanes_disabled === true
    },
    runtime_modes: {
      operational: true,
      dream: Number(profileCfg.dream_intensity_cap || 0) > 0,
      inversion: Number(profileCfg.inversion_depth_cap || 0) > 0 && profileCfg.heavy_lanes_disabled !== true
    },
    hardware_fingerprint: normalizeToken(`${measured.platform}:${measured.arch}:${measured.cpu_threads}:${Math.round(measured.ram_gb)}`, 120)
  };
}

function readLatestEmbodiment(policyPath = DEFAULT_POLICY_PATH) {
  const policy = loadPolicy(policyPath);
  const latest = readJson(policy.latest_path, null);
  if (latest && typeof latest === 'object' && latest.schema_id === 'hardware_embodiment_snapshot') return latest;
  return null;
}

function recordSnapshot(policy: AnyObj, snapshot: AnyObj, receiptType: string) {
  writeJsonAtomic(policy.latest_path, snapshot);
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    type: receiptType,
    profile_id: snapshot.profile_id,
    surface_budget_score: snapshot.surface_budget && typeof snapshot.surface_budget.score === 'number'
      ? snapshot.surface_budget.score
      : null,
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path)
  });
}

function flattenObject(obj: AnyObj, prefix = '') {
  const out: AnyObj = {};
  for (const [k, v] of Object.entries(obj || {})) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      Object.assign(out, flattenObject(v as AnyObj, key));
    } else {
      out[key] = v;
    }
  }
  return out;
}

function removeIgnored(flat: AnyObj, ignored: string[]) {
  const out: AnyObj = {};
  const ignoreSet = new Set(ignored.map((v) => cleanText(v, 120)).filter(Boolean));
  for (const [k, v] of Object.entries(flat || {})) {
    if (ignoreSet.has(k)) continue;
    out[k] = v;
  }
  return out;
}

function verifyParity(policy: AnyObj, profiles: string[]) {
  const profileList = profiles.map((v) => normalizeToken(v, 40)).filter(Boolean);
  const snapshots = profileList.map((profileId) => makeEmbodimentSnapshot(policy, profileId));
  const required = policy.required_contract_fields as string[];
  const missingByProfile: AnyObj = {};
  for (const snapshot of snapshots) {
    const missing = required.filter((field) => snapshot[field] == null);
    if (missing.length) missingByProfile[snapshot.profile_id] = missing;
  }

  const valueType = (v: unknown) => {
    if (v == null) return 'null';
    if (Array.isArray(v)) return 'array';
    return typeof v;
  };
  const reference = snapshots[0] || {};
  const refFlat = removeIgnored(flattenObject(reference), policy.parity_ignore_fields || []);
  const refTypes: AnyObj = {};
  for (const [k, v] of Object.entries(refFlat)) refTypes[k] = valueType(v);
  const diffs: AnyObj[] = [];
  for (const snapshot of snapshots.slice(1)) {
    const flat = removeIgnored(flattenObject(snapshot), policy.parity_ignore_fields || []);
    const keys = Array.from(new Set([...Object.keys(refTypes), ...Object.keys(flat)])).sort((a, b) => a.localeCompare(b));
    for (const key of keys) {
      const expectedType = cleanText(refTypes[key] || 'missing', 24);
      const actualType = valueType(flat[key]);
      if (expectedType === actualType) continue;
      diffs.push({
        key,
        profile: snapshot.profile_id,
        expected_type: expectedType,
        actual_type: actualType
      });
    }
  }

  return {
    ok: Object.keys(missingByProfile).length === 0 && diffs.length === 0,
    type: 'embodiment_parity_verify',
    ts: nowIso(),
    profiles: snapshots.map((row) => row.profile_id),
    missing_contract_fields: missingByProfile,
    non_capacity_diffs: diffs,
    snapshots
  };
}

function cmdSense(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'policy_disabled' }, null, 2)}\n`);
    process.exit(1);
  }

  const requestedProfile = cleanText(args.profile || 'auto', 40) || 'auto';
  const snapshot = makeEmbodimentSnapshot(policy, requestedProfile);
  recordSnapshot(policy, snapshot, 'embodiment_sensed');
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'embodiment_sense', snapshot }, null, 2)}\n`);
}

function cmdVerifyParity(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = boolFlag(args.strict, false);
  const profiles = cleanText(args.profiles || 'phone,desktop,cluster', 200)
    .split(',')
    .map((row) => normalizeToken(row, 40))
    .filter(Boolean);
  const payload = verifyParity(policy, profiles);
  appendJsonl(policy.receipts_path, {
    ts: nowIso(),
    type: 'embodiment_parity_verify',
    ok: payload.ok === true,
    profiles: payload.profiles,
    missing_contract_fields: payload.missing_contract_fields,
    diff_count: Array.isArray(payload.non_capacity_diffs) ? payload.non_capacity_diffs.length : 0,
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path)
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  if (!latest) {
    process.stdout.write(`${JSON.stringify({ ok: false, reason: 'status_not_found', latest_path: rel(policy.latest_path) }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'embodiment_status',
    ts: nowIso(),
    latest_path: rel(policy.latest_path),
    receipts_path: rel(policy.receipts_path),
    snapshot: latest
  }, null, 2)}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'sense') return cmdSense(args);
  if (cmd === 'verify-parity') return cmdVerifyParity(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  makeEmbodimentSnapshot,
  readLatestEmbodiment,
  verifyParity
};
