#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-089
 * Dynamic source reliability graph.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DYNAMIC_SOURCE_RELIABILITY_POLICY_PATH
  ? path.resolve(process.env.DYNAMIC_SOURCE_RELIABILITY_POLICY_PATH)
  : path.join(ROOT, 'config', 'dynamic_source_reliability_graph_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    neutral_score: 0.5,
    min_score: 0.05,
    max_score: 0.95,
    learning_rate: 0.2,
    decay_toward_neutral: 0.03,
    per_event_influence_cap: 0.12,
    positive_outcomes: ['true_positive', 'accepted', 'validated'],
    negative_outcomes: ['false_positive', 'false_negative', 'rejected', 'invalidated'],
    paths: {
      hypotheses_dir: 'state/sensory/cross_signal/hypotheses',
      outcomes_dir: 'state/sensory/analysis/hypothesis_outcomes',
      state_path: 'state/sensory/analysis/source_reliability/state.json',
      output_dir: 'state/sensory/analysis/source_reliability',
      latest_path: 'state/sensory/analysis/source_reliability/latest.json',
      receipts_path: 'state/sensory/analysis/source_reliability/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32) || base.version,
    enabled: raw.enabled !== false,
    neutral_score: clampNumber(raw.neutral_score, 0, 1, base.neutral_score),
    min_score: clampNumber(raw.min_score, 0, 1, base.min_score),
    max_score: clampNumber(raw.max_score, 0, 1, base.max_score),
    learning_rate: clampNumber(raw.learning_rate, 0, 1, base.learning_rate),
    decay_toward_neutral: clampNumber(raw.decay_toward_neutral, 0, 1, base.decay_toward_neutral),
    per_event_influence_cap: clampNumber(raw.per_event_influence_cap, 0, 1, base.per_event_influence_cap),
    positive_outcomes: Array.isArray(raw.positive_outcomes)
      ? raw.positive_outcomes.map((row: any) => normalizeToken(row, 80)).filter(Boolean)
      : base.positive_outcomes,
    negative_outcomes: Array.isArray(raw.negative_outcomes)
      ? raw.negative_outcomes.map((row: any) => normalizeToken(row, 80)).filter(Boolean)
      : base.negative_outcomes,
    paths: {
      hypotheses_dir: resolvePath(paths.hypotheses_dir, base.paths.hypotheses_dir),
      outcomes_dir: resolvePath(paths.outcomes_dir, base.paths.outcomes_dir),
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      output_dir: resolvePath(paths.output_dir, base.paths.output_dir),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadHypotheses(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.hypotheses_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const hypotheses = src && Array.isArray(src.hypotheses) ? src.hypotheses : [];
  return {
    file_path: fp,
    hypotheses: hypotheses.filter((row: any) => row && typeof row === 'object')
  };
}

function loadOutcomes(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.outcomes_dir, `${dateStr}.json`);
  const src = readJson(fp, null);
  const outcomes = src && Array.isArray(src.outcomes) ? src.outcomes : [];
  const map = new Map();
  for (const row of outcomes) {
    const id = cleanText(row && row.hypothesis_id || '', 160);
    if (!id) continue;
    map.set(id, normalizeToken(row && row.outcome || '', 80));
  }
  return {
    file_path: fp,
    map
  };
}

function loadState(policy: Record<string, any>) {
  const src = readJson(policy.paths.state_path, null);
  const rows = src && src.sources && typeof src.sources === 'object' ? src.sources : {};
  return rows;
}

function sourceIdsFromHypothesis(h: Record<string, any>) {
  const out = new Set();
  const evidence = Array.isArray(h && h.evidence) ? h.evidence : [];
  for (const row of evidence) {
    const eye = normalizeToken(row && (row.eye_id || row.source_id || row.source) || '', 120);
    if (eye) out.add(eye);
  }
  if (out.size === 0) out.add('unknown_source');
  return Array.from(out);
}

function outcomeTarget(outcome: string, policy: Record<string, any>) {
  if ((policy.positive_outcomes || []).includes(outcome)) return 1;
  if ((policy.negative_outcomes || []).includes(outcome)) return 0;
  return null;
}

function run(dateStr: string, policy: Record<string, any>, strict = false) {
  const hypothesisSrc = loadHypotheses(policy, dateStr);
  const outcomeSrc = loadOutcomes(policy, dateStr);
  const state = loadState(policy);
  const nextState = { ...state };

  const updates = [];
  const sourceStats: Record<string, any> = {};

  for (const h of hypothesisSrc.hypotheses) {
    const hypothesisId = cleanText(h && h.id || '', 160);
    if (!hypothesisId) continue;
    const outcome = outcomeSrc.map.get(hypothesisId) || null;
    const target = outcome != null ? outcomeTarget(outcome, policy) : null;
    const sources = sourceIdsFromHypothesis(h);

    for (const sourceId of sources) {
      const prev = clampNumber(nextState[sourceId] && nextState[sourceId].score, Number(policy.min_score), Number(policy.max_score), Number(policy.neutral_score));
      let score = prev;
      let direction = 'neutral_decay';
      if (target == null) {
        score = prev + ((Number(policy.neutral_score) - prev) * Number(policy.decay_toward_neutral || 0.03));
      } else {
        direction = target === 1 ? 'positive' : 'negative';
        const deltaRaw = (target - prev) * Number(policy.learning_rate || 0.2);
        const delta = clampNumber(deltaRaw, -Number(policy.per_event_influence_cap || 0.12), Number(policy.per_event_influence_cap || 0.12), 0);
        score = prev + delta;
      }
      score = clampNumber(score, Number(policy.min_score), Number(policy.max_score), Number(policy.neutral_score));

      nextState[sourceId] = {
        source_id: sourceId,
        score: Number(score.toFixed(6)),
        previous_score: Number(prev.toFixed(6)),
        last_hypothesis_id: hypothesisId,
        last_outcome: outcome,
        last_updated_at: nowIso()
      };

      sourceStats[sourceId] = sourceStats[sourceId] || { source_id: sourceId, events: 0, resolved_events: 0, positive_events: 0, negative_events: 0 };
      sourceStats[sourceId].events += 1;
      if (target != null) {
        sourceStats[sourceId].resolved_events += 1;
        if (target === 1) sourceStats[sourceId].positive_events += 1;
        if (target === 0) sourceStats[sourceId].negative_events += 1;
      }

      updates.push({
        source_id: sourceId,
        hypothesis_id: hypothesisId,
        outcome,
        direction,
        previous_score: Number(prev.toFixed(6)),
        updated_score: Number(score.toFixed(6))
      });
    }
  }

  const sources = Object.values(nextState).sort((a: any, b: any) => Number(b.score || 0) - Number(a.score || 0));
  const calibration = Object.values(sourceStats).map((row: any) => {
    const hitRate = Number(row.resolved_events || 0) > 0
      ? Number(row.positive_events || 0) / Number(row.resolved_events || 1)
      : null;
    const sourceScore = nextState[row.source_id] ? Number(nextState[row.source_id].score || policy.neutral_score) : Number(policy.neutral_score);
    return {
      source_id: row.source_id,
      resolved_events: row.resolved_events,
      hit_rate: hitRate == null ? null : Number(hitRate.toFixed(6)),
      score: Number(sourceScore.toFixed(6)),
      calibration_error: hitRate == null ? null : Number(Math.abs(sourceScore - hitRate).toFixed(6))
    };
  });

  const meanCalibrationError = calibration.length > 0
    ? calibration
      .filter((row: any) => row.calibration_error != null)
      .reduce((sum: number, row: any, idx: number, arr: any[]) => sum + Number(row.calibration_error || 0), 0)
      / Math.max(1, calibration.filter((row: any) => row.calibration_error != null).length)
    : 0;

  const out = {
    ok: true,
    type: 'dynamic_source_reliability_graph',
    ts: nowIso(),
    date: dateStr,
    source_hypotheses_path: hypothesisSrc.file_path,
    source_outcomes_path: outcomeSrc.file_path,
    source_count: sources.length,
    update_count: updates.length,
    bounded_influence_cap: Number(policy.per_event_influence_cap || 0.12),
    calibration: {
      mean_abs_error: Number(meanCalibrationError.toFixed(6)),
      by_source: calibration
    },
    sources,
    updates: updates.slice(0, 500)
  };

  ensureDir(path.dirname(policy.paths.state_path));
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'dynamic_source_reliability_state',
    version: String(policy.version || '1.0'),
    updated_at: nowIso(),
    sources: nextState
  });

  ensureDir(policy.paths.output_dir);
  writeJsonAtomic(path.join(policy.paths.output_dir, `${dateStr}.json`), out);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    type: 'dynamic_source_reliability_receipt',
    date: dateStr,
    source_count: out.source_count,
    update_count: out.update_count,
    mean_abs_error: out.calibration.mean_abs_error,
    state_hash: stableHash(JSON.stringify(nextState), 24)
  });

  if (strict && updates.length === 0) {
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function status(policy: Record<string, any>, dateStr: string) {
  const fp = path.join(policy.paths.output_dir, `${dateStr}.json`);
  const payload = readJson(fp, {
    ok: true,
    type: 'dynamic_source_reliability_graph_status',
    date: dateStr,
    source_count: 0
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usageAndExit(code = 0) {
  console.log('Usage:');
  console.log('  node systems/sensory/dynamic_source_reliability_graph.js run [YYYY-MM-DD] [--strict=1] [--policy=<path>]');
  console.log('  node systems/sensory/dynamic_source_reliability_graph.js status [YYYY-MM-DD] [--policy=<path>]');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
  const strict = toBool(args.strict, false);
  const policy = loadPolicy(args.policy ? String(args.policy) : undefined);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'policy_disabled' }, null, 2)}\n`);
    process.exit(2);
  }
  if (cmd === 'run') return run(dateStr, policy, strict);
  if (cmd === 'status') return status(policy, dateStr);
  return usageAndExit(2);
}

module.exports = {
  run
};

if (require.main === module) {
  main();
}
