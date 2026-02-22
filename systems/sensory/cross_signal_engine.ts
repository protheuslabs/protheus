#!/usr/bin/env node
'use strict';

/**
 * cross_signal_engine.js
 *
 * Deterministic cross-eye synthesis:
 * - Detects multi-eye convergence, lead/lag, and divergence motifs.
 * - Produces reusable hypotheses for downstream proposal generation.
 *
 * Reads:
 *   state/sensory/eyes/raw/YYYY-MM-DD.jsonl
 *
 * Writes:
 *   state/sensory/cross_signal/hypotheses/YYYY-MM-DD.json
 *
 * Usage:
 *   node systems/sensory/cross_signal_engine.js run [YYYY-MM-DD] [--lookback=7]
 *   node systems/sensory/cross_signal_engine.js status [YYYY-MM-DD] [--lookback=7]
 *   node systems/sensory/cross_signal_engine.js --help
 */

const fs = require('fs');
const path = require('path');

const WORKSPACE_DIR = path.join(__dirname, '..', '..');
const SENSORY_DIR = process.env.CROSS_SIGNAL_SENSORY_DIR
  ? path.resolve(process.env.CROSS_SIGNAL_SENSORY_DIR)
  : path.join(WORKSPACE_DIR, 'state', 'sensory');
const EYES_RAW_DIR = path.join(SENSORY_DIR, 'eyes', 'raw');
const HYPOTHESES_DIR = path.join(SENSORY_DIR, 'cross_signal', 'hypotheses');

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'into', 'through', 'your', 'their', 'our',
  'are', 'was', 'were', 'have', 'has', 'had', 'will', 'would', 'should', 'could', 'must', 'can',
  'not', 'all', 'any', 'only', 'each', 'but', 'its', 'it', 'as', 'at', 'on', 'to', 'in', 'of', 'or',
  'an', 'a', 'by', 'new', 'latest', 'today', 'week', 'month'
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/sensory/cross_signal_engine.js run [YYYY-MM-DD] [--lookback=7]');
  console.log('  node systems/sensory/cross_signal_engine.js status [YYYY-MM-DD] [--lookback=7]');
  console.log('  node systems/sensory/cross_signal_engine.js --help');
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function clamp(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
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

function ensureDirs() {
  if (!fs.existsSync(HYPOTHESES_DIR)) fs.mkdirSync(HYPOTHESES_DIR, { recursive: true });
}

function sha16(s) {
  return require('crypto').createHash('sha256').update(String(s || ''), 'utf8').digest('hex').slice(0, 16);
}

function normalizeTopic(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_ -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+/g, '_')
    .slice(0, 80);
}

function tokenizeTitle(title) {
  const s = String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!s) return [];
  return s
    .split(' ')
    .filter((t) => t.length >= 4)
    .filter((t) => !STOPWORDS.has(t))
    .slice(0, 8)
    .map(normalizeTopic)
    .filter(Boolean);
}

function readJsonlSafe(filePath) {
  const out = [];
  try {
    if (!fs.existsSync(filePath)) return out;
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch {}
    }
  } catch {
    return out;
  }
  return out;
}

function dateToMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

function datesInWindow(windowDays, endDateStr) {
  const out = [];
  const endMs = dateToMs(endDateStr);
  for (let i = windowDays - 1; i >= 0; i--) {
    const ms = endMs - (i * 24 * 60 * 60 * 1000);
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function eventTsMs(ev, dateStr) {
  const ts = Date.parse(String(ev && ev.ts || ev && ev.collected_at || ''));
  if (Number.isFinite(ts)) return ts;
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

function mean(nums) {
  const xs = (Array.isArray(nums) ? nums : []).map(Number).filter(Number.isFinite);
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sortUnique(arr) {
  return Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || '')).filter(Boolean))).sort();
}

function buildHypothesisId(prefix, bits) {
  return `${prefix}-${sha16(bits.join('|'))}`;
}

function collectObservations(dates) {
  const topicObs = new Map(); // topic -> [{ eye_id, ts_ms, date, title }]

  for (const d of dates) {
    const filePath = path.join(EYES_RAW_DIR, `${d}.jsonl`);
    const events = readJsonlSafe(filePath);
    for (const ev of events) {
      if (!ev || ev.type !== 'external_item') continue;
      const eyeId = String(ev.eye_id || '').trim();
      if (!eyeId) continue;
      const title = String(ev.title || '');
      if (title.toUpperCase().includes('[STUB]')) continue;
      const topics = Array.isArray(ev.topics) ? ev.topics : [];
      const mergedTopics = sortUnique([...topics.map(normalizeTopic).filter(Boolean), ...tokenizeTitle(title)]);
      if (!mergedTopics.length) continue;
      const tsMs = eventTsMs(ev, d);
      for (const topic of mergedTopics) {
        const arr = topicObs.get(topic) || [];
        arr.push({
          eye_id: eyeId,
          ts_ms: tsMs,
          date: d,
          title: String(title || '').slice(0, 140)
        });
        topicObs.set(topic, arr);
      }
    }
  }

  return topicObs;
}

function summarizePerEye(obs) {
  const map = new Map();
  for (const o of obs) {
    const eyeId = String(o.eye_id || '');
    if (!eyeId) continue;
    const row = map.get(eyeId) || {
      eye_id: eyeId,
      count: 0,
      first_ts_ms: o.ts_ms,
      last_ts_ms: o.ts_ms,
      today_count: 0
    };
    row.count += 1;
    row.first_ts_ms = Math.min(row.first_ts_ms, o.ts_ms);
    row.last_ts_ms = Math.max(row.last_ts_ms, o.ts_ms);
    map.set(eyeId, row);
  }
  return map;
}

function dailyCounts(obs, dates) {
  const out = {};
  for (const d of dates) out[d] = 0;
  for (const o of obs) {
    const d = String(o.date || '');
    if (Object.prototype.hasOwnProperty.call(out, d)) out[d] += 1;
  }
  return out;
}

function analyze(opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(o.dateStr || '')) ? String(o.dateStr) : todayStr();
  const lookbackDays = clamp(o.lookbackDays, 3, 30, 7);
  const dates = datesInWindow(lookbackDays, dateStr);
  const baselineDates = dates.slice(0, -1);
  const topicObs = collectObservations(dates);

  const minEyeSupport = clamp(process.env.CROSS_SIGNAL_MIN_EYES, 2, 10, 2);
  const minTopicEvents = clamp(process.env.CROSS_SIGNAL_MIN_TOPIC_EVENTS, 3, 200, 4);
  const minLeadLagHours = clamp(process.env.CROSS_SIGNAL_MIN_LEAD_LAG_HOURS, 1, 72, 1);
  const maxLeadLagHours = clamp(process.env.CROSS_SIGNAL_MAX_LEAD_LAG_HOURS, 1, 168, 48);
  const minDivergenceToday = clamp(process.env.CROSS_SIGNAL_MIN_DIVERGENCE_TODAY, 2, 100, 2);
  const maxHypotheses = clamp(process.env.CROSS_SIGNAL_MAX_HYPOTHESES, 10, 500, 120);

  const hypotheses = [];

  for (const [topic, obsRaw] of topicObs.entries()) {
    const obs = Array.isArray(obsRaw) ? obsRaw.slice().sort((a, b) => a.ts_ms - b.ts_ms) : [];
    if (obs.length < minTopicEvents) continue;
    const perEye = summarizePerEye(obs);
    const supportEyes = Array.from(perEye.keys()).sort();
    if (supportEyes.length < minEyeSupport) continue;

    const daily = dailyCounts(obs, dates);
    const todayCount = Number(daily[dateStr] || 0);
    const baselineAvg = mean(baselineDates.map((d) => Number(daily[d] || 0)));
    const trendRatio = baselineAvg > 0 ? (todayCount / baselineAvg) : (todayCount > 0 ? 10 : 1);
    const trendDirection = trendRatio > 1.2 ? 'up' : (trendRatio < 0.8 ? 'down' : 'flat');

    const convergenceConfidence = clamp(
      Math.round(38 + (supportEyes.length * 12) + Math.min(24, obs.length * 2) + (trendDirection === 'up' ? 8 : 0)),
      1,
      100,
      50
    );
    hypotheses.push({
      id: buildHypothesisId('HYP', ['convergence', topic, String(supportEyes.length), String(obs.length), dateStr]),
      type: 'convergence',
      topic,
      summary: `Topic "${topic}" converging across ${supportEyes.length} eyes`,
      confidence: convergenceConfidence,
      support_eyes: supportEyes.length,
      support_events: obs.length,
      trend_direction: trendDirection,
      trend_ratio: Number(trendRatio.toFixed(3)),
      evidence: supportEyes.map((eyeId) => {
        const row = perEye.get(eyeId);
        return {
          eye_id: eyeId,
          count: Number(row && row.count || 0),
          first_ts: row && row.first_ts_ms ? new Date(row.first_ts_ms).toISOString() : null,
          last_ts: row && row.last_ts_ms ? new Date(row.last_ts_ms).toISOString() : null
        };
      }).slice(0, 8),
      window: { lookback_days: lookbackDays }
    });

    const leadRows = supportEyes
      .map((eyeId) => {
        const row = perEye.get(eyeId);
        return {
          eye_id: eyeId,
          first_ts_ms: Number(row && row.first_ts_ms || 0)
        };
      })
      .filter((r) => r.first_ts_ms > 0)
      .sort((a, b) => a.first_ts_ms - b.first_ts_ms);

    if (leadRows.length >= 2) {
      const leader = leadRows[0];
      const follower = leadRows[1];
      const lagHours = (follower.first_ts_ms - leader.first_ts_ms) / (1000 * 60 * 60);
      if (lagHours >= minLeadLagHours && lagHours <= maxLeadLagHours) {
        const leadLagConfidence = clamp(
          Math.round(35 + (supportEyes.length * 10) + Math.min(18, obs.length) + Math.max(0, 8 - Math.round(lagHours / 6))),
          1,
          100,
          45
        );
        hypotheses.push({
          id: buildHypothesisId('HYP', ['lead_lag', topic, leader.eye_id, follower.eye_id, dateStr]),
          type: 'lead_lag',
          topic,
          summary: `Topic "${topic}" appears first in ${leader.eye_id}, then ${follower.eye_id} (~${lagHours.toFixed(1)}h lag)`,
          confidence: leadLagConfidence,
          support_eyes: supportEyes.length,
          support_events: obs.length,
          leader_eye: leader.eye_id,
          follower_eye: follower.eye_id,
          lag_hours: Number(lagHours.toFixed(2)),
          evidence: leadRows.slice(0, 6).map((r) => ({
            eye_id: r.eye_id,
            first_seen_ts: new Date(r.first_ts_ms).toISOString()
          })),
          window: { lookback_days: lookbackDays }
        });
      }
    }

    const perEyeToday = supportEyes.map((eyeId) => {
      const todayEyeCount = obs.filter((o) => o.eye_id === eyeId && o.date === dateStr).length;
      const baseAvg = mean(
        baselineDates.map((d) => obs.filter((o) => o.eye_id === eyeId && o.date === d).length)
      );
      return { eye_id: eyeId, today_count: todayEyeCount, baseline_avg: Number(baseAvg.toFixed(2)) };
    });
    const activeToday = perEyeToday.filter((r) => r.today_count >= minDivergenceToday);
    const absentToday = perEyeToday.filter((r) => r.today_count === 0 && r.baseline_avg >= 1);
    if (activeToday.length >= 1 && absentToday.length >= 1) {
      const divergenceConfidence = clamp(
        Math.round(42 + (activeToday.length * 9) + (absentToday.length * 7) + Math.min(12, obs.length)),
        1,
        100,
        55
      );
      hypotheses.push({
        id: buildHypothesisId('HYP', ['divergence', topic, String(activeToday.length), String(absentToday.length), dateStr]),
        type: 'divergence',
        topic,
        summary: `Topic "${topic}" diverging across eyes (${activeToday.length} active, ${absentToday.length} absent today)`,
        confidence: divergenceConfidence,
        support_eyes: supportEyes.length,
        support_events: obs.length,
        active_eyes: activeToday.slice(0, 4),
        absent_eyes: absentToday.slice(0, 4),
        evidence: perEyeToday.slice(0, 8),
        window: { lookback_days: lookbackDays }
      });
    }
  }

  hypotheses.sort((a, b) => {
    if (Number(b.confidence || 0) !== Number(a.confidence || 0)) return Number(b.confidence || 0) - Number(a.confidence || 0);
    if (Number(b.support_eyes || 0) !== Number(a.support_eyes || 0)) return Number(b.support_eyes || 0) - Number(a.support_eyes || 0);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  const totalDetected = hypotheses.length;
  const cappedHypotheses = hypotheses.slice(0, maxHypotheses);

  return {
    ts: new Date().toISOString(),
    type: 'cross_signal_hypotheses',
    date: dateStr,
    lookback_days: lookbackDays,
    source: 'systems/sensory/cross_signal_engine.js',
    total_detected: totalDetected,
    hypothesis_count: cappedHypotheses.length,
    hypotheses: cappedHypotheses
  };
}

function writeReport(report) {
  ensureDirs();
  const outPath = path.join(HYPOTHESES_DIR, `${report.date}.json`);
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
  return outPath;
}

function runCli(cmd, dateStr, lookbackDays) {
  const report = analyze({ dateStr, lookbackDays });
  if (cmd === 'run') {
    const outPath = writeReport(report);
    process.stdout.write(JSON.stringify({
      ok: true,
      type: report.type,
      date: report.date,
      lookback_days: report.lookback_days,
      total_detected: Number(report.total_detected || report.hypothesis_count || 0),
      hypothesis_count: report.hypothesis_count,
      hypotheses_path: outPath
    }, null, 2) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const lookbackDays = clamp(args.lookback, 3, 30, 7);
  if (cmd === 'run' || cmd === 'status') {
    runCli(cmd, dateStr, lookbackDays);
    process.exit(0);
  }
  usage();
  process.exit(2);
}

module.exports = {
  analyze
};

if (require.main === module) {
  main();
}
export {};
