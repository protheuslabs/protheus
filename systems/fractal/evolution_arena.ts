#!/usr/bin/env node
'use strict';

/**
 * evolution_arena.js
 *
 * Spawn-broker bounded A/B variant arena for adaptive strategy selection.
 *
 * Usage:
 *   node systems/fractal/evolution_arena.js run [--objective=<id>] [--variants=a,b,c] [--scores=a:0.72,b:0.61,c:0.75] [--strict=1|0]
 *   node systems/fractal/evolution_arena.js status
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.EVOLUTION_ARENA_POLICY_PATH
  ? path.resolve(process.env.EVOLUTION_ARENA_POLICY_PATH)
  : path.join(ROOT, 'config', 'evolution_arena_policy.json');
const STATE_DIR = process.env.EVOLUTION_ARENA_STATE_DIR
  ? path.resolve(process.env.EVOLUTION_ARENA_STATE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'evolution_arena');
const LATEST_PATH = path.join(STATE_DIR, 'latest.json');
const HISTORY_PATH = path.join(STATE_DIR, 'history.jsonl');
const SPAWN_BROKER_SCRIPT = process.env.EVOLUTION_ARENA_SPAWN_BROKER_SCRIPT
  ? path.resolve(process.env.EVOLUTION_ARENA_SPAWN_BROKER_SCRIPT)
  : path.join(ROOT, 'systems', 'spawn', 'spawn_broker.js');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/evolution_arena.js run [--objective=<id>] [--variants=a,b,c] [--scores=a:0.72,b:0.61,c:0.75] [--strict=1|0]');
  console.log('  node systems/fractal/evolution_arena.js status');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 80) {
  return normalizeText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = normalizeText(v, 24).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: true,
    default_objective: 'T1_generational_wealth_v1',
    default_variants: ['incumbent', 'candidate_a', 'candidate_b'],
    requested_cells_per_variant: 1,
    synthetic_tokens_per_variant: 900,
    max_token_budget: 5000,
    min_promotion_gain: 0.04,
    loser_ttl_days: 3
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    strict_default: src.strict_default !== false,
    default_objective: normalizeText(src.default_objective || base.default_objective, 160) || base.default_objective,
    default_variants: Array.from(new Set((Array.isArray(src.default_variants) ? src.default_variants : base.default_variants)
      .map((v) => normalizeToken(v, 120))
      .filter(Boolean))),
    requested_cells_per_variant: clampInt(src.requested_cells_per_variant, 1, 16, base.requested_cells_per_variant),
    synthetic_tokens_per_variant: clampInt(src.synthetic_tokens_per_variant, 1, 500000, base.synthetic_tokens_per_variant),
    max_token_budget: clampInt(src.max_token_budget, 1, 10000000, base.max_token_budget),
    min_promotion_gain: clampNumber(src.min_promotion_gain, 0, 1, base.min_promotion_gain),
    loser_ttl_days: clampInt(src.loser_ttl_days, 1, 365, base.loser_ttl_days)
  };
}

function parseVariants(v, fallback) {
  const list = String(v || '')
    .split(',')
    .map((x) => normalizeToken(x, 120))
    .filter(Boolean);
  return list.length > 0 ? list : fallback.slice();
}

function parseScoresMap(v) {
  const out = {};
  for (const row of String(v || '').split(',').map((x) => x.trim()).filter(Boolean)) {
    const idx = row.indexOf(':');
    if (idx === -1) continue;
    const key = normalizeToken(row.slice(0, idx), 120);
    const val = Number(row.slice(idx + 1));
    if (!key || !Number.isFinite(val)) continue;
    out[key] = val;
  }
  return out;
}

function syntheticScore(objective, variant) {
  const digest = crypto.createHash('sha256').update(`${objective}|${variant}|evolution_arena`).digest('hex');
  const n = parseInt(digest.slice(0, 8), 16);
  return Number(((n % 1000) / 1000).toFixed(4));
}

function requestSpawnCell(variant, requestedCells) {
  if (!fs.existsSync(SPAWN_BROKER_SCRIPT)) {
    return {
      ok: false,
      reason: 'spawn_broker_missing'
    };
  }
  const r = spawnSync(process.execPath, [
    SPAWN_BROKER_SCRIPT,
    'request',
    `--module=evolution_arena_${variant}`,
    `--requested_cells=${requestedCells}`,
    '--apply=0'
  ], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  let payload = null;
  try {
    payload = JSON.parse(String(r.stdout || '').trim());
  } catch {}
  return {
    ok: r.status === 0,
    status: Number(r.status || 0),
    payload,
    stderr: String(r.stderr || '').trim()
  };
}

function runArena(args) {
  const policy = loadPolicy();
  const strict = toBool(args.strict, policy.strict_default);
  const objective = normalizeText(args.objective || policy.default_objective, 160) || policy.default_objective;
  const variants = parseVariants(args.variants, policy.default_variants);
  const scoresMap = parseScoresMap(args.scores || '');
  const tokensPerVariant = policy.synthetic_tokens_per_variant;
  const requestedCells = policy.requested_cells_per_variant;

  const totalBudget = tokensPerVariant * variants.length;
  const budgetOk = totalBudget <= policy.max_token_budget;

  const rows = [];
  for (const variant of variants) {
    const score = Number((Number(scoresMap[variant] != null ? scoresMap[variant] : syntheticScore(objective, variant))).toFixed(4));
    const spawn = requestSpawnCell(variant, requestedCells);
    rows.push({
      variant,
      score,
      token_budget: tokensPerVariant,
      spawn_request: spawn
    });
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return String(a.variant).localeCompare(String(b.variant));
  });

  const incumbent = rows.find((row) => row.variant === variants[0]) || rows[0] || null;
  const winner = rows[0] || null;
  const gain = winner && incumbent ? Number((winner.score - incumbent.score).toFixed(4)) : 0;
  const promote = !!(budgetOk && winner && incumbent && winner.variant !== incumbent.variant && gain >= policy.min_promotion_gain);

  const losers = rows
    .filter((row) => !winner || row.variant !== winner.variant)
    .map((row) => ({
      variant: row.variant,
      expire_after_days: policy.loser_ttl_days,
      cleanup_receipt: `cleanup_${normalizeToken(row.variant, 80)}_${Date.now()}`
    }));

  const out = {
    ok: budgetOk,
    type: 'evolution_arena_run',
    ts: nowIso(),
    strict,
    policy_version: policy.version,
    objective,
    variants,
    budget: {
      total_tokens: totalBudget,
      max_token_budget: policy.max_token_budget,
      budget_ok: budgetOk
    },
    incumbent: incumbent ? { variant: incumbent.variant, score: incumbent.score } : null,
    winner: winner ? { variant: winner.variant, score: winner.score } : null,
    gain,
    min_promotion_gain: policy.min_promotion_gain,
    promote,
    promotion: promote
      ? {
        from: incumbent.variant,
        to: winner.variant,
        reason: 'statistical_gain_gate_passed',
        objective
      }
      : null,
    rows,
    losers
  };

  writeJsonAtomic(LATEST_PATH, out);
  appendJsonl(HISTORY_PATH, out);

  process.stdout.write(JSON.stringify(out) + '\n');
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus() {
  const latest = readJson(LATEST_PATH, null);
  if (!latest) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'arena_state_missing', latest_path: relPath(LATEST_PATH) }) + '\n');
    process.exit(1);
  }
  const rows = readJsonl(HISTORY_PATH)
    .filter((row) => row && row.type === 'evolution_arena_run')
    .slice(-20);
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'evolution_arena_status',
    ts: nowIso(),
    latest_path: relPath(LATEST_PATH),
    history_path: relPath(HISTORY_PATH),
    recent_runs: rows.length,
    latest
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0], 64);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return runArena(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  syntheticScore
};
export {};
