#!/usr/bin/env node
'use strict';
export {};

/**
 * strategy_principles.js
 *
 * Derive and validate implementation principles from the active strategy profile.
 * Output is machine-readable and consumed by workflow generation + ops visibility.
 *
 * Usage:
 *   node systems/strategy/strategy_principles.js run [YYYY-MM-DD]
 *   node systems/strategy/strategy_principles.js status [YYYY-MM-DD|latest]
 */

const fs = require('fs');
const path = require('path');
const {
  loadActiveStrategy,
  strategyBudgetCaps,
  strategyPromotionPolicy,
  strategyMaxRiskPerAction
} = require('../../lib/strategy_resolver');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = process.env.STRATEGY_PRINCIPLES_OUT_DIR
  ? path.resolve(process.env.STRATEGY_PRINCIPLES_OUT_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'principles');
const HISTORY_PATH = path.join(OUT_DIR, 'history.jsonl');
const LATEST_PATH = path.join(OUT_DIR, 'latest.json');
const INVERSION_FIRST_PRINCIPLE_LATEST_PATH = process.env.STRATEGY_PRINCIPLES_INVERSION_PATH
  ? path.resolve(process.env.STRATEGY_PRINCIPLES_INVERSION_PATH)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'inversion', 'first_principles', 'latest.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/strategy/strategy_principles.js run [YYYY-MM-DD]');
  console.log('  node systems/strategy/strategy_principles.js status [YYYY-MM-DD|latest]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function cleanText(v, maxLen = 180) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function clampNumber(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function outputPath(dateStr) {
  return path.join(OUT_DIR, `${dateStr}.json`);
}

function evaluatePrinciples(strategy) {
  const objective = strategy && strategy.objective && typeof strategy.objective === 'object'
    ? strategy.objective
    : {};
  const ranking = strategy && strategy.ranking_weights && typeof strategy.ranking_weights === 'object'
    ? strategy.ranking_weights
    : {};
  const promotion = strategyPromotionPolicy(strategy, {});
  const budget = strategyBudgetCaps(strategy, {});
  const maxRisk = strategyMaxRiskPerAction(strategy, 35);

  const checks = [
    {
      id: 'objective_clarity',
      label: 'Objective clarity',
      statement: 'Objective must be explicit and actionable.',
      pass: cleanText(objective.primary || '', 400).length >= 18,
      signal: { objective_primary: cleanText(objective.primary || '', 220) },
      enforced_by: ['strategy.objective.primary', 'strategy campaigns']
    },
    {
      id: 'risk_bounded',
      label: 'Risk bounded',
      statement: 'Risk envelope must be bounded and explicit.',
      pass: Number(maxRisk || 0) > 0 && Number(maxRisk || 0) <= 75,
      signal: {
        max_risk_per_action: Number(maxRisk || 0),
        allowed_risks: Array.isArray(strategy && strategy.risk_policy && strategy.risk_policy.allowed_risks)
          ? strategy.risk_policy.allowed_risks.slice(0, 4)
          : []
      },
      enforced_by: ['strategy.risk_policy', 'autonomy admission gate']
    },
    {
      id: 'evidence_first',
      label: 'Evidence first',
      statement: 'Promotion requires measurable evidence quality.',
      pass: Number(promotion.min_success_criteria_receipts || 0) >= 1
        && Number(promotion.min_success_criteria_pass_rate || 0) >= 0.5,
      signal: {
        min_success_criteria_receipts: Number(promotion.min_success_criteria_receipts || 0),
        min_success_criteria_pass_rate: Number(promotion.min_success_criteria_pass_rate || 0)
      },
      enforced_by: ['strategy.promotion_policy', 'strategy_mode_governor']
    },
    {
      id: 'budget_discipline',
      label: 'Budget discipline',
      statement: 'Run and token caps must be present.',
      pass: Number(budget.daily_runs_cap || 0) > 0
        && Number(budget.daily_token_cap || 0) > 0
        && Number(budget.max_tokens_per_action || 0) > 0,
      signal: {
        daily_runs_cap: Number(budget.daily_runs_cap || 0),
        daily_token_cap: Number(budget.daily_token_cap || 0),
        max_tokens_per_action: Number(budget.max_tokens_per_action || 0)
      },
      enforced_by: ['strategy.budget_policy', 'system_budget']
    },
    {
      id: 'ranking_balance',
      label: 'Ranking balance',
      statement: 'Ranking should not collapse onto a single signal.',
      pass: (() => {
        const values = Object.values(ranking || {}).map((v) => Number(v)).filter((v) => Number.isFinite(v) && v > 0);
        if (values.length < 3) return false;
        const maxWeight = Math.max(...values);
        return maxWeight <= 0.55;
      })(),
      signal: {
        weights: ranking
      },
      enforced_by: ['strategy.ranking_weights', 'autonomy strategy ranker']
    }
  ];

  const passed = checks.filter((c) => c.pass === true).length;
  const score = Number((passed / Math.max(1, checks.length)).toFixed(4));
  return {
    checks,
    summary: {
      checks_total: checks.length,
      checks_passed: passed,
      checks_failed: checks.length - passed,
      score,
      band: score >= 0.8 ? 'strong' : (score >= 0.6 ? 'acceptable' : 'weak')
    }
  };
}

function loadInversionFeedback() {
  const latest = readJson(INVERSION_FIRST_PRINCIPLE_LATEST_PATH, null);
  if (!latest || typeof latest !== 'object') {
    return {
      available: false,
      polarity: 0,
      confidence: 0,
      suggested_bonus: 0,
      principle_id: null,
      source: null
    };
  }
  const confidence = clampNumber(latest.confidence, 0, 1, 0);
  const polarity = clampNumber(latest.polarity, -1, 1, 1);
  const suggestedBonus = latest.strategy_feedback && typeof latest.strategy_feedback === 'object'
    ? clampNumber(latest.strategy_feedback.suggested_bonus, -0.25, 0.25, 0)
    : 0;
  return {
    available: true,
    polarity,
    confidence,
    suggested_bonus: Number((suggestedBonus * Math.max(0, confidence)).toFixed(6)),
    principle_id: cleanText(latest.id || '', 80) || null,
    source: cleanText(latest.source || '', 80) || null
  };
}

function runCmd(dateStr) {
  const strategy = loadActiveStrategy({ allowMissing: true });
  if (!strategy || typeof strategy !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'strategy_principles',
      date: dateStr,
      error: 'active_strategy_missing'
    })}\n`);
    process.exit(1);
  }

  const evalResult = evaluatePrinciples(strategy);
  const inversionFeedback = loadInversionFeedback();
  const baseScore = Number(evalResult.summary.score || 0);
  const inversionBonus = inversionFeedback.available
    ? Number(inversionFeedback.suggested_bonus || 0)
    : 0;
  const finalScore = clampNumber(baseScore + inversionBonus, 0, 1, baseScore);
  const finalBand = finalScore >= 0.8 ? 'strong' : (finalScore >= 0.6 ? 'acceptable' : 'weak');
  const payload = {
    ok: true,
    type: 'strategy_principles',
    ts: nowIso(),
    date: dateStr,
    strategy_id: String(strategy.id || ''),
    strategy_name: String(strategy.name || ''),
    objective_primary: cleanText(strategy.objective && strategy.objective.primary || '', 240),
    principles: evalResult.checks,
    summary: {
      ...evalResult.summary,
      base_score: Number(baseScore.toFixed(6)),
      inversion_bonus: Number(inversionBonus.toFixed(6)),
      score: Number(finalScore.toFixed(6)),
      band: finalBand
    },
    inversion_feedback: inversionFeedback
  };

  const fp = outputPath(dateStr);
  writeJsonAtomic(fp, payload);
  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(HISTORY_PATH, {
    ts: payload.ts,
    type: payload.type,
    date: payload.date,
    strategy_id: payload.strategy_id,
    score: payload.summary.score,
    band: payload.summary.band,
    checks_failed: payload.summary.checks_failed,
    inversion_bonus: payload.summary.inversion_bonus,
    inversion_principle_id: payload.inversion_feedback ? payload.inversion_feedback.principle_id : null
  });

  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: payload.type,
    date: payload.date,
    strategy_id: payload.strategy_id,
    score: payload.summary.score,
    band: payload.summary.band,
    checks_failed: payload.summary.checks_failed,
    inversion_bonus: payload.summary.inversion_bonus,
    inversion_principle_id: payload.inversion_feedback ? payload.inversion_feedback.principle_id : null,
    output_path: path.relative(REPO_ROOT, fp).replace(/\\/g, '/')
  })}\n`);
}

function statusCmd(dateArg) {
  const dateStr = String(dateArg || '').trim().toLowerCase() === 'latest'
    ? 'latest'
    : dateArgOrToday(dateArg);
  const fp = dateStr === 'latest' ? LATEST_PATH : outputPath(dateStr);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'strategy_principles_status',
      date: dateStr === 'latest' ? null : dateStr,
      error: 'principles_snapshot_missing'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'strategy_principles_status',
    date: payload.date || null,
    ts: payload.ts || null,
    strategy_id: payload.strategy_id || null,
    score: payload.summary ? clampNumber(payload.summary.score, 0, 1, 0) : null,
    band: payload.summary ? payload.summary.band || null : null,
    checks_failed: payload.summary ? Number(payload.summary.checks_failed || 0) : null
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') return runCmd(dateArgOrToday(args._[1]));
  if (cmd === 'status') return statusCmd(args._[1] || 'latest');
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'strategy_principles',
      error: String(err && err.message ? err.message : err || 'strategy_principles_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  evaluatePrinciples
};
