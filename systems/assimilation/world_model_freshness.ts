#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.WORLD_MODEL_REFRESH_ROOT
  ? path.resolve(process.env.WORLD_MODEL_REFRESH_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.WORLD_MODEL_REFRESH_POLICY_PATH
  ? path.resolve(process.env.WORLD_MODEL_REFRESH_POLICY_PATH)
  : path.join(ROOT, 'config', 'world_model_freshness_policy.json');

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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/world_model_freshness.js run [--apply=1|0] [--strict=1|0] [--max-profiles=N]');
  console.log('  node systems/assimilation/world_model_freshness.js status');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch {
    return [];
  }
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown) {
  const token = cleanText(raw || '', 500);
  if (!token) return ROOT;
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 16);
}

function defaultPolicy() {
  return {
    schema_id: 'world_model_freshness_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    strict_requires_profiles: false,
    stale_after_days: 14,
    warning_after_days: 7,
    min_refresh_interval_hours: 6,
    freshness_slo_target: 0.9,
    max_profiles_per_run: 50,
    profile_roots: [
      'state/assimilation/capability_profiles/profiles'
    ],
    required_surface_checks: {
      legal_ok: true,
      auth_model_present: true,
      rate_limit_hint_present: true
    },
    outputs: {
      latest_path: 'state/assimilation/world_model_freshness/latest.json',
      receipts_path: 'state/assimilation/world_model_freshness/receipts.jsonl',
      deltas_path: 'state/assimilation/world_model_freshness/deltas.jsonl',
      compiler_queue_path: 'state/assimilation/world_model_freshness/compiler_queue.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const reqChecks = raw.required_surface_checks && typeof raw.required_surface_checks === 'object'
    ? raw.required_surface_checks
    : {};
  const profileRootsRaw = Array.isArray(raw.profile_roots) ? raw.profile_roots : base.profile_roots;
  return {
    schema_id: 'world_model_freshness_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    strict_requires_profiles: raw.strict_requires_profiles === true,
    stale_after_days: clampNumber(raw.stale_after_days, 1, 3650, base.stale_after_days),
    warning_after_days: clampNumber(raw.warning_after_days, 1, 3650, base.warning_after_days),
    min_refresh_interval_hours: clampNumber(raw.min_refresh_interval_hours, 0, 24 * 365, base.min_refresh_interval_hours),
    freshness_slo_target: clampNumber(raw.freshness_slo_target, 0, 1, base.freshness_slo_target),
    max_profiles_per_run: clampInt(raw.max_profiles_per_run, 1, 100000, base.max_profiles_per_run),
    profile_roots: profileRootsRaw.map((row: unknown) => resolvePath(row)).filter(Boolean),
    required_surface_checks: {
      legal_ok: reqChecks.legal_ok !== false,
      auth_model_present: reqChecks.auth_model_present !== false,
      rate_limit_hint_present: reqChecks.rate_limit_hint_present !== false
    },
    outputs: {
      latest_path: resolvePath(outputs.latest_path || base.outputs.latest_path),
      receipts_path: resolvePath(outputs.receipts_path || base.outputs.receipts_path),
      deltas_path: resolvePath(outputs.deltas_path || base.outputs.deltas_path),
      compiler_queue_path: resolvePath(outputs.compiler_queue_path || base.outputs.compiler_queue_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function listProfileFiles(profileRoots: string[]) {
  const files: string[] = [];
  for (const root of profileRoots) {
    if (!fs.existsSync(root)) continue;
    const st = fs.statSync(root);
    if (st.isFile() && root.endsWith('.json')) {
      files.push(root);
      continue;
    }
    if (!st.isDirectory()) continue;
    const stack = [root];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      let entries: fs.Dirent[] = [];
      try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        const abs = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(abs);
          continue;
        }
        if (entry.isFile() && abs.endsWith('.json')) files.push(abs);
      }
    }
  }
  return Array.from(new Set(files)).sort((a, b) => a.localeCompare(b));
}

function profileAgeDays(profile: AnyObj) {
  const ts = parseIsoMs(profile && (profile.generated_at || profile.updated_at || profile.freshness && profile.freshness.last_refreshed_at) || '');
  if (ts == null) return Number.POSITIVE_INFINITY;
  return (Date.now() - ts) / (24 * 60 * 60 * 1000);
}

function profileRefreshIntervalHours(profile: AnyObj) {
  const ts = parseIsoMs(profile && profile.freshness && profile.freshness.last_refreshed_at || '');
  if (ts == null) return Number.POSITIVE_INFINITY;
  return (Date.now() - ts) / (60 * 60 * 1000);
}

function detectStalenessReasons(profile: AnyObj, policy: AnyObj, ageDays: number, refreshHours: number) {
  const reasons: string[] = [];
  if (ageDays >= policy.stale_after_days) reasons.push('age_exceeds_stale_threshold');
  else if (ageDays >= policy.warning_after_days) reasons.push('age_exceeds_warning_threshold');

  const legal = profile && profile.provenance && profile.provenance.legal && typeof profile.provenance.legal === 'object'
    ? profile.provenance.legal
    : {};
  const authMode = normalizeToken(profile && profile.surface && profile.surface.auth && profile.surface.auth.mode || '', 80);
  const rateHints = Array.isArray(profile && profile.surface && profile.surface.rate_limit && profile.surface.rate_limit.hints)
    ? profile.surface.rate_limit.hints
    : [];

  if (policy.required_surface_checks.legal_ok && !(legal.tos_ok === true && legal.robots_ok === true && legal.data_rights_ok === true)) {
    reasons.push('legal_surface_incomplete');
  }
  if (policy.required_surface_checks.auth_model_present && !authMode) {
    reasons.push('auth_model_missing');
  }
  if (policy.required_surface_checks.rate_limit_hint_present && rateHints.length < 1) {
    reasons.push('rate_limit_hint_missing');
  }
  if (refreshHours < policy.min_refresh_interval_hours) {
    reasons.push('within_min_refresh_interval');
  }

  return reasons;
}

function compilerDelta(profile: AnyObj, profilePath: string, reasons: string[]) {
  const capabilityId = normalizeToken(profile && profile.source && profile.source.capability_id || profile && profile.profile_id || '', 160)
    || `cap_${sha16(`${profilePath}`)}`;
  const sourceType = normalizeToken(profile && profile.source && profile.source.source_type || 'api', 80) || 'api';
  return {
    queue_type: 'world_model_freshness_delta',
    ts: nowIso(),
    capability_id: capabilityId,
    source_type: sourceType,
    profile_path: rel(profilePath),
    reasons,
    research_json: {
      source: {
        capability_id: capabilityId,
        source_type: sourceType,
        framework: normalizeToken(profile && profile.source && profile.source.framework || 'protheus', 80) || 'protheus',
        origin_ref: cleanText(profile && profile.source && profile.source.origin_ref || rel(profilePath), 240)
      },
      surface: profile && profile.surface && typeof profile.surface === 'object' ? profile.surface : {},
      provenance: profile && profile.provenance && typeof profile.provenance === 'object' ? profile.provenance : {}
    }
  };
}

function runProfileRefresh(policy: AnyObj, profilePath: string, apply: boolean) {
  const profile = readJson(profilePath, null);
  if (!profile || typeof profile !== 'object') {
    return {
      ok: false,
      profile_path: rel(profilePath),
      error: 'profile_parse_failed'
    };
  }

  const ageDays = profileAgeDays(profile);
  const refreshHours = profileRefreshIntervalHours(profile);
  const reasons = detectStalenessReasons(profile, policy, ageDays, refreshHours);
  const isStale = reasons.some((row) => row !== 'within_min_refresh_interval');
  const isRefreshBlocked = reasons.includes('within_min_refresh_interval');

  const delta = compilerDelta(profile, profilePath, reasons);

  const updated = {
    ...profile,
    freshness: {
      ...(profile.freshness && typeof profile.freshness === 'object' ? profile.freshness : {}),
      last_checked_at: nowIso(),
      last_refreshed_at: apply && isStale && !isRefreshBlocked ? nowIso() : cleanText(profile.freshness && profile.freshness.last_refreshed_at || '', 40) || null,
      stale_reasons: reasons,
      stale: isStale,
      staleness_days: Number.isFinite(ageDays) ? Number(ageDays.toFixed(3)) : null
    }
  };

  if (apply && policy.shadow_only !== true && isStale && !isRefreshBlocked) {
    writeJsonAtomic(profilePath, updated);
  }

  return {
    ok: true,
    profile_path: rel(profilePath),
    profile_id: normalizeToken(profile.profile_id || '', 160) || null,
    capability_id: normalizeToken(profile && profile.source && profile.source.capability_id || '', 160) || null,
    age_days: Number.isFinite(ageDays) ? Number(ageDays.toFixed(3)) : null,
    is_stale: isStale,
    refresh_blocked: isRefreshBlocked,
    reasons,
    delta,
    applied: apply && policy.shadow_only !== true && isStale && !isRefreshBlocked
  };
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'world_model_freshness_run', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, false);
  const apply = toBool(args.apply, false);
  const maxProfiles = clampInt(args['max-profiles'] || args.max_profiles, 1, 100000, policy.max_profiles_per_run);
  const files = listProfileFiles(policy.profile_roots).slice(0, maxProfiles);

  const rows = files.map((profilePath) => runProfileRefresh(policy, profilePath, apply));
  const staleRows = rows.filter((row: AnyObj) => row.ok === true && row.is_stale === true);
  const freshRows = rows.filter((row: AnyObj) => row.ok === true && row.is_stale !== true);
  const errors = rows.filter((row: AnyObj) => row.ok !== true);

  const totalProcessed = rows.length;
  const freshnessScore = totalProcessed > 0
    ? Number((freshRows.length / totalProcessed).toFixed(4))
    : 1;
  const sloOk = freshnessScore >= policy.freshness_slo_target;

  const deltas = staleRows
    .filter((row: AnyObj) => row.refresh_blocked !== true)
    .map((row: AnyObj) => row.delta)
    .filter(Boolean);

  if (policy.shadow_only !== true) {
    for (const delta of deltas) {
      appendJsonl(policy.outputs.compiler_queue_path, delta);
      appendJsonl(policy.outputs.deltas_path, delta);
    }
  }

  const out = {
    ok: errors.length === 0 && (!strict || (!policy.strict_requires_profiles || totalProcessed > 0) && sloOk),
    type: 'world_model_freshness_run',
    ts: nowIso(),
    strict,
    apply,
    shadow_only: policy.shadow_only === true,
    profile_count: totalProcessed,
    stale_count: staleRows.length,
    fresh_count: freshRows.length,
    error_count: errors.length,
    freshness_score: freshnessScore,
    freshness_slo_target: policy.freshness_slo_target,
    freshness_slo_ok: sloOk,
    queued_delta_count: deltas.length,
    rows,
    policy_path: rel(policy.policy_path)
  };

  appendJsonl(policy.outputs.receipts_path, out);
  writeJsonAtomic(policy.outputs.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.outputs.latest_path, null);
  const receipts = readJsonl(policy.outputs.receipts_path).slice(-20);
  const deltas = readJsonl(policy.outputs.deltas_path).slice(-200);
  const out = {
    ok: true,
    type: 'world_model_freshness_status',
    ts: nowIso(),
    policy: {
      path: rel(policy.policy_path),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      stale_after_days: policy.stale_after_days,
      freshness_slo_target: policy.freshness_slo_target,
      profile_roots: policy.profile_roots.map((row: string) => rel(row))
    },
    latest,
    receipts_count_20: receipts.length,
    queued_delta_count_200: deltas.length,
    paths: {
      latest_path: rel(policy.outputs.latest_path),
      receipts_path: rel(policy.outputs.receipts_path),
      deltas_path: rel(policy.outputs.deltas_path),
      compiler_queue_path: rel(policy.outputs.compiler_queue_path)
    }
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  cmdRun,
  cmdStatus
};
