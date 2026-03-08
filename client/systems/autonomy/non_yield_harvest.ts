#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_AUTONOMY_DIR = fs.existsSync(path.join(ROOT, 'local', 'state', 'autonomy'))
  ? path.join(ROOT, 'local', 'state', 'autonomy')
  : path.join(ROOT, 'state', 'autonomy');
const AUTONOMY_DIR = process.env.AUTONOMY_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_STATE_DIR)
  : DEFAULT_AUTONOMY_DIR;
const LEDGER_PATH = process.env.AUTONOMY_NON_YIELD_LEDGER_PATH
  ? path.resolve(process.env.AUTONOMY_NON_YIELD_LEDGER_PATH)
  : path.join(AUTONOMY_DIR, 'non_yield_ledger.jsonl');
const OUTPUT_DIR = process.env.AUTONOMY_AUTOPHAGY_CANDIDATES_DIR
  ? path.resolve(process.env.AUTONOMY_AUTOPHAGY_CANDIDATES_DIR)
  : path.join(AUTONOMY_DIR, 'autophagy_candidates');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/non_yield_harvest.js run [YYYY-MM-DD] [--lookback-days=N] [--quarantine-days=N] [--min-support=N] [--min-confidence=0..1] [--write=1|0]');
  console.log('  node systems/autonomy/non_yield_harvest.js status [YYYY-MM-DD] [--lookback-days=N] [--quarantine-days=N] [--min-support=N] [--min-confidence=0..1]');
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

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function resolveDate(args) {
  const first = String(args._[1] || '').trim();
  if (isDateStr(first)) return first;
  const second = String(args._[0] || '').trim();
  if (isDateStr(second)) return second;
  return todayStr();
}

function toInt(v, fallback, lo = 0, hi = 365) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function toNum(v, fallback, lo = 0, hi = 1) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function readJsonl(fp) {
  if (!fs.existsSync(fp)) return [];
  return fs.readFileSync(fp, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function normalizeText(v) {
  return String(v == null ? '' : v).trim();
}

function parseTs(v) {
  const t = new Date(String(v || ''));
  return Number.isFinite(t.getTime()) ? t.getTime() : null;
}

function clamp(v, lo, hi) {
  if (!Number.isFinite(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function isoWeekId(dateStr) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (!Number.isFinite(d.getTime())) return `${String(dateStr || 'unknown')}`;
  const thursday = new Date(d);
  thursday.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((thursday.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  const y = thursday.getUTCFullYear();
  return `${y}-W${String(week).padStart(2, '0')}`;
}

function actionForCategory(category, reason) {
  const c = normalizeText(category).toLowerCase();
  const r = normalizeText(reason).toLowerCase();
  if (c === 'budget_hold') {
    return {
      policy_family: 'cost_pacing',
      suggestion: 'Lower estimated-token admission for this pattern or route to cheaper execution tier.',
      guardrail: 'No change if effective_yield drops or safety_stop_rate increases in replay.'
    };
  }
  if (c === 'policy_hold') {
    return {
      policy_family: 'intake_filter',
      suggestion: 'Tighten intake threshold or routing prefilter for this hold pattern.',
      guardrail: 'No change if policy_hold_rate increases in replay.'
    };
  }
  if (c === 'safety_stop') {
    return {
      policy_family: 'risk_guard',
      suggestion: 'Promote this stop reason into preflight prevention to avoid runtime safety stops.',
      guardrail: 'Never relax safety guards; allow only stronger preflight filters.'
    };
  }
  if (r.includes('executed_reverted') || r.includes('executed_no_change')) {
    return {
      policy_family: 'execution_quality',
      suggestion: 'Raise verification strictness or require clearer success criteria for this failure mode.',
      guardrail: 'Reject if effective_drift worsens by >0.003 in replay.'
    };
  }
  return {
    policy_family: 'actionability_filter',
    suggestion: 'Increase actionability/objective-binding threshold for this no-progress pattern.',
    guardrail: 'Reject if attempt volume collapses without improving drift or yield.'
  };
}

function candidateId(category, reason) {
  const key = `${normalizeText(category).toLowerCase()}|${normalizeText(reason).toLowerCase()}`;
  return `NYC-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 12)}`;
}

function computeHarvest(endDateStr, opts = {}) {
  const lookbackDays = toInt(opts.lookback_days, 30, 1, 365);
  const quarantineDays = toInt(opts.quarantine_days, 7, 0, 90);
  const minSupport = toInt(opts.min_support, 5, 1, 10000);
  const minConfidence = toNum(opts.min_confidence, 0.65, 0, 1);

  const endMs = Date.parse(`${endDateStr}T23:59:59.999Z`);
  if (!Number.isFinite(endMs)) {
    throw new Error(`invalid_date:${endDateStr}`);
  }
  const lookbackStartMs = Date.parse(`${endDateStr}T00:00:00.000Z`) - ((lookbackDays - 1) * 86400000);
  const quarantineCutoffMs = Date.parse(`${endDateStr}T00:00:00.000Z`) - (quarantineDays * 86400000);

  const rows = readJsonl(LEDGER_PATH);
  let scanned = 0;
  let malformedTs = 0;
  let inLookback = 0;
  let droppedQuarantine = 0;
  const groups = new Map();

  for (const row of rows) {
    if (!row || String(row.type || '') !== 'autonomy_non_yield') continue;
    scanned += 1;
    const tsMs = parseTs(row.ts);
    if (!Number.isFinite(tsMs)) {
      malformedTs += 1;
      continue;
    }
    if (tsMs < lookbackStartMs || tsMs > endMs) continue;
    inLookback += 1;
    if (quarantineDays > 0 && tsMs >= quarantineCutoffMs) {
      droppedQuarantine += 1;
      continue;
    }

    const category = normalizeText(row.category).toLowerCase() || 'unknown';
    const reason = normalizeText(row.reason).toLowerCase() || 'unknown';
    const key = `${category}::${reason}`;
    const prev = groups.get(key) || {
      category,
      reason,
      count: 0,
      proposal_ids: new Set(),
      objective_ids: new Set(),
      last_seen_ts: null,
      sample: null
    };
    prev.count += 1;
    const pid = normalizeText(row.proposal_id);
    const oid = normalizeText(row.objective_id);
    if (pid) prev.proposal_ids.add(pid);
    if (oid) prev.objective_ids.add(oid);
    if (!prev.last_seen_ts || String(row.ts) > prev.last_seen_ts) prev.last_seen_ts = String(row.ts);
    if (!prev.sample) {
      prev.sample = {
        result: normalizeText(row.result) || null,
        outcome: normalizeText(row.outcome) || null,
        execution_mode: normalizeText(row.execution_mode) || null
      };
    }
    groups.set(key, prev);
  }

  const candidates = [];
  for (const group of groups.values()) {
    const count = Number(group.count || 0);
    if (count < minSupport) continue;
    const supportScore = clamp(count / (minSupport * 2), 0, 1);
    const objectiveSpread = group.objective_ids.size > 1 ? 0.08 : (group.objective_ids.size === 1 ? 0.04 : 0);
    const confidence = clamp(0.45 + (supportScore * 0.42) + objectiveSpread, 0, 0.95);
    if (confidence < minConfidence) continue;
    const action = actionForCategory(group.category, group.reason);
    candidates.push({
      candidate_id: candidateId(group.category, group.reason),
      category: group.category,
      reason: group.reason,
      support_count: count,
      confidence: Number(confidence.toFixed(3)),
      objective_spread: group.objective_ids.size,
      proposal_spread: group.proposal_ids.size,
      last_seen_ts: group.last_seen_ts,
      policy_family: action.policy_family,
      suggestion: action.suggestion,
      guardrail: action.guardrail,
      sample: group.sample
    });
  }

  candidates.sort((a, b) => {
    if (b.support_count !== a.support_count) return b.support_count - a.support_count;
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return String(a.candidate_id).localeCompare(String(b.candidate_id));
  });

  return {
    ok: true,
    type: 'autonomy_non_yield_harvest',
    ts: new Date().toISOString(),
    end_date: endDateStr,
    week_id: isoWeekId(endDateStr),
    source_ledger_path: LEDGER_PATH,
    policy: {
      lookback_days: lookbackDays,
      quarantine_days: quarantineDays,
      min_support: minSupport,
      min_confidence: Number(minConfidence.toFixed(3))
    },
    counts: {
      scanned,
      malformed_ts: malformedTs,
      in_lookback: inLookback,
      dropped_quarantine: droppedQuarantine,
      groups: groups.size,
      candidates: candidates.length
    },
    candidates
  };
}

function writeOutput(payload) {
  ensureDir(OUTPUT_DIR);
  const fp = path.join(OUTPUT_DIR, `${payload.week_id}.json`);
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  return fp;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  const dateStr = resolveDate(args);
  const payload = computeHarvest(dateStr, {
    lookback_days: args['lookback-days'] != null ? args['lookback-days'] : args.lookback_days,
    quarantine_days: args['quarantine-days'] != null ? args['quarantine-days'] : args.quarantine_days,
    min_support: args['min-support'] != null ? args['min-support'] : args.min_support,
    min_confidence: args['min-confidence'] != null ? args['min-confidence'] : args.min_confidence
  });
  const write = cmd === 'run' && String(args.write == null ? '1' : args.write).trim() !== '0';
  if (write) payload.report_path = writeOutput(payload);
  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'non_yield_harvest_failed') }) + '\n');
    process.exit(1);
  }
}
