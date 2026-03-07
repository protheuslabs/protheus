#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.SURFACE_EMBODIMENT_FRESHNESS_ROOT
  ? path.resolve(process.env.SURFACE_EMBODIMENT_FRESHNESS_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SURFACE_EMBODIMENT_FRESHNESS_POLICY_PATH
  ? path.resolve(process.env.SURFACE_EMBODIMENT_FRESHNESS_POLICY_PATH)
  : path.join(ROOT, 'config', 'surface_embodiment_freshness_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}
function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}
function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
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
  console.log('  node systems/hardware/surface_embodiment_freshness_guard.js run [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/hardware/surface_embodiment_freshness_guard.js status [--policy=<path>]');
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 600);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(absPath: string) { return path.relative(ROOT, absPath).replace(/\\/g, '/'); }
function parseDateMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_surface_age_minutes: 60,
    max_embodiment_age_minutes: 60,
    surface_state_path: 'state/hardware/surface_budget/latest.json',
    embodiment_state_path: 'state/hardware/embodiment/latest.json',
    latest_path: 'state/hardware/freshness_guard/latest.json',
    receipts_path: 'state/hardware/freshness_guard/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    max_surface_age_minutes: clampInt(raw.max_surface_age_minutes, 1, 24 * 60, base.max_surface_age_minutes),
    max_embodiment_age_minutes: clampInt(raw.max_embodiment_age_minutes, 1, 24 * 60, base.max_embodiment_age_minutes),
    surface_state_path: resolvePath(raw.surface_state_path || base.surface_state_path, base.surface_state_path),
    embodiment_state_path: resolvePath(raw.embodiment_state_path || base.embodiment_state_path, base.embodiment_state_path),
    latest_path: resolvePath(raw.latest_path || base.latest_path, base.latest_path),
    receipts_path: resolvePath(raw.receipts_path || base.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function msAge(ts: unknown) {
  const parsed = parseDateMs(ts);
  if (!Number.isFinite(parsed)) return null;
  return Date.now() - Number(parsed);
}

function runNode(args: string[]) {
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  let parsed = null;
  try { parsed = stdout ? JSON.parse(stdout) : null; } catch { parsed = null; }
  return {
    ok: r.status === 0,
    status: Number(r.status || 0),
    stdout,
    stderr: String(r.stderr || '').trim(),
    parsed
  };
}

function buildStatus(policy: Record<string, any>) {
  const surface = readJson(policy.surface_state_path, null);
  const embodiment = readJson(policy.embodiment_state_path, null);
  const surfaceTs = surface && typeof surface === 'object' ? surface.ts : null;
  const embodimentTs = embodiment && typeof embodiment === 'object' ? (embodiment.measured_at || embodiment.ts) : null;
  const surfaceAgeMs = msAge(surfaceTs);
  const embodimentAgeMs = msAge(embodimentTs);
  const surfaceStale = surfaceAgeMs == null || surfaceAgeMs > Number(policy.max_surface_age_minutes || 0) * 60000;
  const embodimentStale = embodimentAgeMs == null || embodimentAgeMs > Number(policy.max_embodiment_age_minutes || 0) * 60000;
  return {
    ok: !surfaceStale && !embodimentStale,
    type: 'surface_embodiment_freshness_status',
    ts: nowIso(),
    stale: {
      surface: surfaceStale,
      embodiment: embodimentStale
    },
    ages_ms: {
      surface: surfaceAgeMs,
      embodiment: embodimentAgeMs
    },
    max_age_minutes: {
      surface: Number(policy.max_surface_age_minutes || 0),
      embodiment: Number(policy.max_embodiment_age_minutes || 0)
    },
    paths: {
      surface_state_path: rel(policy.surface_state_path),
      embodiment_state_path: rel(policy.embodiment_state_path),
      latest_path: rel(policy.latest_path),
      receipts_path: rel(policy.receipts_path),
      policy_path: rel(policy.policy_path)
    }
  };
}

function cmdRun(args: Record<string, any>) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const apply = toBool(args.apply, true);
  const strict = toBool(args.strict, false);
  const statusBefore = buildStatus(policy);
  const repairs = [] as Record<string, any>[];

  if (apply && statusBefore.stale.embodiment) {
    repairs.push({ step: 'hardware:embodiment:sense', result: runNode(['systems/hardware/embodiment_layer.js', 'sense', '--profile=auto']) });
  }
  if (apply && (statusBefore.stale.surface || statusBefore.stale.embodiment)) {
    repairs.push({ step: 'hardware:surface-budget:run', result: runNode(['systems/hardware/surface_budget_controller.js', 'run', '--apply=1']) });
  }

  const statusAfter = buildStatus(policy);
  const out = {
    ok: statusAfter.ok === true,
    type: 'surface_embodiment_freshness_guard',
    ts: nowIso(),
    apply,
    strict,
    status_before: statusBefore,
    repairs: repairs.map((row) => ({
      step: row.step,
      ok: row.result && row.result.ok === true,
      status: row.result ? row.result.status : null,
      error: row.result && row.result.ok !== true ? (row.result.stderr || row.result.stdout || 'step_failed') : null
    })),
    status_after: statusAfter
  };

  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  if (strict && out.ok !== true) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
  }
  return out;
}

function cmdStatus(args: Record<string, any>) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  if (!latest || typeof latest !== 'object') {
    return buildStatus(policy);
  }
  return {
    ok: true,
    type: 'surface_embodiment_freshness_guard_status',
    ts: nowIso(),
    latest,
    latest_path: rel(policy.latest_path),
    receipts_path: rel(policy.receipts_path)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 64);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const out = cmdRun(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (cmd === 'status') {
    const out = cmdStatus(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (!out.ok) process.exit(1);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  buildStatus,
  cmdRun,
  cmdStatus
};
