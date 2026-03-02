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

const NEGATIVE_SIGNAL_TERMS = [
  'failed',
  'failure',
  'blocked',
  'rejected',
  'friction',
  'pain',
  'stuck',
  'bug',
  'error',
  'outage',
  'didn_t_work',
  'did_not_work'
];

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

function isUsableTopic(v, minLen = 4) {
  const topic = normalizeTopic(v);
  if (!topic) return false;
  if (topic.length < Number(minLen || 4)) return false;
  if (!/[a-z]/.test(topic)) return false;
  if (/^\d+$/.test(topic)) return false;
  return true;
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

function extractNegativeTerms(title) {
  const normalized = normalizeTopic(String(title || '')).replace(/_/g, ' ');
  const terms = [];
  for (const rawTerm of NEGATIVE_SIGNAL_TERMS) {
    const needle = rawTerm.replace(/_/g, ' ');
    if (!needle) continue;
    if (!normalized.includes(needle)) continue;
    terms.push(rawTerm);
  }
  return sortUnique(terms);
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

function clampUnit(x, fallback = 0) {
  const n = Number(x);
  if (!Number.isFinite(n)) return fallback;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function calibratedProbability(confidence, supportEyes, supportEvents) {
  const base = clampUnit(Number(confidence || 0) / 100, 0);
  const evidence = Math.min(
    0.16,
    (Math.log1p(Math.max(0, Number(supportEvents || 0))) / 22)
      + (Math.min(10, Number(supportEyes || 0)) * 0.01)
  );
  return clampUnit((base * 0.88) + evidence, base);
}

function calibrationArtifacts(hypotheses) {
  const rows = Array.isArray(hypotheses) ? hypotheses : [];
  const enriched = rows.map((h) => {
    const supportEyes = Number((h && h.support_eyes) || 0);
    const supportEvents = Number((h && h.support_events) || 0);
    const p = calibratedProbability((h && h.confidence) || 0, supportEyes, supportEvents);
    const targetProxy = clampUnit(
      (Math.min(10, supportEyes) / 10) * 0.45
      + (Math.min(30, supportEvents) / 30) * 0.55,
      0
    );
    return {
      hypothesis: h,
      probability: Number(p.toFixed(4)),
      target_proxy: Number(targetProxy.toFixed(4))
    };
  });
  const brier = mean(enriched.map((row) => {
    const d = row.probability - row.target_proxy;
    return d * d;
  }));
  const binMap = new Map();
  for (const row of enriched) {
    const bin = Math.min(0.9, Math.floor(row.probability * 10) / 10);
    const key = bin.toFixed(1);
    const cur = binMap.get(key) || { probability_sum: 0, target_sum: 0, count: 0 };
    cur.probability_sum += row.probability;
    cur.target_sum += row.target_proxy;
    cur.count += 1;
    binMap.set(key, cur);
  }
  const reliability = Array.from(binMap.entries())
    .map(([bin, row]) => ({
      bin,
      count: row.count,
      avg_probability: Number((row.probability_sum / Math.max(1, row.count)).toFixed(4)),
      avg_target_proxy: Number((row.target_sum / Math.max(1, row.count)).toFixed(4))
    }))
    .sort((a, b) => String(a.bin).localeCompare(String(b.bin)));
  return {
    enriched,
    brier_score: Number(brier.toFixed(6)),
    reliability
  };
}

function sortUnique(arr) {
  return Array.from(new Set((Array.isArray(arr) ? arr : []).map((x) => String(x || '')).filter(Boolean))).sort();
}

function buildHypothesisId(prefix, bits) {
  return `${prefix}-${sha16(bits.join('|'))}`;
}

function collectObservations(dates, limits = {}) {
  const safeLimits = (limits && typeof limits === 'object' ? limits : {}) as Record<string, any>;
  const maxTopicsPerItem = clamp(safeLimits.maxTopicsPerItem, 1, 12, 6);
  const maxObsPerEyeTopicPerDay = clamp(safeLimits.maxObsPerEyeTopicPerDay, 1, 100, 8);
  const minTopicLength = clamp(safeLimits.minTopicLength, 3, 16, 4);
  const topicObs = new Map(); // topic -> [{ eye_id, ts_ms, date, title }]
  const perEyeTopicDayCounts = new Map();

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
      const mergedTopics = sortUnique([...topics, ...tokenizeTitle(title)])
        .filter((topic) => isUsableTopic(topic, minTopicLength))
        .slice(0, maxTopicsPerItem);
      if (!mergedTopics.length) continue;
      const tsMs = eventTsMs(ev, d);
      for (const topic of mergedTopics) {
        const capKey = `${topic}|${eyeId}|${d}`;
        const seen = Number(perEyeTopicDayCounts.get(capKey) || 0);
        if (seen >= maxObsPerEyeTopicPerDay) continue;
        perEyeTopicDayCounts.set(capKey, seen + 1);
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

function hypothesisSignature(h) {
  if (!h || typeof h !== 'object') return '';
  const type = String(h.type || '').trim().toLowerCase() || 'unknown';
  const topic = String(h.topic || '').trim().toLowerCase() || 'unknown';
  if (type === 'lead_lag') {
    return `${type}|${topic}|${String(h.leader_eye || '').trim().toLowerCase()}|${String(h.follower_eye || '').trim().toLowerCase()}`;
  }
  return `${type}|${topic}`;
}

function compactHypotheses(rows, opts = {}) {
  const src = Array.isArray(rows) ? rows : [];
  const minConfidence = clamp((opts as Record<string, any>).minConfidence, 1, 100, 40);
  const maxPerTopic = clamp((opts as Record<string, any>).maxPerTopic, 1, 20, 3);
  const maxPerTopicType = clamp((opts as Record<string, any>).maxPerTopicType, 1, 10, 2);
  const dedupBySignature = new Map();
  for (const row of src) {
    if (!row || typeof row !== 'object') continue;
    if (Number((row as Record<string, any>).confidence || 0) < minConfidence) continue;
    const sig = hypothesisSignature(row);
    if (!sig) continue;
    const prev = dedupBySignature.get(sig);
    if (!prev || Number((row as Record<string, any>).confidence || 0) > Number((prev as Record<string, any>).confidence || 0)) {
      dedupBySignature.set(sig, row);
    }
  }
  const deduped = Array.from(dedupBySignature.values());
  const byTopicType = new Map();
  const byTopic = new Map();
  const compacted = [];
  for (const row of deduped) {
    const topic = String((row as Record<string, any>).topic || '').trim().toLowerCase() || 'unknown';
    const type = String((row as Record<string, any>).type || '').trim().toLowerCase() || 'unknown';
    const ttKey = `${topic}|${type}`;
    const ttCount = Number(byTopicType.get(ttKey) || 0);
    const topicCount = Number(byTopic.get(topic) || 0);
    if (ttCount >= maxPerTopicType) continue;
    if (topicCount >= maxPerTopic) continue;
    byTopicType.set(ttKey, ttCount + 1);
    byTopic.set(topic, topicCount + 1);
    compacted.push(row);
  }
  return {
    hypotheses: compacted,
    dropped: Math.max(0, src.length - compacted.length),
    dropped_low_confidence: Math.max(0, src.filter((h) => Number((h as Record<string, any>) && (h as Record<string, any>).confidence || 0) < minConfidence).length)
  };
}

function analyze(opts = {}) {
  const o = (opts && typeof opts === 'object' ? opts : {}) as Record<string, any>;
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(o.dateStr || '')) ? String(o.dateStr) : todayStr();
  const lookbackDays = clamp(o.lookbackDays, 3, 30, 7);
  const dates = datesInWindow(lookbackDays, dateStr);
  const baselineDates = dates.slice(0, -1);

  const minEyeSupport = clamp(process.env.CROSS_SIGNAL_MIN_EYES, 2, 10, 2);
  const minTopicEvents = clamp(process.env.CROSS_SIGNAL_MIN_TOPIC_EVENTS, 3, 200, 4);
  const minLeadLagHours = clamp(process.env.CROSS_SIGNAL_MIN_LEAD_LAG_HOURS, 1, 72, 1);
  const maxLeadLagHours = clamp(process.env.CROSS_SIGNAL_MAX_LEAD_LAG_HOURS, 1, 168, 48);
  const minDivergenceToday = clamp(process.env.CROSS_SIGNAL_MIN_DIVERGENCE_TODAY, 2, 100, 2);
  const minNegativeEvents = clamp(process.env.CROSS_SIGNAL_MIN_NEGATIVE_EVENTS, 1, 20, 2);
  const minDeltaVolume = clamp(process.env.CROSS_SIGNAL_MIN_DELTA_VOLUME, 1, 50, 2);
  const minDeltaTonePct = clamp(process.env.CROSS_SIGNAL_MIN_DELTA_TONE_PCT, 1, 100, 18) / 100;
  const maxHypotheses = clamp(process.env.CROSS_SIGNAL_MAX_HYPOTHESES, 10, 500, 120);
  const minConfidence = clamp(process.env.CROSS_SIGNAL_MIN_CONFIDENCE, 1, 100, 48);
  const maxBrier = clamp(process.env.CROSS_SIGNAL_MAX_BRIER_PCT, 1, 100, 35) / 100;
  const maxPerTopic = clamp(process.env.CROSS_SIGNAL_MAX_PER_TOPIC, 1, 20, 3);
  const maxPerTopicType = clamp(process.env.CROSS_SIGNAL_MAX_PER_TOPIC_TYPE, 1, 10, 2);
  const maxTopicsPerItem = clamp(process.env.CROSS_SIGNAL_MAX_TOPICS_PER_ITEM, 1, 12, 6);
  const maxObsPerEyeTopicPerDay = clamp(process.env.CROSS_SIGNAL_MAX_OBS_PER_EYE_TOPIC_DAY, 1, 100, 8);
  const minTopicLength = clamp(process.env.CROSS_SIGNAL_MIN_TOPIC_LENGTH, 3, 16, 4);

  const hypotheses = [];
  const temporalDeltas = [];
  const topicObs = collectObservations(dates, {
    maxTopicsPerItem,
    maxObsPerEyeTopicPerDay,
    minTopicLength
  });

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

    const negativeObs = obs
      .map((row) => ({
        ...row,
        negative_terms: extractNegativeTerms(row.title || '')
      }))
      .filter((row) => Array.isArray(row.negative_terms) && row.negative_terms.length > 0);

    const yesterdayDate = baselineDates.length ? baselineDates[baselineDates.length - 1] : null;
    const yesterdayCount = yesterdayDate ? Number(daily[yesterdayDate] || 0) : 0;
    const volumeDeltaDay = Number(todayCount - yesterdayCount);
    const volumeDeltaBaseline = Number(todayCount - baselineAvg);
    const activeEyesToday = perEyeToday.filter((row) => Number(row.today_count || 0) > 0).length;
    const baselineActiveEyesAvg = mean(
      baselineDates.map((d) => {
        const active = supportEyes.filter((eyeId) => obs.some((o) => o.eye_id === eyeId && o.date === d)).length;
        return active;
      })
    );
    const emphasisDelta = Number(activeEyesToday - baselineActiveEyesAvg);
    const negativeToday = negativeObs.filter((row) => row.date === dateStr).length;
    const toneToday = todayCount > 0 ? (negativeToday / todayCount) : 0;
    const baselineToneAvg = mean(
      baselineDates.map((d) => {
        const dayVol = Number(daily[d] || 0);
        if (dayVol <= 0) return 0;
        const dayNeg = negativeObs.filter((row) => row.date === d).length;
        return dayNeg / dayVol;
      })
    );
    const toneDelta = Number(toneToday - baselineToneAvg);

    const deltaRecord = {
      topic,
      today_count: todayCount,
      yesterday_count: yesterdayCount,
      baseline_avg: Number(baselineAvg.toFixed(3)),
      volume_delta_day: Number(volumeDeltaDay.toFixed(3)),
      volume_delta_baseline: Number(volumeDeltaBaseline.toFixed(3)),
      active_eyes_today: activeEyesToday,
      active_eyes_baseline_avg: Number(baselineActiveEyesAvg.toFixed(3)),
      emphasis_delta: Number(emphasisDelta.toFixed(3)),
      tone_today: Number(toneToday.toFixed(4)),
      tone_baseline_avg: Number(baselineToneAvg.toFixed(4)),
      tone_delta: Number(toneDelta.toFixed(4)),
      anomaly: (
        Math.abs(volumeDeltaDay) >= minDeltaVolume
        || Math.abs(volumeDeltaBaseline) >= minDeltaVolume
        || Math.abs(toneDelta) >= minDeltaTonePct
      )
    };
    temporalDeltas.push(deltaRecord);
    if (deltaRecord.anomaly) {
      const deltaConfidence = clamp(
        Math.round(
          44
          + Math.min(20, Math.abs(volumeDeltaDay) * 3)
          + Math.min(14, Math.abs(volumeDeltaBaseline) * 2)
          + Math.min(12, Math.abs(toneDelta) * 40)
        ),
        1,
        100,
        54
      );
      hypotheses.push({
        id: buildHypothesisId('HYP', ['temporal_delta', topic, dateStr]),
        type: 'temporal_delta',
        topic,
        summary: `Topic "${topic}" shows cross-temporal delta (day ${volumeDeltaDay.toFixed(1)}, baseline ${volumeDeltaBaseline.toFixed(1)}, tone ${toneDelta.toFixed(2)})`,
        confidence: deltaConfidence,
        support_eyes: supportEyes.length,
        support_events: obs.length,
        temporal_delta: deltaRecord,
        evidence: [
          {
            date: dateStr,
            count: todayCount,
            negative_count: negativeToday
          },
          {
            date: yesterdayDate || null,
            count: yesterdayCount,
            baseline_avg: Number(baselineAvg.toFixed(3))
          }
        ],
        window: { lookback_days: lookbackDays }
      });
    }

    if (negativeObs.length >= minNegativeEvents) {
      const negativeEyes = sortUnique(negativeObs.map((row) => row.eye_id).filter(Boolean));
      const termCounts = new Map();
      for (const row of negativeObs) {
        for (const term of row.negative_terms || []) {
          termCounts.set(term, Number(termCounts.get(term) || 0) + 1);
        }
      }
      const topTerms = Array.from(termCounts.entries())
        .sort((a, b) => {
          if (b[1] !== a[1]) return b[1] - a[1];
          return String(a[0]).localeCompare(String(b[0]));
        })
        .slice(0, 6)
        .map(([term, count]) => ({ term, count }));
      const salvageConfidence = clamp(
        Math.round(40 + (negativeObs.length * 7) + (negativeEyes.length * 8) + Math.min(10, topTerms.length * 2)),
        1,
        100,
        52
      );
      hypotheses.push({
        id: buildHypothesisId('HYP', ['negative_signal', topic, String(negativeObs.length), dateStr]),
        type: 'negative_signal',
        topic,
        summary: `Topic "${topic}" has salvageable negative-signal demand (${negativeObs.length} friction events)`,
        confidence: salvageConfidence,
        support_eyes: negativeEyes.length,
        support_events: negativeObs.length,
        negative_terms: topTerms,
        salvage_trace_key: `salvage:${topic}:${dateStr}`,
        evidence: negativeObs.slice(0, 8).map((row) => ({
          eye_id: row.eye_id,
          ts: row.ts_ms ? new Date(row.ts_ms).toISOString() : null,
          title: row.title,
          terms: row.negative_terms
        })),
        window: { lookback_days: lookbackDays }
      });
    }
  }

  const calibrated = calibrationArtifacts(hypotheses);
  const calibratedHypotheses = calibrated.enriched.map((row) => ({
    ...row.hypothesis,
    probability: row.probability,
    probability_contract: {
      model: 'calibrated_v1',
      target_proxy: row.target_proxy
    }
  }));

  calibratedHypotheses.sort((a, b) => {
    if (Number(b.confidence || 0) !== Number(a.confidence || 0)) return Number(b.confidence || 0) - Number(a.confidence || 0);
    if (Number(b.support_eyes || 0) !== Number(a.support_eyes || 0)) return Number(b.support_eyes || 0) - Number(a.support_eyes || 0);
    return String(a.id || '').localeCompare(String(b.id || ''));
  });
  const totalDetected = calibratedHypotheses.length;
  const compacted = compactHypotheses(calibratedHypotheses, {
    minConfidence,
    maxPerTopic,
    maxPerTopicType
  });
  const cappedHypotheses = compacted.hypotheses.slice(0, maxHypotheses);

  return {
    ts: new Date().toISOString(),
    type: 'cross_signal_hypotheses',
    date: dateStr,
    lookback_days: lookbackDays,
    source: 'systems/sensory/cross_signal_engine.js',
    noise_controls: {
      min_confidence: minConfidence,
      max_per_topic: maxPerTopic,
      max_per_topic_type: maxPerTopicType,
      max_topics_per_item: maxTopicsPerItem,
      max_obs_per_eye_topic_day: maxObsPerEyeTopicPerDay,
      min_topic_length: minTopicLength
      ,
      min_negative_events: minNegativeEvents,
      min_delta_volume: minDeltaVolume,
      min_delta_tone_pct: Number(minDeltaTonePct.toFixed(4)),
      max_brier: Number(maxBrier.toFixed(4))
    },
    calibration: {
      model: 'calibrated_v1',
      brier_score: calibrated.brier_score,
      max_brier: Number(maxBrier.toFixed(4)),
      pass: calibrated.brier_score <= maxBrier,
      reliability: calibrated.reliability
    },
    temporal_deltas: temporalDeltas
      .sort((a, b) => {
        const scoreA = Math.abs(Number(a.volume_delta_day || 0)) + Math.abs(Number(a.tone_delta || 0) * 10);
        const scoreB = Math.abs(Number(b.volume_delta_day || 0)) + Math.abs(Number(b.tone_delta || 0) * 10);
        return scoreB - scoreA;
      })
      .slice(0, 60),
    total_detected: totalDetected,
    compacted_count: compacted.hypotheses.length,
    compacted_dropped: compacted.dropped,
    compacted_dropped_low_confidence: compacted.dropped_low_confidence,
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
      ok: report.calibration && report.calibration.pass === true,
      type: report.type,
      date: report.date,
      lookback_days: report.lookback_days,
      total_detected: Number(report.total_detected || report.hypothesis_count || 0),
      hypothesis_count: report.hypothesis_count,
      calibration_pass: report.calibration && report.calibration.pass === true,
      calibration_brier_score: report.calibration ? report.calibration.brier_score : null,
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
  const strict = clamp(args.strict, 0, 1, 0) === 1;
  if (cmd === 'run' || cmd === 'status') {
    const report = analyze({ dateStr, lookbackDays });
    if (cmd === 'run') {
      const outPath = writeReport(report);
      const ok = report.calibration && report.calibration.pass === true;
      process.stdout.write(JSON.stringify({
        ok,
        type: report.type,
        date: report.date,
        lookback_days: report.lookback_days,
        total_detected: Number(report.total_detected || report.hypothesis_count || 0),
        hypothesis_count: report.hypothesis_count,
        calibration_pass: ok,
        calibration_brier_score: report.calibration ? report.calibration.brier_score : null,
        hypotheses_path: outPath
      }, null, 2) + '\n');
      process.exit(strict && !ok ? 2 : 0);
    }
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.exit(strict && report.calibration && report.calibration.pass !== true ? 2 : 0);
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
