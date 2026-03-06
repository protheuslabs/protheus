#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.COMPUTE_TITHE_POLICY_PATH
  ? path.resolve(process.env.COMPUTE_TITHE_POLICY_PATH)
  : path.join(ROOT, 'config', 'compute_tithe_flywheel_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableHash(v: unknown, len = 16) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    base_tithe_rate: 0.1,
    min_tithe_rate: 0.01,
    max_discount_rate: 0.85,
    discount_per_gpu_hour: 0.0025,
    risk_tier_default: 2,
    enforce_second_gate_tier3_plus: true,
    require_constitution_pass: true,
    discount_tiers: [
      { min_gpu_hours: 0, discount_rate: 0.0 },
      { min_gpu_hours: 100, discount_rate: 0.05 },
      { min_gpu_hours: 1000, discount_rate: 0.2 },
      { min_gpu_hours: 5000, discount_rate: 0.45 },
      { min_gpu_hours: 10000, discount_rate: 0.7 }
    ],
    paths: {
      contributions_path: 'state/economy/contributions.json',
      donor_state_path: 'state/economy/donor_state.json',
      latest_path: 'state/economy/latest.json',
      receipts_path: 'state/economy/receipts.jsonl',
      ledger_path: 'state/economy/tithe_ledger.jsonl',
      event_stream_path: 'state/ops/event_sourced_control_plane/events.jsonl',
      soul_marker_path: 'state/soul/gpu_patrons.json',
      guard_hint_path: 'state/security/guard/effective_tithe.json',
      fractal_hint_path: 'state/fractal/donor_priority_hints.json',
      routing_hint_path: 'state/routing/donor_priority_hints.json',
      model_hint_path: 'state/routing/model_donor_priority_hints.json',
      risk_hint_path: 'state/routing/risk_donor_priority_hints.json',
      chain_receipts_path: 'state/blockchain/tithe_bridge_receipts.jsonl'
    }
  };
}

function normalizeDiscountTiers(raw: any, fallback: any[]) {
  const src = Array.isArray(raw) ? raw : fallback;
  const rows = src
    .map((row) => ({
      min_gpu_hours: clampNumber(row && row.min_gpu_hours, 0, 1_000_000_000, 0),
      discount_rate: clampNumber(row && row.discount_rate, 0, 1, 0)
    }))
    .filter((row) => Number.isFinite(row.min_gpu_hours) && Number.isFinite(row.discount_rate))
    .sort((a, b) => Number(a.min_gpu_hours) - Number(b.min_gpu_hours));
  if (rows.length < 1) return fallback.slice(0);
  return rows;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    base_tithe_rate: clampNumber(raw.base_tithe_rate, 0, 1, base.base_tithe_rate),
    min_tithe_rate: clampNumber(raw.min_tithe_rate, 0, 1, base.min_tithe_rate),
    max_discount_rate: clampNumber(raw.max_discount_rate, 0, 1, base.max_discount_rate),
    discount_per_gpu_hour: clampNumber(raw.discount_per_gpu_hour, 0, 1, base.discount_per_gpu_hour),
    risk_tier_default: Math.max(1, Math.min(4, Math.round(clampNumber(raw.risk_tier_default, 1, 4, base.risk_tier_default)))),
    enforce_second_gate_tier3_plus: raw.enforce_second_gate_tier3_plus !== false,
    require_constitution_pass: raw.require_constitution_pass !== false,
    discount_tiers: normalizeDiscountTiers(raw.discount_tiers, base.discount_tiers),
    paths: {
      contributions_path: resolvePath(paths.contributions_path, base.paths.contributions_path),
      donor_state_path: resolvePath(paths.donor_state_path, base.paths.donor_state_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      ledger_path: resolvePath(paths.ledger_path, base.paths.ledger_path),
      event_stream_path: resolvePath(paths.event_stream_path, base.paths.event_stream_path),
      soul_marker_path: resolvePath(paths.soul_marker_path, base.paths.soul_marker_path),
      guard_hint_path: resolvePath(paths.guard_hint_path, base.paths.guard_hint_path),
      fractal_hint_path: resolvePath(paths.fractal_hint_path, base.paths.fractal_hint_path),
      routing_hint_path: resolvePath(paths.routing_hint_path, base.paths.routing_hint_path),
      model_hint_path: resolvePath(paths.model_hint_path, base.paths.model_hint_path),
      risk_hint_path: resolvePath(paths.risk_hint_path, base.paths.risk_hint_path),
      chain_receipts_path: resolvePath(paths.chain_receipts_path, base.paths.chain_receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function emit(payload: Record<string, any>, code = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

module.exports = {
  ROOT,
  DEFAULT_POLICY_PATH,
  nowIso,
  cleanText,
  clampNumber,
  normalizeToken,
  parseArgs,
  ensureDir,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  rel,
  stableHash,
  loadPolicy,
  emit
};
