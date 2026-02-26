#!/usr/bin/env node
'use strict';

/**
 * systems/strategy/strategy_learner.js
 *
 * Build deterministic strategy scorecards from autonomy run outcomes.
 *
 * Usage:
 *   node systems/strategy/strategy_learner.js run [YYYY-MM-DD] [--days=N] [--persist=1|0]
 *   node systems/strategy/strategy_learner.js status [YYYY-MM-DD|latest]
 *   node systems/strategy/strategy_learner.js --help
 */

const fs = require('fs');
const path = require('path');
const { listStrategies } = require('../../lib/strategy_resolver');
const { stableUid, isAlnum } = require('../../lib/uid');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const RUNS_DIR = process.env.STRATEGY_LEARNER_RUNS_DIR
  ? path.resolve(process.env.STRATEGY_LEARNER_RUNS_DIR)
  : path.join(REPO_ROOT, 'state', 'autonomy', 'runs');
const SCORECARD_DIR = process.env.STRATEGY_SCORECARD_DIR
  ? path.resolve(process.env.STRATEGY_SCORECARD_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'strategy', 'scorecards');
const STRATEGY_DIR = process.env.AUTONOMY_STRATEGY_DIR
  ? path.resolve(process.env.AUTONOMY_STRATEGY_DIR)
  : path.join(REPO_ROOT, 'config', 'strategies');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/strategy/strategy_learner.js run [YYYY-MM-DD] [--days=N] [--persist=1|0]');
  console.log('  node systems/strategy/strategy_learner.js status [YYYY-MM-DD|latest]');
  console.log('  node systems/strategy/strategy_learner.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
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

function clampInt(v, lo, hi, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function safeRate(num, den) {
  const n = Number(num || 0);
  const d = Number(den || 0);
  if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return 0;
  return Number((n / d).toFixed(3));
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, p);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function dateRange(endDate, days) {
  const out = [];
  const end = new Date(`${endDate}T00:00:00.000Z`);
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(end.getTime() - (i * 24 * 60 * 60 * 1000));
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function baseBucket(id) {
  return {
    strategy_id: id,
    attempted: 0,
    proposal_attempted: 0,
    non_proposal_gate_attempted: 0,
    executed: 0,
    shipped: 0,
    no_change: 0,
    reverted: 0,
    stopped: 0,
    proposal_stopped: 0,
    non_proposal_gate_stopped: 0,
    no_candidate: 0,
    score_only: 0
  };
}

function runEventProposalId(evt) {
  if (!evt || typeof evt !== 'object') return '';
  return String(
    evt.proposal_id
    || evt.selected_proposal_id
    || ''
  ).trim();
}

function isProposalAttemptForStrategy(evt) {
  if (!evt || typeof evt !== 'object') return false;
  if (runEventProposalId(evt)) return true;
  const proposalType = String(evt.proposal_type || '').trim().toLowerCase();
  if (proposalType && proposalType !== 'unknown') return true;
  const capabilityKey = String(evt.capability_key || '').trim().toLowerCase();
  if (capabilityKey.startsWith('proposal:') && capabilityKey !== 'proposal:unknown') return true;
  return false;
}

function classifyStage(m) {
  const attemptedForStage = Math.max(
    0,
    Number(m.proposal_attempted || 0) > 0
      ? Number(m.proposal_attempted || 0)
      : Number(m.attempted || 0)
  );
  if (attemptedForStage < 3 && Number(m.executed || 0) < 2) return 'theory';
  if (m.executed < 2 || m.shipped < 1) return 'trial';
  if (m.attempted >= 12 && m.shipped_rate >= 0.35 && m.reverted_rate <= 0.15 && m.stop_ratio <= 0.5) return 'scaled';
  if (m.shipped_rate >= 0.2 && m.reverted_rate <= 0.25) return 'validated';
  return 'trial';
}

function aggregateForWindow(endDate, days) {
  const dateList = dateRange(endDate, days);
  const buckets = {};

  const strategyProfiles = listStrategies({ dir: STRATEGY_DIR });
  for (const s of strategyProfiles) {
    const id = String(s.id || '').trim();
    if (!id) continue;
    buckets[id] = baseBucket(id);
  }

  for (const dateStr of dateList) {
    const fp = path.join(RUNS_DIR, `${dateStr}.jsonl`);
    const rows = readJsonl(fp);
    for (const evt of rows) {
      if (!evt || evt.type !== 'autonomy_run') continue;
      const id = String(evt.strategy_id || 'unassigned').trim() || 'unassigned';
      if (!buckets[id]) buckets[id] = baseBucket(id);
      const b = buckets[id];
      const result = String(evt.result || '');
      const outcome = String(evt.outcome || '');

      if (result === 'no_candidates') {
        b.no_candidate += 1;
        continue;
      }

      b.attempted += 1;
      const proposalAttempt = isProposalAttemptForStrategy(evt);
      if (proposalAttempt) b.proposal_attempted += 1;
      else b.non_proposal_gate_attempted += 1;
      if (result === 'executed') b.executed += 1;
      if (result === 'score_only_preview' || result === 'score_only_evidence') b.score_only += 1;
      if (result.startsWith('stop_')) {
        b.stopped += 1;
        if (proposalAttempt) b.proposal_stopped += 1;
        else b.non_proposal_gate_stopped += 1;
      }

      if (outcome === 'shipped') b.shipped += 1;
      if (outcome === 'no_change') b.no_change += 1;
      if (outcome === 'reverted') b.reverted += 1;
    }
  }

  const summaries = (Object.values(buckets) as Array<Record<string, any>>)
    .map((bucket) => {
      const b = (bucket && typeof bucket === 'object' ? bucket : {}) as Record<string, any>;
      const proposalAttempted = Math.max(0, Number(b.proposal_attempted || 0));
      const nonProposalAttempted = Math.max(0, Number(b.non_proposal_gate_attempted || 0));
      const proposalStopped = Math.max(0, Number(b.proposal_stopped || 0));
      const attemptedForScoring = proposalAttempted > 0 ? proposalAttempted : Math.max(1, Number(b.attempted || 0));
      const shippedRate = safeRate(b.shipped, b.executed);
      const revertedRate = safeRate(b.reverted, b.executed);
      const stopRatio = safeRate(proposalStopped, attemptedForScoring);
      const progressRate = safeRate(b.shipped, attemptedForScoring);
      const nonProposalGateRate = safeRate(nonProposalAttempted, Math.max(1, Number(b.attempted || 0)));
      const confidence = Number(Math.max(0.05, Math.min(1, attemptedForScoring / 20)).toFixed(3));
      const score = Number((
        (progressRate * 60)
        + ((1 - revertedRate) * 20)
        + ((1 - stopRatio) * 20)
        - (nonProposalGateRate * 10)
      ).toFixed(2));

      const metrics = {
        ...b,
        shipped_rate: shippedRate,
        reverted_rate: revertedRate,
        stop_ratio: stopRatio,
        proposal_stop_ratio: stopRatio,
        non_proposal_gate_rate: nonProposalGateRate,
        progress_rate: progressRate,
        confidence,
        score
      };

      return {
        uid: stableUid(`adaptive_strategy_summary|${b.strategy_id}|${endDate}|${days}|v1`, { prefix: 'ss', length: 24 }),
        strategy_uid: stableUid(`adaptive_strategy|${b.strategy_id}|v1`, { prefix: 'st', length: 24 }),
        strategy_id: b.strategy_id,
        stage: classifyStage(metrics),
        metrics
      };
    })
    .sort((a, b) => {
      if (b.metrics.score !== a.metrics.score) return b.metrics.score - a.metrics.score;
      return String(a.strategy_id).localeCompare(String(b.strategy_id));
    });

  return {
    uid: stableUid(`adaptive_strategy_scorecard|${endDate}|${days}|v1`, { prefix: 'sc', length: 24 }),
    date: endDate,
    window_days: days,
    start_date: dateList[0],
    end_date: dateList[dateList.length - 1],
    summaries
  };
}

function normalizeScorecardUids(payload, dateHint) {
  const src = payload && typeof payload === 'object' ? { ...payload } : {};
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(src.date || ''))
    ? String(src.date)
    : (String(dateHint || '').match(/^\d{4}-\d{2}-\d{2}$/) ? String(dateHint) : todayStr());
  const days = clampInt(src.window_days, 1, 60, 14);
  let changed = false;

  const scoreUid = String(src.uid || '').trim();
  const normalizedScoreUid = scoreUid && isAlnum(scoreUid)
    ? scoreUid
    : stableUid(`adaptive_strategy_scorecard|${date}|${days}|v1`, { prefix: 'sc', length: 24 });
  if (normalizedScoreUid !== scoreUid) changed = true;
  src.uid = normalizedScoreUid;

  const summariesIn = Array.isArray(src.summaries) ? src.summaries : [];
  src.summaries = summariesIn.map((raw, idx) => {
    const row = raw && typeof raw === 'object' ? { ...raw } : {};
    const sid = String(row.strategy_id || '').trim() || `unknown_${idx}`;
    const summaryUid = String(row.uid || '').trim();
    const normalizedSummaryUid = summaryUid && isAlnum(summaryUid)
      ? summaryUid
      : stableUid(`adaptive_strategy_summary|${sid}|${date}|${days}|v1`, { prefix: 'ss', length: 24 });
    if (normalizedSummaryUid !== summaryUid) changed = true;
    row.uid = normalizedSummaryUid;

    const strategyUid = String(row.strategy_uid || '').trim();
    const normalizedStrategyUid = strategyUid && isAlnum(strategyUid)
      ? strategyUid
      : stableUid(`adaptive_strategy|${sid}|v1`, { prefix: 'st', length: 24 });
    if (normalizedStrategyUid !== strategyUid) changed = true;
    row.strategy_uid = normalizedStrategyUid;
    return row;
  });

  const topIn = Array.isArray(src.top_strategies) ? src.top_strategies : [];
  src.top_strategies = topIn.map((raw, idx) => {
    const row = raw && typeof raw === 'object' ? { ...raw } : {};
    const sid = String(row.strategy_id || '').trim() || `unknown_${idx}`;
    const strategyUid = String(row.strategy_uid || '').trim();
    const normalizedStrategyUid = strategyUid && isAlnum(strategyUid)
      ? strategyUid
      : stableUid(`adaptive_strategy|${sid}|v1`, { prefix: 'st', length: 24 });
    if (normalizedStrategyUid !== strategyUid) changed = true;
    row.strategy_uid = normalizedStrategyUid;
    return row;
  });

  return { payload: src, changed };
}

function runCmd(args) {
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const days = clampInt(args.days, 1, 60, 14);
  const persist = String(args.persist || '1') !== '0';

  const agg = aggregateForWindow(dateStr, days);
  const payload = {
    version: 1,
    ts: nowIso(),
    ...agg,
    top_strategies: agg.summaries.slice(0, 3).map((s) => ({
      strategy_id: s.strategy_id,
      strategy_uid: s.strategy_uid,
      stage: s.stage,
      score: s.metrics.score,
      confidence: s.metrics.confidence
    }))
  };
  const normalized = normalizeScorecardUids(payload, dateStr).payload;

  if (persist) {
    ensureDir(SCORECARD_DIR);
    writeJsonAtomic(path.join(SCORECARD_DIR, `${dateStr}.json`), normalized);
    writeJsonAtomic(path.join(SCORECARD_DIR, 'latest.json'), normalized);
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    persisted: persist,
    scorecard_path: persist ? path.join(SCORECARD_DIR, `${dateStr}.json`) : null,
    ...normalized
  }, null, 2) + '\n');
}

function statusCmd(args) {
  const key = String(args._[1] || 'latest').trim();
  const target = key && key !== 'latest' && /^\d{4}-\d{2}-\d{2}$/.test(key)
    ? path.join(SCORECARD_DIR, `${key}.json`)
    : path.join(SCORECARD_DIR, 'latest.json');
  const payload = readJson(target, null);
  if (!payload) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: 'scorecard_not_found',
      path: target
    }) + '\n');
    process.exit(1);
  }
  const normalized = normalizeScorecardUids(payload, key === 'latest' ? todayStr() : key);
  if (normalized.changed) writeJsonAtomic(target, normalized.payload);
  process.stdout.write(JSON.stringify({ ok: true, path: target, ...normalized.payload }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return runCmd(args);
  if (cmd === 'status') return statusCmd(args);
  usage();
  process.exit(2);
}

main();
export {};
