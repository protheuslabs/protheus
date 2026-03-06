#!/usr/bin/env node
'use strict';

/**
 * weekly_strategy_synthesis.js
 *
 * Summarize executed proposal outcomes into weekly strategy signals.
 *
 * Usage:
 *   node systems/strategy/weekly_strategy_synthesis.js run [YYYY-MM-DD] [--days=N] [--write=1]
 *   node systems/strategy/weekly_strategy_synthesis.js --help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const QUEUE_DECISIONS_DIR = process.env.STRATEGY_SYNTHESIS_QUEUE_DECISIONS_DIR
  ? path.resolve(process.env.STRATEGY_SYNTHESIS_QUEUE_DECISIONS_DIR)
  : path.join(ROOT, 'state', 'queue', 'decisions');
const PROPOSALS_DIR = process.env.STRATEGY_SYNTHESIS_PROPOSALS_DIR
  ? path.resolve(process.env.STRATEGY_SYNTHESIS_PROPOSALS_DIR)
  : path.join(ROOT, 'state', 'sensory', 'proposals');
const OUTPUT_DIR = process.env.STRATEGY_SYNTHESIS_OUTPUT_DIR
  ? path.resolve(process.env.STRATEGY_SYNTHESIS_OUTPUT_DIR)
  : path.join(ROOT, 'state', 'adaptive', 'strategy', 'weekly_synthesis');

function usage() {
  console.log('Usage:');
  console.log('  node systems/strategy/weekly_strategy_synthesis.js run [YYYY-MM-DD] [--days=N] [--write=1]');
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

function isDateStr(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
}

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return nowIso().slice(0, 10);
}

function dateShift(dateStr, deltaDays) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + Number(deltaDays || 0));
  return d.toISOString().slice(0, 10);
}

function dateRange(endDate, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) out.push(dateShift(endDate, -i));
  return out;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function toArrayProposals(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === 'object' && Array.isArray(raw.proposals)) return raw.proposals;
  return [];
}

function normText(v) {
  return String(v == null ? '' : v).trim();
}

function safeType(v) {
  const t = normText(v).toLowerCase();
  return t || 'unknown';
}

function safeOutcome(v) {
  const o = normText(v).toLowerCase();
  if (o === 'shipped' || o === 'no_change' || o === 'rejected' || o === 'failed') return o;
  return 'other';
}

function loadProposalMap(dates) {
  const map = new Map();
  for (const d of dates) {
    const fp = path.join(PROPOSALS_DIR, `${d}.json`);
    const rows = toArrayProposals(readJsonSafe(fp, []));
    for (const p of rows) {
      const id = normText(p && p.id);
      if (!id) continue;
      map.set(id, {
        id,
        type: safeType(p.type),
        source_eye: normText(p.meta && p.meta.source_eye) || 'unknown_eye',
        title: normText(p.title).slice(0, 180)
      });
    }
  }
  return map;
}

function loadOutcomeRows(dates) {
  const out = [];
  for (const d of dates) {
    const fp = path.join(QUEUE_DECISIONS_DIR, `${d}.jsonl`);
    const rows = readJsonl(fp);
    for (const row of rows) {
      if (String(row && row.type || '').trim() !== 'outcome') continue;
      out.push({
        date: d,
        ts: normText(row.ts),
        proposal_id: normText(row.proposal_id),
        outcome: safeOutcome(row.outcome),
        evidence_ref: normText(row.evidence_ref).slice(0, 180)
      });
    }
  }
  return out;
}

function summarize(outcomes, proposals) {
  const byType = new Map();
  const trace = [];

  for (const row of outcomes) {
    const p = proposals.get(row.proposal_id) || { type: 'unknown', source_eye: 'unknown_eye', title: '' };
    const key = p.type || 'unknown';
    if (!byType.has(key)) {
      byType.set(key, {
        proposal_type: key,
        total: 0,
        shipped: 0,
        no_change: 0,
        rejected: 0,
        failed: 0,
        other: 0,
        source_eyes: {}
      });
    }
    const acc = byType.get(key);
    acc.total += 1;
    acc[row.outcome] = Number(acc[row.outcome] || 0) + 1;
    acc.source_eyes[p.source_eye] = Number(acc.source_eyes[p.source_eye] || 0) + 1;

    trace.push({
      ts: row.ts,
      proposal_id: row.proposal_id,
      proposal_type: key,
      outcome: row.outcome,
      source_eye: p.source_eye,
      evidence_ref: row.evidence_ref
    });
  }

  const rows = Array.from(byType.values()).map((row) => {
    const shippedRate = row.total > 0 ? Number((row.shipped / row.total).toFixed(3)) : 0;
    const failRate = row.total > 0 ? Number(((row.rejected + row.failed) / row.total).toFixed(3)) : 0;
    const noChangeRate = row.total > 0 ? Number((row.no_change / row.total).toFixed(3)) : 0;
    const score = Number(((shippedRate * 100) - (failRate * 45) - (noChangeRate * 20)).toFixed(2));
    return {
      ...row,
      shipped_rate: shippedRate,
      fail_rate: failRate,
      no_change_rate: noChangeRate,
      score,
      source_eyes: Object.fromEntries(
        Object.entries(row.source_eyes).sort(
          (a, b) => Number(b[1] || 0) - Number(a[1] || 0) || a[0].localeCompare(b[0])
        )
      )
    };
  }).sort((a, b) => b.score - a.score || b.total - a.total || a.proposal_type.localeCompare(b.proposal_type));

  const winners = rows.filter((r) => r.total >= 2 && r.shipped_rate >= 0.5).slice(0, 3);
  const losers = rows.filter((r) => r.total >= 2 && (r.fail_rate >= 0.4 || r.no_change_rate >= 0.6)).slice(0, 3);

  const recommendedWeightUpdates = [];
  for (const w of winners) {
    recommendedWeightUpdates.push({ proposal_type: w.proposal_type, delta: 0.1, reason: 'high_ship_rate' });
  }
  for (const l of losers) {
    recommendedWeightUpdates.push({ proposal_type: l.proposal_type, delta: -0.1, reason: 'low_effective_yield' });
  }

  return {
    totals: {
      outcomes: outcomes.length,
      proposal_types: rows.length,
      shipped: outcomes.filter((r) => r.outcome === 'shipped').length,
      no_change: outcomes.filter((r) => r.outcome === 'no_change').length,
      rejected: outcomes.filter((r) => r.outcome === 'rejected').length,
      failed: outcomes.filter((r) => r.outcome === 'failed').length
    },
    by_proposal_type: rows,
    winners,
    losers,
    recommended_weight_updates: recommendedWeightUpdates,
    trace: trace.slice(0, 200)
  };
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function cmdRun(args) {
  const date = isDateStr(args._[1]) ? String(args._[1]) : todayStr();
  const daysRaw = Number(args.days || 7);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? Math.min(Math.round(daysRaw), 60) : 7;
  const write = String(args.write || '1') !== '0';

  const dates = dateRange(date, days);
  const proposals = loadProposalMap(dates);
  const outcomes = loadOutcomeRows(dates);
  const summary = summarize(outcomes, proposals);

  const out: Record<string, any> = {
    ok: true,
    type: 'weekly_strategy_synthesis',
    ts: nowIso(),
    date,
    days,
    write,
    date_range: { from: dates[0], to: dates[dates.length - 1] },
    summary
  };

  if (write) {
    const outFile = path.join(OUTPUT_DIR, `${date}.json`);
    writeJsonAtomic(outFile, out);
    out.output_file = path.relative(ROOT, outFile).replace(/\\/g, '/');
  }

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
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'weekly_strategy_synthesis_failed') }) + '\n');
    process.exit(1);
  }
}
export {};
