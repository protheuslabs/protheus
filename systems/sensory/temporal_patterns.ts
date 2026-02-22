#!/usr/bin/env node
'use strict';
export {};

/**
 * temporal_patterns.js
 *
 * Deterministic temporal trend analysis for sensory eye outputs.
 * - Reads: state/sensory/eyes/raw/YYYY-MM-DD.jsonl, state/sensory/queue_log.jsonl
 * - Writes: state/sensory/trends/YYYY-MM-DD.json
 *           state/sensory/anomalies/YYYY-MM-DD.temporal.json
 *
 * Usage:
 *   node systems/sensory/temporal_patterns.js run [YYYY-MM-DD] [--lookback=7]
 *   node systems/sensory/temporal_patterns.js status [YYYY-MM-DD] [--lookback=7]
 *   node systems/sensory/temporal_patterns.js --help
 */

const fs = require('fs');
const path = require('path');
const { resolveCatalogPath } = require('../../lib/eyes_catalog.js');

type AnyObj = Record<string, any>;

const WORKSPACE_DIR = path.join(__dirname, '..', '..');

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/sensory/temporal_patterns.js run [YYYY-MM-DD] [--lookback=7]');
  console.log('  node systems/sensory/temporal_patterns.js status [YYYY-MM-DD] [--lookback=7]');
  console.log('  node systems/sensory/temporal_patterns.js --help');
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
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

function clamp(n, lo, hi, fallback) {
  const x = Number(n);
  if (!Number.isFinite(x)) return fallback;
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

function dateToMs(dateStr) {
  return Date.parse(`${dateStr}T00:00:00.000Z`);
}

function datesInWindow(lookbackDays, endDateStr) {
  const out = [];
  const endMs = dateToMs(endDateStr);
  for (let i = lookbackDays - 1; i >= 0; i--) {
    const ms = endMs - (i * 24 * 60 * 60 * 1000);
    out.push(new Date(ms).toISOString().slice(0, 10));
  }
  return out;
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
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

function mean(nums) {
  const xs = (Array.isArray(nums) ? nums : []).filter((x) => Number.isFinite(Number(x))).map(Number);
  if (!xs.length) return 0;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function safeHoursSince(ts) {
  if (!ts) return null;
  const ms = Date.parse(String(ts));
  if (!Number.isFinite(ms)) return null;
  return (Date.now() - ms) / (1000 * 60 * 60);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function resolvePaths(opts: AnyObj = {}): AnyObj {
  const workspaceDir = opts.workspaceDir ? path.resolve(opts.workspaceDir) : WORKSPACE_DIR;
  const sensoryDir = opts.sensoryDir
    ? path.resolve(opts.sensoryDir)
    : path.join(workspaceDir, 'state', 'sensory');
  const eyesDir = path.join(sensoryDir, 'eyes');
  return {
    workspaceDir,
    sensoryDir,
    eyesRawDir: path.join(eyesDir, 'raw'),
    eyesRegistryPath: path.join(eyesDir, 'registry.json'),
    queueLogPath: path.join(sensoryDir, 'queue_log.jsonl'),
    trendsDir: path.join(sensoryDir, 'trends'),
    anomaliesDir: path.join(sensoryDir, 'anomalies'),
    eyesCatalogPath: resolveCatalogPath(workspaceDir)
  };
}

function eventFingerprint(event) {
  const itemHash = String(event && (event.item_hash || event.id) || '').trim();
  if (itemHash) return `id:${itemHash.toLowerCase()}`;
  const url = String(event && event.url || '').trim().toLowerCase();
  if (url) return `url:${url}`;
  const title = String(event && event.title || '').trim().toLowerCase();
  return `raw:${title.slice(0, 180)}`;
}

function parserTypeForEvent(event, eyeMap) {
  const fromEvent = String(event && event.parser_type || '').trim().toLowerCase();
  if (fromEvent) return fromEvent;
  const eyeId = String(event && event.eye_id || '');
  const runtime = eyeId ? (eyeMap.get(eyeId) || {}) : {};
  return String(runtime.parser_type || '').trim().toLowerCase();
}

function isNoiseExternalItem(event, eyeMap) {
  if (!event || event.type !== 'external_item') return true;
  const parserType = parserTypeForEvent(event, eyeMap);
  if (parserType === 'stub') return true;
  if (event && event.fallback === true) return true;
  const tags = Array.isArray(event && event.tags) ? event.tags : [];
  if (tags.some((t) => String(t || '').toLowerCase() === 'fallback')) return true;
  const t = String(event.title || '').toUpperCase();
  if (t.includes('[STUB]') || t.includes('FALLBACK')) return true;
  return false;
}

function realExternalItem(event, eyeMap) {
  return !isNoiseExternalItem(event, eyeMap);
}

function normalizeTopic(v) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 80);
}

function buildRuntimeEyeMap(paths) {
  const map = new Map();
  const catalog = readJsonSafe(paths.eyesCatalogPath, {});
  const registry = readJsonSafe(paths.eyesRegistryPath, {});
  for (const eye of (Array.isArray(catalog && catalog.eyes) ? catalog.eyes : [])) {
    if (!eye || !eye.id) continue;
    map.set(String(eye.id), { ...eye });
  }
  for (const eye of (Array.isArray(registry && registry.eyes) ? registry.eyes : [])) {
    if (!eye || !eye.id) continue;
    const id = String(eye.id);
    map.set(id, { ...(map.get(id) || {}), ...eye });
  }
  return map;
}

function analyzeTemporalPatterns(opts: AnyObj = {}): AnyObj {
  const paths = resolvePaths(opts);
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(opts.dateStr || ''))
    ? String(opts.dateStr)
    : todayStr();
  const lookbackDays = clamp(opts.lookbackDays, 3, 30, 7);
  const dates = datesInWindow(lookbackDays, dateStr);
  const baselineDates = dates.slice(0, -1);
  const today = dates[dates.length - 1];
  const eyeMap = buildRuntimeEyeMap(paths);
  const dailyByEye = new Map();
  const topicDaily = new Map();
  const globalDaily = {};

  for (const d of dates) {
    const fp = path.join(paths.eyesRawDir, `${d}.jsonl`);
    const events = readJsonlSafe(fp);
    let realItemsDay = 0;
    let failuresDay = 0;
    let runOkDay = 0;
    let focusDay = 0;

    const seenEyeItems = new Set();
    const seenGlobalItems = new Set();

    for (const e of events) {
      const eyeId = String(e && e.eye_id || '');
      if (eyeId) {
        const key = `${d}::${eyeId}`;
        const row = dailyByEye.get(key) || {
          date: d,
          eye_id: eyeId,
          real_items: 0,
          failures: 0,
          run_ok: 0,
          focus_selected: 0
        };
        if (realExternalItem(e, eyeMap)) {
          const fpItem = eventFingerprint(e);
          const eyeDedupKey = `${eyeId}::${fpItem}`;
          if (!seenEyeItems.has(eyeDedupKey)) {
            row.real_items += 1;
            seenEyeItems.add(eyeDedupKey);
          }
          if (!seenGlobalItems.has(fpItem)) {
            realItemsDay += 1;
            seenGlobalItems.add(fpItem);
          }
          const topics = Array.isArray(e.topics) ? e.topics : [];
          for (const rawTopic of topics) {
            const topic = normalizeTopic(rawTopic);
            if (!topic) continue;
            const tKey = `${d}::${topic}`;
            const set = topicDaily.get(tKey) || new Set();
            set.add(fpItem);
            topicDaily.set(tKey, set);
          }
        } else if (e.type === 'eye_run_failed') {
          row.failures += 1;
          failuresDay += 1;
        } else if (e.type === 'eye_run_ok') {
          row.run_ok += 1;
          row.focus_selected += Number(e.focus_selected || 0);
          runOkDay += 1;
          focusDay += Number(e.focus_selected || 0);
        }
        dailyByEye.set(key, row);
      } else {
        if (e && e.type === 'eye_run_failed') failuresDay += 1;
        if (e && e.type === 'eye_run_ok') {
          runOkDay += 1;
          focusDay += Number(e.focus_selected || 0);
        }
        if (realExternalItem(e, eyeMap)) {
          const fpItem = eventFingerprint(e);
          if (!seenGlobalItems.has(fpItem)) {
            realItemsDay += 1;
            seenGlobalItems.add(fpItem);
          }
        }
      }
    }

    globalDaily[d] = {
      real_external_items: realItemsDay,
      eye_failures: failuresDay,
      eye_run_ok: runOkDay,
      focus_selected: focusDay,
      proposal_generated: 0
    };
  }

  const queueEvents = readJsonlSafe(paths.queueLogPath);
  const dateSet = new Set(dates);
  for (const e of queueEvents) {
    if (!e || e.type !== 'proposal_generated') continue;
    const d = String(e.date || '');
    if (!dateSet.has(d)) continue;
    if (!globalDaily[d]) continue;
    globalDaily[d].proposal_generated += 1;
  }

  const allEyeIds = new Set(Array.from(eyeMap.keys()));
  for (const key of dailyByEye.keys()) {
    const eyeId = String(key.split('::')[1] || '');
    if (eyeId) allEyeIds.add(eyeId);
  }

  const darkCadenceMultiplier = clamp(opts.darkCadenceMultiplier, 1, 10, 2);
  const darkMinSilenceHours = clamp(opts.darkMinSilenceHours, 3, 168, 8);
  const darkMinBaselineAvg = clamp(opts.darkMinBaselineAvg, 1, 50, 1);
  const darkMinHistoricalItems = clamp(opts.darkMinHistoricalItems, 3, 1000, 6);
  const darkMinNoSignalRuns = clamp(opts.darkMinNoSignalRuns, 1, 50, 2);
  const trendFlatBand = clamp(opts.trendFlatBand, 0.01, 1.0, 0.2);

  const byEye = [];
  for (const eyeId of Array.from(allEyeIds).sort()) {
    const runtime = eyeMap.get(eyeId) || {};
    const status = String(runtime.status || 'unknown').toLowerCase();
    const parserType = String(runtime.parser_type || '').toLowerCase();
    const cadenceHours = clamp(runtime.cadence_hours, 1, 168, 24);

    const perDay = dates.map((d) => dailyByEye.get(`${d}::${eyeId}`) || {
      date: d,
      real_items: 0,
      failures: 0,
      run_ok: 0,
      focus_selected: 0
    });
    const baseRows = perDay.slice(0, -1);
    const todayRow = perDay[perDay.length - 1] || { real_items: 0, failures: 0, run_ok: 0, focus_selected: 0 };
    const baselineAvgReal = mean(baseRows.map((r) => r.real_items));
    const baselineAvgFailures = mean(baseRows.map((r) => r.failures));
    const baselineAvgFocus = mean(baseRows.map((r) => r.focus_selected));
    const trendRatio = baselineAvgReal > 0 ? (todayRow.real_items / baselineAvgReal) : (todayRow.real_items > 0 ? 10 : 1);
    let trendDirection = 'flat';
    if (trendRatio > (1 + trendFlatBand)) trendDirection = 'up';
    else if (trendRatio < Math.max(0, (1 - trendFlatBand))) trendDirection = 'down';

    const lastSignalHours = safeHoursSince(runtime.last_success || runtime.last_real_signal_ts);
    const expectedSilenceHours = Math.max(darkMinSilenceHours, cadenceHours * darkCadenceMultiplier);
    const historicalItems = Number(runtime.total_items || 0);
    const historicalSignal = baselineAvgReal >= darkMinBaselineAvg || historicalItems >= darkMinHistoricalItems;
    const noSignalRunStreak = Number(todayRow.run_ok || 0) >= darkMinNoSignalRuns && Number(todayRow.real_items || 0) === 0;
    const recentFailureNoSignal = Number(todayRow.failures || 0) >= 1 && Number(todayRow.real_items || 0) === 0;
    const silentLongEnough = Number.isFinite(lastSignalHours) && Number(lastSignalHours) >= expectedSilenceHours;
    const darkCandidate = (
      parserType !== 'stub'
      && status !== 'retired'
      && historicalSignal
      && Number(todayRow.real_items || 0) === 0
      && (silentLongEnough || noSignalRunStreak || recentFailureNoSignal)
    );
    let darkReason = null;
    if (darkCandidate) {
      if (silentLongEnough) darkReason = 'silence_exceeded';
      else if (noSignalRunStreak) darkReason = 'no_signal_run_streak';
      else darkReason = 'recent_failure_without_signal';
    }

    byEye.push({
      eye_id: eyeId,
      parser_type: parserType || null,
      status,
      cadence_hours: cadenceHours,
      today_real_items: Number(todayRow.real_items || 0),
      baseline_avg_real_items: Number(baselineAvgReal.toFixed(2)),
      today_failures: Number(todayRow.failures || 0),
      baseline_avg_failures: Number(baselineAvgFailures.toFixed(2)),
      today_focus_selected: Number(todayRow.focus_selected || 0),
      baseline_avg_focus_selected: Number(baselineAvgFocus.toFixed(2)),
      trend_ratio: Number(trendRatio.toFixed(3)),
      trend_direction: trendDirection,
      last_signal_hours: lastSignalHours == null ? null : Number(lastSignalHours.toFixed(2)),
      expected_silence_hours: Number(expectedSilenceHours.toFixed(2)),
      dark_candidate: darkCandidate,
      dark_reason: darkReason
    });
  }

  const topicTotals = new Map();
  const split = Math.max(1, Math.floor(lookbackDays / 2));
  const recentDates = dates.slice(-split);
  const prevDates = dates.slice(0, Math.max(0, dates.length - split));
  const allTopics = new Set();
  for (const key of topicDaily.keys()) {
    const topic = String(key.split('::')[1] || '');
    if (topic) allTopics.add(topic);
  }
  for (const topic of allTopics) {
    let prev = 0;
    let recent = 0;
    for (const d of prevDates) {
      const set = topicDaily.get(`${d}::${topic}`);
      prev += set instanceof Set ? set.size : 0;
    }
    for (const d of recentDates) {
      const set = topicDaily.get(`${d}::${topic}`);
      recent += set instanceof Set ? set.size : 0;
    }
    if (prev === 0 && recent === 0) continue;
    const delta = recent - prev;
    const ratio = prev > 0 ? (recent / prev) : (recent > 0 ? 10 : 1);
    topicTotals.set(topic, {
      topic,
      prev_count: prev,
      recent_count: recent,
      delta,
      ratio: Number(ratio.toFixed(3)),
      trend: delta > 0 ? 'up' : (delta < 0 ? 'down' : 'flat')
    });
  }
  const topicTrends = Array.from(topicTotals.values())
    .sort((a, b) => {
      const absA = Math.abs(Number(a.delta || 0));
      const absB = Math.abs(Number(b.delta || 0));
      if (absB !== absA) return absB - absA;
      return String(a.topic).localeCompare(String(b.topic));
    })
    .slice(0, 20);

  const darkCandidates = byEye.filter((r) => r.dark_candidate === true);
  const anomalies = [];
  for (const row of darkCandidates) {
    anomalies.push({
      type: 'eye_went_dark',
      severity: row.baseline_avg_real_items >= 3 ? 'high' : 'medium',
      eye_id: row.eye_id,
      message: `Eye ${row.eye_id} went dark (today=0, baseline_avg=${row.baseline_avg_real_items}, silence_h=${row.last_signal_hours}, expected_h=${row.expected_silence_hours})`
    });
  }
  for (const row of byEye) {
    if (row.today_failures >= 2 && row.baseline_avg_failures >= 0.5 && row.today_failures >= (row.baseline_avg_failures * 2)) {
      anomalies.push({
        type: 'eye_failure_spike',
        severity: 'medium',
        eye_id: row.eye_id,
        message: `Eye ${row.eye_id} failure spike (today=${row.today_failures}, baseline_avg=${row.baseline_avg_failures})`
      });
    }
  }

  const report: AnyObj = {
    ts: new Date().toISOString(),
    type: 'temporal_patterns',
    date: today,
    lookback_days: lookbackDays,
    window_dates: dates,
    global_daily: globalDaily,
    by_eye: byEye,
    dark_candidates: darkCandidates.map((r) => ({
      eye_id: r.eye_id,
      baseline_avg_real_items: r.baseline_avg_real_items,
      last_signal_hours: r.last_signal_hours,
      expected_silence_hours: r.expected_silence_hours,
      reason: r.dark_reason || null
    })),
    topic_trends: topicTrends,
    anomalies
  };

  if (opts.write !== false) {
    ensureDir(paths.trendsDir);
    ensureDir(paths.anomaliesDir);
    const trendPath = path.join(paths.trendsDir, `${today}.json`);
    const anomalyPath = path.join(paths.anomaliesDir, `${today}.temporal.json`);
    fs.writeFileSync(trendPath, JSON.stringify(report, null, 2));
    fs.writeFileSync(anomalyPath, JSON.stringify({
      date: today,
      checked_at: report.ts,
      source: 'temporal_patterns',
      lookback_days: lookbackDays,
      anomalies
    }, null, 2));
    report.trend_path = trendPath;
    report.anomaly_path = anomalyPath;
  }

  return report;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  const lookbackDays = clamp(args.lookback, 3, 30, 7);
  if (cmd === 'run') {
    const rep = analyzeTemporalPatterns({ dateStr, lookbackDays, write: true });
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
    process.exit(0);
  }
  if (cmd === 'status') {
    const rep = analyzeTemporalPatterns({ dateStr, lookbackDays, write: false });
    process.stdout.write(JSON.stringify(rep, null, 2) + '\n');
    process.exit(0);
  }
  usage();
  process.exit(2);
}

module.exports = {
  analyzeTemporalPatterns
};

if (require.main === module) {
  main();
}
