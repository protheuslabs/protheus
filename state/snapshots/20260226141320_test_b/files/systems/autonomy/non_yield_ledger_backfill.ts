#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const AUTONOMY_DIR = process.env.AUTONOMY_STATE_DIR
  ? path.resolve(process.env.AUTONOMY_STATE_DIR)
  : path.join(ROOT, 'state', 'autonomy');
const RUNS_DIR = process.env.AUTONOMY_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_RUNS_DIR)
  : path.join(AUTONOMY_DIR, 'runs');
const NON_YIELD_LEDGER_PATH = process.env.AUTONOMY_NON_YIELD_LEDGER_PATH
  ? path.resolve(process.env.AUTONOMY_NON_YIELD_LEDGER_PATH)
  : path.join(AUTONOMY_DIR, 'non_yield_ledger.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/non_yield_ledger_backfill.js run [YYYY-MM-DD] [--days=N] [--write=1|0]');
  console.log('  node systems/autonomy/non_yield_ledger_backfill.js status [YYYY-MM-DD] [--days=N]');
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

function toInt(v, fallback, lo = 1, hi = 365) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
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

function appendJsonl(fp, rows) {
  if (!Array.isArray(rows) || rows.length <= 0) return;
  ensureDir(path.dirname(fp));
  const body = rows.map((row) => JSON.stringify(row)).join('\n') + '\n';
  fs.appendFileSync(fp, body);
}

function dateWindow(endDateStr, days) {
  const end = new Date(`${endDateStr}T00:00:00.000Z`);
  if (Number.isNaN(end.getTime())) return [];
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(end);
    d.setUTCDate(end.getUTCDate() - i);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function normalizeSpaces(v) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim();
}

function runEventProposalId(evt) {
  if (!evt || typeof evt !== 'object') return '';
  const topEscalation = evt.top_escalation && typeof evt.top_escalation === 'object'
    ? evt.top_escalation
    : {};
  return normalizeSpaces(
    evt.proposal_id
    || evt.selected_proposal_id
    || topEscalation.proposal_id
    || ''
  );
}

function sanitizeObjectiveId(raw) {
  const out = normalizeSpaces(raw);
  if (!out) return '';
  return out.replace(/[^\w:-]/g, '_');
}

function runEventObjectiveId(evt) {
  if (!evt || typeof evt !== 'object') return '';
  const pulse = evt.directive_pulse && typeof evt.directive_pulse === 'object'
    ? evt.directive_pulse
    : {};
  const binding = evt.objective_binding && typeof evt.objective_binding === 'object'
    ? evt.objective_binding
    : {};
  const topEscalation = evt.top_escalation && typeof evt.top_escalation === 'object'
    ? evt.top_escalation
    : {};
  return sanitizeObjectiveId(
    pulse.objective_id
    || evt.objective_id
    || binding.objective_id
    || topEscalation.objective_id
    || ''
  );
}

function isPolicyHoldResult(result) {
  const r = String(result || '').trim();
  if (!r) return false;
  return r.startsWith('no_candidates_policy_')
    || r === 'stop_init_gate_budget_autopause'
    || r === 'stop_init_gate_readiness'
    || r === 'stop_init_gate_readiness_blocked'
    || r === 'stop_init_gate_criteria_quality_insufficient'
    || r === 'score_only_fallback_route_block'
    || r === 'score_only_fallback_low_execution_confidence';
}

function isPolicyHoldRunEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (evt.policy_hold === true) return true;
  return isPolicyHoldResult(evt.result);
}

function isNoProgressRun(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  if (isPolicyHoldRunEvent(evt)) return false;
  if (evt.result === 'executed') return evt.outcome !== 'shipped';
  return evt.result === 'init_gate_stub'
    || evt.result === 'init_gate_low_score'
    || evt.result === 'init_gate_blocked_route'
    || evt.result === 'stop_repeat_gate_capability_cap'
    || evt.result === 'stop_repeat_gate_directive_pulse_cooldown'
    || evt.result === 'stop_repeat_gate_directive_pulse_tier_reservation'
    || evt.result === 'stop_repeat_gate_human_escalation_pending'
    || evt.result === 'stop_repeat_gate_stale_signal'
    || evt.result === 'stop_init_gate_quality_exhausted'
    || evt.result === 'stop_init_gate_directive_fit_exhausted'
    || evt.result === 'stop_init_gate_actionability_exhausted'
    || evt.result === 'stop_init_gate_optimization_good_enough'
    || evt.result === 'stop_init_gate_value_signal_exhausted'
    || evt.result === 'stop_init_gate_tier1_governance'
    || evt.result === 'stop_init_gate_medium_risk_guard'
    || evt.result === 'stop_init_gate_medium_requires_canary'
    || evt.result === 'stop_init_gate_composite_exhausted'
    || evt.result === 'stop_repeat_gate_capability_cooldown'
    || evt.result === 'stop_repeat_gate_capability_no_change_cooldown'
    || evt.result === 'stop_repeat_gate_medium_canary_cap'
    || evt.result === 'stop_repeat_gate_candidate_exhausted'
    || evt.result === 'stop_repeat_gate_preview_churn_cooldown'
    || evt.result === 'stop_repeat_gate_exhaustion_cooldown'
    || evt.result === 'stop_repeat_gate_no_progress'
    || evt.result === 'stop_repeat_gate_dopamine';
}

function isSafetyStopRunEvent(evt) {
  if (!evt || evt.type !== 'autonomy_run') return false;
  const result = String(evt.result || '');
  return result.includes('human_escalation')
    || result.includes('tier1_governance')
    || result.includes('medium_risk_guard')
    || result.includes('capability_cooldown')
    || result.includes('directive_pulse_tier_reservation');
}

function classifyNonYieldCategory(evt) {
  if (!evt || evt.type !== 'autonomy_run') return null;
  const result = String(evt.result || '');
  if (!result || result === 'lock_busy' || result === 'stop_repeat_gate_interval') return null;
  if (isPolicyHoldRunEvent(evt)) {
    const reason = normalizeSpaces(evt.hold_reason || evt.route_block_reason || evt.result).toLowerCase();
    if (result.includes('budget') || reason.includes('budget') || reason.includes('autopause')) return 'budget_hold';
    return 'policy_hold';
  }
  if (isSafetyStopRunEvent(evt)) return 'safety_stop';
  if (isNoProgressRun(evt)) return 'no_progress';
  return null;
}

function nonYieldReasonFromRun(evt, category) {
  const explicit = normalizeSpaces(evt && (evt.hold_reason || evt.route_block_reason || evt.reason)).toLowerCase();
  if (explicit) return explicit;
  const result = normalizeSpaces(evt && evt.result).toLowerCase();
  const outcome = normalizeSpaces(evt && evt.outcome).toLowerCase();
  if (category === 'no_progress' && result === 'executed') {
    return outcome ? `executed_${outcome}` : 'executed_no_progress';
  }
  if (result) return result;
  return `${String(category || 'non_yield').toLowerCase()}_unknown`;
}

function rowDate(ts, fallbackDate) {
  const t = Date.parse(String(ts || ''));
  if (Number.isFinite(t)) return new Date(t).toISOString().slice(0, 10);
  return String(fallbackDate || '').slice(0, 10) || todayStr();
}

function buildLedgerCard(runEvt, fallbackDate) {
  const category = classifyNonYieldCategory(runEvt);
  if (!category) return null;
  const objectiveId = runEventObjectiveId(runEvt);
  const proposalId = runEventProposalId(runEvt);
  const riskRaw = normalizeSpaces(runEvt.risk != null ? runEvt.risk : runEvt.proposal_risk).toLowerCase();
  const risk = riskRaw === 'low' || riskRaw === 'medium' || riskRaw === 'high'
    ? riskRaw
    : null;
  const ts = String(runEvt.ts || '').trim() || new Date().toISOString();
  return {
    ts,
    type: 'autonomy_non_yield',
    source: 'autonomy_run_backfill',
    date: rowDate(ts, fallbackDate),
    category,
    reason: nonYieldReasonFromRun(runEvt, category),
    result: String(runEvt.result || ''),
    outcome: String(runEvt.outcome || ''),
    policy_hold: isPolicyHoldRunEvent(runEvt),
    attempt_like: runEvt.type === 'autonomy_run',
    proposal_id: proposalId || null,
    objective_id: objectiveId || null,
    risk,
    execution_mode: normalizeSpaces(runEvt.execution_mode || runEvt.mode) || null
  };
}

function cardKey(card) {
  return [
    String(card.ts || ''),
    String(card.result || ''),
    String(card.category || ''),
    String(card.reason || ''),
    String(card.proposal_id || ''),
    String(card.objective_id || '')
  ].join('|');
}

function existingLedgerKeys() {
  const keys = new Set();
  const rows = readJsonl(NON_YIELD_LEDGER_PATH);
  for (const row of rows) {
    if (!row || String(row.type || '') !== 'autonomy_non_yield') continue;
    keys.add(cardKey(row));
  }
  return keys;
}

function backfill(endDateStr, days, write) {
  const dates = dateWindow(endDateStr, days);
  const keys = existingLedgerKeys();
  const staged = [];
  let scanned = 0;
  let classified = 0;
  for (const d of dates) {
    const fp = path.join(RUNS_DIR, `${d}.jsonl`);
    const rows = readJsonl(fp);
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      scanned += 1;
      const card = buildLedgerCard(evt, d);
      if (!card) continue;
      classified += 1;
      const key = cardKey(card);
      if (keys.has(key)) continue;
      keys.add(key);
      staged.push(card);
    }
  }
  staged.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  if (write && staged.length > 0) appendJsonl(NON_YIELD_LEDGER_PATH, staged);
  const categoryCounts = {};
  for (const card of staged) {
    const cat = String(card.category || 'unknown');
    categoryCounts[cat] = Number(categoryCounts[cat] || 0) + 1;
  }
  return {
    ok: true,
    type: 'autonomy_non_yield_ledger_backfill',
    ts: new Date().toISOString(),
    end_date: endDateStr,
    days,
    write: !!write,
    source_runs_dir: RUNS_DIR,
    ledger_path: NON_YIELD_LEDGER_PATH,
    counts: {
      scanned_runs: scanned,
      classified_runs: classified,
      inserted_rows: staged.length
    },
    inserted_by_category: categoryCounts
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  const dateStr = resolveDate(args);
  const days = toInt(args.days, 180, 1, 365);
  const write = cmd === 'run'
    ? String(args.write == null ? '1' : args.write).trim() !== '0'
    : false;
  const out = backfill(dateStr, days, write);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'non_yield_ledger_backfill_failed')
    }) + '\n');
    process.exit(1);
  }
}
