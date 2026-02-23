#!/usr/bin/env node
'use strict';

/**
 * alignment_oracle.js
 *
 * Weekly strategic-alignment scorer:
 * - Computes weighted alignment from executed autonomy runs.
 * - Writes deterministic report artifacts.
 * - Emits human escalation entry when low-score streak persists.
 *
 * Usage:
 *   node systems/autonomy/alignment_oracle.js run [YYYY-MM-DD] [--threshold=60] [--min-week-samples=3]
 *   node systems/autonomy/alignment_oracle.js --help
 */

const fs = require('fs');
const path = require('path');
const { evaluateStrategicAlignment } = require('./tier1_governance.js');

const ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.AUTONOMY_RUNS_DIR
  ? path.resolve(process.env.AUTONOMY_RUNS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'runs');
const REPORT_DIR = process.env.AUTONOMY_ALIGNMENT_ORACLE_DIR
  ? path.resolve(process.env.AUTONOMY_ALIGNMENT_ORACLE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'alignment_oracle');
const REPORT_JSONL_PATH = path.join(REPORT_DIR, 'history.jsonl');
const PRESSURE_JSON_PATH = path.join(REPORT_DIR, 'pressure.json');
const ESCALATION_LOG_PATH = process.env.AUTONOMY_HUMAN_ESCALATION_LOG_PATH
  ? path.resolve(process.env.AUTONOMY_HUMAN_ESCALATION_LOG_PATH)
  : path.join(ROOT, 'state', 'security', 'autonomy_human_escalations.jsonl');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/alignment_oracle.js run [YYYY-MM-DD] [--threshold=60] [--min-week-samples=3] [--escalate=1|0]');
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

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function nowIso() {
  return new Date().toISOString();
}

function dateShift(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object') out.push(obj);
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function readRunsInWindow(endDate, days = 14) {
  const rows = [];
  for (let i = 0; i < Math.max(1, Number(days || 14)); i += 1) {
    const day = dateShift(endDate, -i);
    const fp = path.join(RUNS_DIR, `${day}.jsonl`);
    for (const row of readJsonl(fp)) {
      if (!row || typeof row !== 'object') continue;
      if (String(row.type || '') !== 'autonomy_run') continue;
      rows.push({ ...row, _day: day });
    }
  }
  rows.sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  return rows;
}

function evidenceLinks(endDate) {
  const rows = readRunsInWindow(endDate, 14)
    .filter((r) => String(r.result || '') === 'executed');

  const receiptIds = new Set();
  const proposalIds = new Set();
  const objectives = new Set();
  for (const row of rows) {
    const receiptId = String(row.receipt_id || '').trim();
    if (receiptId) receiptIds.add(receiptId);
    const proposalId = String(row.proposal_id || '').trim();
    if (proposalId) proposalIds.add(proposalId);
    const objectiveId = String(row.objective_id || '').trim();
    if (objectiveId) objectives.add(objectiveId);
  }

  return {
    receipt_ids: Array.from(receiptIds).slice(0, 48),
    proposal_ids: Array.from(proposalIds).slice(0, 48),
    objective_ids: Array.from(objectives).slice(0, 24)
  };
}

function existingOpenAlignmentEscalation(signature) {
  const rows = readJsonl(ESCALATION_LOG_PATH).filter((r) => {
    if (!r || typeof r !== 'object') return false;
    if (String(r.type || '') !== 'autonomy_human_escalation') return false;
    if (String(r.source || '') !== 'alignment_oracle') return false;
    if (String(r.signature || '') !== signature) return false;
    if (String(r.status || '').toLowerCase() === 'resolved') return false;
    return true;
  });
  return rows.length > 0;
}

function maybeEmitEscalation(payload, allowEscalate = true) {
  if (!allowEscalate) return { emitted: false, reason: 'escalation_disabled' };
  const align = payload && payload.alignment && typeof payload.alignment === 'object'
    ? payload.alignment
    : null;
  if (!align || align.escalate !== true) return { emitted: false, reason: 'no_low_streak' };

  const signature = `alignment_oracle:${String(payload.date || '')}:${String(align.threshold || '')}`;
  if (existingOpenAlignmentEscalation(signature)) {
    return { emitted: false, reason: 'already_open', signature };
  }

  const now = nowIso();
  const holdHours = Math.max(6, Number(process.env.AUTONOMY_ALIGNMENT_ESCALATION_HOLD_HOURS || 24));
  const expiresAt = new Date(Date.now() + holdHours * 60 * 60 * 1000).toISOString();
  const row = {
    ts: now,
    type: 'autonomy_human_escalation',
    source: 'alignment_oracle',
    signature,
    date: payload.date,
    status: 'open',
    severity: 'high',
    reason: 'low_weekly_alignment_two_weeks',
    expires_at: expiresAt,
    hold_hours: holdHours,
    alignment: {
      threshold: align.threshold,
      current_week: align.current_week,
      previous_week: align.previous_week
    },
    evidence: payload.evidence || {}
  };
  appendJsonl(ESCALATION_LOG_PATH, row);
  return { emitted: true, signature, expires_at: expiresAt };
}

function buildAlignmentPressure(payload) {
  const align = payload && payload.alignment && typeof payload.alignment === 'object'
    ? payload.alignment
    : {};
  const currentWeek = align && align.current_week && typeof align.current_week === 'object'
    ? align.current_week
    : {};
  const threshold = Number(align.threshold || 0);
  const score = Number(currentWeek.score);
  const sample = Number(currentWeek.sample || 0);
  const rawDeficit = Number.isFinite(score) && Number.isFinite(threshold)
    ? Math.max(0, threshold - score)
    : 0;
  const deficitRatio = Number.isFinite(threshold) && threshold > 0
    ? Math.max(0, Math.min(1, rawDeficit / threshold))
    : 0;
  const objectiveIds = payload && payload.evidence && Array.isArray(payload.evidence.objective_ids)
    ? payload.evidence.objective_ids.map((v) => String(v || '').trim()).filter(Boolean)
    : [];
  return {
    ok: true,
    type: 'alignment_pressure',
    ts: nowIso(),
    date: String(payload && payload.date || ''),
    active: deficitRatio >= 0.05 && sample >= 1,
    threshold: Number.isFinite(threshold) ? Number(threshold) : null,
    score: Number.isFinite(score) ? Number(score) : null,
    sample: Number.isFinite(sample) ? sample : 0,
    deficit_points: Number(rawDeficit.toFixed(3)),
    deficit_ratio: Number(deficitRatio.toFixed(4)),
    focus_objective_ids: objectiveIds.slice(0, 32),
    low_streak: align.low_streak === true,
    escalate: align.escalate === true
  };
}

function cmdRun(args) {
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const thresholdRaw = Number(args.threshold);
  const minSamplesRaw = Number(args['min-week-samples']);
  const threshold = Number.isFinite(thresholdRaw) ? thresholdRaw : 60;
  const minWeekSamples = Number.isFinite(minSamplesRaw) ? minSamplesRaw : 3;
  const escalate = String(args.escalate == null ? '1' : args.escalate).trim() !== '0';

  const alignment = evaluateStrategicAlignment({
    runsDir: RUNS_DIR,
    dateStr: date,
    threshold,
    minWeekSamples
  });

  const evidence = evidenceLinks(date);
  const payload = {
    ok: true,
    type: 'alignment_oracle',
    ts: nowIso(),
    date,
    alignment_score: Number(alignment && alignment.current_week && alignment.current_week.score != null
      ? alignment.current_week.score
      : 0),
    alignment,
    evidence
  };

  ensureDir(REPORT_DIR);
  const outPath = path.join(REPORT_DIR, `${date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(payload, null, 2), 'utf8');
  appendJsonl(REPORT_JSONL_PATH, payload);
  const pressure = buildAlignmentPressure(payload);
  writeJsonAtomic(PRESSURE_JSON_PATH, pressure);

  const escalation = maybeEmitEscalation(payload, escalate);
  const out = {
    ...payload,
    pressure,
    escalation,
    report_path: outPath,
    history_path: REPORT_JSONL_PATH,
    pressure_path: PRESSURE_JSON_PATH
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'run' || cmd === 'status') {
    cmdRun(args);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'alignment_oracle_failed') }) + '\n');
    process.exit(1);
  }
}
