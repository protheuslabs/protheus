#!/usr/bin/env node
'use strict';
export {};

/**
 * suggestion_lane.js
 *
 * Unifies pulsed suggestion sources into a single capped lane.
 * Suggestions remain proposed-only (no autonomous execution).
 *
 * Usage:
 *   node systems/autonomy/suggestion_lane.js run [YYYY-MM-DD] [--cap=24]
 *   node systems/autonomy/suggestion_lane.js status [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const BUDGET_GUARD_DIR = process.env.AUTONOMY_BUDGET_GUARD_SUGGESTIONS_DIR
  ? path.resolve(process.env.AUTONOMY_BUDGET_GUARD_SUGGESTIONS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'budget_guard_suggestions');
const ADAPTIVE_SUGGESTIONS_DIR = process.env.AUTONOMY_ADAPTIVE_SUGGESTIONS_DIR
  ? path.resolve(process.env.AUTONOMY_ADAPTIVE_SUGGESTIONS_DIR)
  : path.join(ROOT, 'state', 'adaptive', 'suggestions');
const TRIT_ADAPTATION_DIR = process.env.AUTONOMY_TRIT_SHADOW_ADAPTATION_DIR
  ? path.resolve(process.env.AUTONOMY_TRIT_SHADOW_ADAPTATION_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'trit_shadow_adaptation');
const MIRROR_ORGAN_SUGGESTIONS_DIR = process.env.AUTONOMY_MIRROR_ORGAN_SUGGESTIONS_DIR
  ? path.resolve(process.env.AUTONOMY_MIRROR_ORGAN_SUGGESTIONS_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'mirror_organ', 'suggestions');
const OUTPUT_DIR = process.env.AUTONOMY_SUGGESTION_LANE_DIR
  ? path.resolve(process.env.AUTONOMY_SUGGESTION_LANE_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'suggestion_lane');

const DEFAULT_CAP = clampInt(process.env.AUTONOMY_SUGGESTION_LANE_DAILY_CAP || 24, 4, 240, 24);

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/suggestion_lane.js run [YYYY-MM-DD] [--cap=24]');
  console.log('  node systems/autonomy/suggestion_lane.js status [YYYY-MM-DD]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
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
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function clampInt(value, lo, hi, fallback = lo) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
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

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function stableId(seed, prefix = 'sln') {
  const digest = crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 20);
  return `${prefix}_${digest}`;
}

function compactText(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max)}...`;
}

function normalizeBudgetGuard(rows, dateStr) {
  const src = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of src) {
    const pressure = String(row && row.pressure || 'none').trim().toLowerCase() || 'none';
    const action = String(row && row.action || '').trim().toLowerCase() || 'allow';
    const reason = compactText(row && row.reason || '');
    const sourceId = String(row && row.id || '').trim();
    const id = sourceId || stableId(`budget_guard|${dateStr}|${pressure}|${action}|${reason}`, 'bgs');
    const priority = pressure === 'hard'
      ? 0.95
      : (pressure === 'soft' ? 0.72 : 0.55);
    out.push({
      id,
      source: 'budget_guard',
      source_ref: sourceId || null,
      kind: String(row && row.type || 'strategy_budget_adjustment_suggestion'),
      status: 'proposed',
      date: dateStr,
      priority: Number(priority.toFixed(3)),
      title: compactText(row && row.type || 'Budget guard suggestion', 90),
      summary: compactText(
        `${action} under ${pressure} pressure${reason ? `: ${reason}` : ''}`,
        220
      ),
      action,
      pressure,
      token_cap: Number(row && row.token_cap || 0),
      used_est: Number(row && row.used_est || 0),
      suggested_adjustments: Array.isArray(row && row.suggested_adjustments)
        ? row.suggested_adjustments.slice(0, 4).map((v) => compactText(v, 200))
        : []
    });
  }
  return out;
}

function normalizeAdaptive(rows, dateStr) {
  const src = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of src) {
    const relationCount = Math.max(0, Number(row && row.relation_count || 0));
    const sourceId = String(row && row.id || '').trim();
    const id = sourceId || stableId(`adaptive|${dateStr}|${row && row.theme_tag}`, 'adp');
    const priority = Math.max(0.4, Math.min(0.9, 0.48 + (Math.min(12, relationCount) * 0.03)));
    out.push({
      id,
      source: 'adaptive_memory',
      source_ref: sourceId || null,
      kind: String(row && row.type || 'adaptive_memory_candidate'),
      status: 'proposed',
      date: dateStr,
      priority: Number(priority.toFixed(3)),
      title: compactText(row && row.title || `Adaptive memory candidate: ${String(row && row.theme_tag || 'unknown')}`, 110),
      summary: compactText(row && row.suggested_action || '', 220),
      theme_tag: String(row && row.theme_tag || '').trim() || null,
      relation_count: relationCount,
      evidence_uids: Array.isArray(row && row.evidence_uids) ? row.evidence_uids.slice(0, 8) : []
    });
  }
  return out;
}

function normalizeTritAdaptation(payload, dateStr) {
  const root = payload && typeof payload === 'object' ? payload : {};
  const suggestions = Array.isArray(root.suggestions) ? root.suggestions : [];
  const out = [];
  for (const row of suggestions) {
    const source = String(row && row.source || '').trim();
    if (!source) continue;
    const delta = Number(row && row.delta || 0);
    const sourceId = stableId(`trit|${dateStr}|${source}|${delta}`, 'trt');
    const priority = Math.max(0.45, Math.min(0.88, 0.5 + (Math.min(0.25, Math.abs(delta)) * 0.9)));
    const direction = delta > 0 ? 'increase' : 'decrease';
    out.push({
      id: sourceId,
      source: 'trit_shadow_adaptation',
      source_ref: source,
      kind: 'trit_shadow_trust_suggestion',
      status: 'proposed',
      date: dateStr,
      priority: Number(priority.toFixed(3)),
      title: `Trit trust ${direction}: ${source}`,
      summary: compactText(
        `Suggested trust ${direction} for ${source} (delta=${Number(delta.toFixed(4))}, reliability=${Number(Number(row && row.reliability || 0).toFixed(4))}).`,
        220
      ),
      source_name: source,
      samples: Math.max(0, Number(row && row.samples || 0)),
      reliability: Number(Number(row && row.reliability || 0).toFixed(4)),
      current_trust: Number(Number(row && row.current_trust || 0).toFixed(4)),
      suggested_trust: Number(Number(row && row.suggested_trust || 0).toFixed(4)),
      delta: Number(delta.toFixed(4))
    });
  }
  return out;
}

function normalizeMirrorOrgan(rows, dateStr) {
  const src = Array.isArray(rows) ? rows : [];
  const out = [];
  for (const row of src) {
    const sourceId = String(row && row.id || '').trim();
    const kind = String(row && (row.kind || row.type) || 'mirror_self_critique_suggestion').trim() || 'mirror_self_critique_suggestion';
    const confidence = Math.max(0, Math.min(1, Number(row && row.confidence || 0)));
    const pressure = Math.max(0, Math.min(1, Number(row && row.pressure_score || 0)));
    const priorityRaw = Number(row && row.priority);
    const priority = Number.isFinite(priorityRaw)
      ? Math.max(0, Math.min(1, priorityRaw))
      : Math.max(0.45, Math.min(0.96, (confidence * 0.65) + (pressure * 0.35)));
    const id = sourceId || stableId(`mirror|${dateStr}|${kind}|${row && row.title}`, 'mir');
    out.push({
      id,
      source: 'mirror_organ',
      source_ref: sourceId || null,
      kind,
      status: 'proposed',
      date: dateStr,
      priority: Number(priority.toFixed(3)),
      title: compactText(row && row.title || 'Mirror self-critique suggestion', 110),
      summary: compactText(row && row.summary || '', 220),
      confidence: Number(confidence.toFixed(4)),
      pressure_score: Number(pressure.toFixed(4)),
      objective_id: String(row && row.objective_id || '').trim() || null,
      action: row && row.action && typeof row.action === 'object'
        ? row.action
        : {},
      evidence_refs: Array.isArray(row && row.evidence_refs)
        ? row.evidence_refs.slice(0, 8)
        : []
    });
  }
  return out;
}

function scoreSort(a, b) {
  const pa = Number(a && a.priority || 0);
  const pb = Number(b && b.priority || 0);
  if (Math.abs(pb - pa) > 0.0001) return pb - pa;
  const sa = String(a && a.source || '');
  const sb = String(b && b.source || '');
  if (sa !== sb) return sa.localeCompare(sb);
  return String(a && a.id || '').localeCompare(String(b && b.id || ''));
}

function laneFilePath(dateStr) {
  ensureDir(OUTPUT_DIR);
  return path.join(OUTPUT_DIR, `${dateStr}.json`);
}

function cmdRun(dateStr, capRaw) {
  const cap = clampInt(capRaw == null ? DEFAULT_CAP : capRaw, 1, 240, DEFAULT_CAP);
  const budgetFile = path.join(BUDGET_GUARD_DIR, `${dateStr}.json`);
  const adaptiveFile = path.join(ADAPTIVE_SUGGESTIONS_DIR, `${dateStr}.json`);
  const tritFile = path.join(TRIT_ADAPTATION_DIR, `${dateStr}.json`);
  const mirrorFile = path.join(MIRROR_ORGAN_SUGGESTIONS_DIR, `${dateStr}.json`);

  const budgetRows = normalizeBudgetGuard(readJson(budgetFile, []), dateStr);
  const adaptiveRows = normalizeAdaptive(readJson(adaptiveFile, []), dateStr);
  const tritRows = normalizeTritAdaptation(readJson(tritFile, null), dateStr);
  const mirrorRows = normalizeMirrorOrgan(readJson(mirrorFile, []), dateStr);
  const merged = [...budgetRows, ...adaptiveRows, ...tritRows, ...mirrorRows];
  const deduped = [];
  const seen = new Set();
  for (const row of merged.sort(scoreSort)) {
    const id = String(row && row.id || '').trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push(row);
  }
  const laneRows = deduped.slice(0, cap).map((row, idx) => ({
    ...row,
    lane_rank: idx + 1
  }));

  const payload = {
    ok: true,
    type: 'autonomy_suggestion_lane',
    ts: nowIso(),
    date: dateStr,
    cap,
    total_candidates: deduped.length,
    merged_count: laneRows.length,
    capped: deduped.length > cap,
    sources: {
      budget_guard: budgetRows.length,
      adaptive_memory: adaptiveRows.length,
      trit_shadow_adaptation: tritRows.length,
      mirror_organ: mirrorRows.length
    },
    lane: laneRows
  };
  const outPath = laneFilePath(dateStr);
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  process.stdout.write(JSON.stringify({
    ...payload,
    lane_path: path.relative(ROOT, outPath).replace(/\\/g, '/')
  }) + '\n');
}

function cmdStatus(dateStr) {
  const fp = laneFilePath(dateStr);
  const payload = readJson(fp, null);
  if (!payload || typeof payload !== 'object') {
    process.stdout.write(JSON.stringify({
      ok: false,
      type: 'autonomy_suggestion_lane',
      date: dateStr,
      error: 'lane_not_found'
    }) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'autonomy_suggestion_lane_status',
    date: dateStr,
    cap: Number(payload.cap || 0),
    merged_count: Number(payload.merged_count || 0),
    total_candidates: Number(payload.total_candidates || 0),
    capped: payload.capped === true,
    sources: payload.sources && typeof payload.sources === 'object' ? payload.sources : {},
    lane_path: path.relative(ROOT, fp).replace(/\\/g, '/')
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help === true) {
    usage();
    return;
  }
  const dateStr = dateArgOrToday(args._[1]);
  if (cmd === 'run') {
    cmdRun(dateStr, args.cap);
    return;
  }
  if (cmd === 'status') {
    cmdStatus(dateStr);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}

module.exports = {
  normalizeBudgetGuard,
  normalizeAdaptive,
  normalizeTritAdaptation
};
