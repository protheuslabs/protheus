#!/usr/bin/env node
'use strict';
export {};

/**
 * trit_shadow_weekly_adaptation.js
 *
 * Weekly, human-reviewed Trit trust adaptation suggestions.
 * This script does not auto-apply trust changes.
 *
 * Usage:
 *   node systems/autonomy/trit_shadow_weekly_adaptation.js run [YYYY-MM-DD]
 *   node systems/autonomy/trit_shadow_weekly_adaptation.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  loadTritShadowPolicy,
  loadTritShadowTrustState
} = require('../../lib/trit_shadow_control');

const ROOT = path.resolve(__dirname, '..', '..');
const CALIBRATION_HISTORY_PATH = process.env.AUTONOMY_TRIT_SHADOW_CALIBRATION_HISTORY_PATH
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_CALIBRATION_HISTORY_PATH)
  : path.join(ROOT, 'state', 'autonomy', 'trit_shadow_calibration', 'history.jsonl');
const ADAPTATION_DIR = process.env.AUTONOMY_TRIT_SHADOW_ADAPTATION_DIR
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_ADAPTATION_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'trit_shadow_adaptation');
const ADAPTATION_HISTORY_PATH = path.join(ADAPTATION_DIR, 'history.jsonl');
const PROPOSALS_DIR = process.env.AUTONOMY_TRIT_SHADOW_PROPOSALS_DIR
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_PROPOSALS_DIR)
  : path.join(ROOT, 'state', 'sensory', 'proposals');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/trit_shadow_weekly_adaptation.js run [YYYY-MM-DD]');
  console.log('  node systems/autonomy/trit_shadow_weekly_adaptation.js status [YYYY-MM-DD]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(arg);
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

function todayStr() {
  return nowIso().slice(0, 10);
}

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
  const out = [];
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row && typeof row === 'object') out.push(row);
    } catch {
      // ignore malformed lines
    }
  }
  return out;
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function loadLatestCalibration(onOrBeforeDate) {
  const rows = readJsonl(CALIBRATION_HISTORY_PATH)
    .filter((row) => row && typeof row === 'object')
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')));
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    const d = String(row.date || '').slice(0, 10);
    if (!isDateStr(d)) continue;
    if (d <= onOrBeforeDate) return row;
  }
  return null;
}

function deriveSuggestions(dateStr) {
  const policy = loadTritShadowPolicy();
  const trustState = loadTritShadowTrustState(policy);
  const adaptation = policy && policy.adaptation && typeof policy.adaptation === 'object'
    ? policy.adaptation
    : {};
  const trustPolicy = policy && policy.trust && typeof policy.trust === 'object'
    ? policy.trust
    : {};
  const floor = Number(trustPolicy.source_trust_floor || 0.6);
  const ceiling = Number(trustPolicy.source_trust_ceiling || 1.5);
  const reward = Number(adaptation.reward_step || 0.04);
  const penalty = Number(adaptation.penalty_step || 0.06);
  const maxDelta = Number(adaptation.max_delta_per_cycle || 0.08);
  const minSamples = Math.max(1, Number(adaptation.min_samples_per_source || 6));
  const calibration = loadLatestCalibration(dateStr);
  const reliability = calibration && Array.isArray(calibration.source_reliability)
    ? calibration.source_reliability
    : [];

  const suggestions = [];
  for (const row of reliability) {
    if (!row || typeof row !== 'object') continue;
    const source = String(row.source || '').trim();
    if (!source) continue;
    const samples = Math.max(0, Number(row.samples || 0));
    if (samples < minSamples) continue;
    const rel = clampNumber(row.reliability, 0, 1, 0.5);
    const currentRec = trustState.by_source && trustState.by_source[source] && typeof trustState.by_source[source] === 'object'
      ? trustState.by_source[source]
      : {};
    const currentTrust = clampNumber(
      currentRec.trust,
      floor,
      ceiling,
      Number(trustState.default_source_trust || trustPolicy.default_source_trust || 1)
    );
    let delta = 0;
    let reason = 'hold';
    if (rel >= 0.65) {
      delta = Math.min(maxDelta, reward);
      reason = 'high_reliability_reward';
    } else if (rel <= 0.45) {
      delta = -Math.min(maxDelta, penalty);
      reason = 'low_reliability_penalty';
    }
    if (delta === 0) continue;
    const suggestedTrust = clampNumber(currentTrust + delta, floor, ceiling, currentTrust);
    suggestions.push({
      source,
      samples,
      reliability: Number(rel.toFixed(4)),
      current_trust: Number(currentTrust.toFixed(4)),
      suggested_trust: Number(suggestedTrust.toFixed(4)),
      delta: Number((suggestedTrust - currentTrust).toFixed(4)),
      reason
    });
  }

  return {
    policy_version: String(policy.version || '1.0'),
    calibration_date: calibration ? String(calibration.date || '') : null,
    calibration_summary: calibration && calibration.summary ? calibration.summary : null,
    suggestions: suggestions
      .sort((a, b) => Math.abs(Number(b.delta || 0)) - Math.abs(Number(a.delta || 0)))
      .slice(0, 64)
  };
}

function upsertReviewProposal(dateStr, payload) {
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  const raw = readJson(fp, []);
  const proposals = Array.isArray(raw) ? raw.slice() : [];
  const type = 'trit_shadow_trust_adjustment_review';
  const existing = proposals.find((row) => row && String(row.type || '') === type);
  const id = existing && existing.id
    ? String(existing.id)
    : `TRIT-ADAPT-${crypto.createHash('sha256').update(`${dateStr}|${type}`).digest('hex').slice(0, 14)}`;
  const proposal = {
    id,
    type,
    title: 'Review Trit shadow trust adaptation suggestions',
    summary: `Weekly Trit trust suggestions generated (${Number(payload && payload.suggestions && payload.suggestions.length || 0)} source updates).`,
    expected_impact: 'medium',
    risk: 'low',
    validation: [
      'Review each source suggestion and approve/reject manually',
      'Apply approved trust changes via guarded workflow only',
      'Re-run trit shadow replay calibration before and after apply'
    ],
    meta: {
      source_eye: 'trit_shadow_weekly_adaptation',
      human_review_required: true,
      suggestions_count: Number(payload && payload.suggestions && payload.suggestions.length || 0),
      calibration_date: payload && payload.calibration_date ? String(payload.calibration_date) : null
    },
    evidence: [
      {
        source: 'trit_shadow_calibration',
        path: path.relative(ROOT, CALIBRATION_HISTORY_PATH).replace(/\\/g, '/'),
        match: payload && payload.calibration_date ? `date=${payload.calibration_date}` : 'latest',
        evidence_ref: 'trit_shadow_calibration'
      }
    ],
    notes: 'Human review required before any trust-state mutation.'
  };
  const next = proposals.filter((row) => !(row && String(row.type || '') === type));
  next.push(proposal);
  writeJson(fp, next);
  return {
    proposal_id: id,
    proposal_path: fp
  };
}

function buildResult(dateStr, opts = {}) {
  const derived = deriveSuggestions(dateStr);
  const review = opts.persist_proposal === false
    ? null
    : upsertReviewProposal(dateStr, derived);
  return {
    ok: true,
    type: 'trit_shadow_weekly_adaptation',
    ts: nowIso(),
    date: dateStr,
    human_review_required: true,
    ...derived,
    review
  };
}

function cmdRun(args, opts) {
  const dateStr = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const out = buildResult(dateStr, { persist_proposal: opts.write === true });
  if (opts.write) {
    const outPath = path.join(ADAPTATION_DIR, `${dateStr}.json`);
    writeJson(outPath, out);
    appendJsonl(ADAPTATION_HISTORY_PATH, out);
    out.report_path = outPath;
    out.history_path = ADAPTATION_HISTORY_PATH;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'run') {
    cmdRun(args, { write: true });
    return;
  }
  if (cmd === 'status') {
    cmdRun(args, { write: false });
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'trit_shadow_weekly_adaptation_failed') }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  deriveSuggestions,
  buildResult
};
