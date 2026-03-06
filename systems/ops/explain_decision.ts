#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

const ROOT = process.env.EXPLAIN_DECISION_ROOT
  ? path.resolve(process.env.EXPLAIN_DECISION_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.EXPLAIN_DECISION_POLICY_PATH
  ? path.resolve(process.env.EXPLAIN_DECISION_POLICY_PATH)
  : path.join(ROOT, 'config', 'explain_decision_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}
function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}
function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}
function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/explain_decision.js run [--source=auto|task_decomposition|explanation|passport|duality|self_improvement] [--decision-id=<id>] [--policy=<path>]');
  console.log('  node systems/ops/explain_decision.js status [--policy=<path>]');
}
function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}
function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 600);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}
function parseIsoTs(v: unknown) {
  const txt = cleanText(v || '', 64);
  const ms = Date.parse(txt);
  return Number.isFinite(ms) ? ms : null;
}
function fileMtimeMs(filePath: string) {
  try { return fs.statSync(filePath).mtimeMs; } catch { return 0; }
}
function first(arr: any[], fallback = null) {
  return Array.isArray(arr) && arr.length ? arr[0] : fallback;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_reason_count: 4,
    paths: {
      latest_path: 'state/ops/explain_decision/latest.json',
      receipts_path: 'state/ops/explain_decision/receipts.jsonl'
    },
    sources: {
      task_decomposition: 'state/execution/task_decomposition_primitive/latest.json',
      explanation: 'state/primitives/explanation_primitive/latest.json',
      passport: 'state/security/agent_passport/latest.json',
      duality: 'state/autonomy/duality/latest.json',
      self_improvement: 'state/autonomy/gated_self_improvement/latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const sourcesRaw = raw.sources && typeof raw.sources === 'object' ? raw.sources : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    max_reason_count: Math.max(1, Math.min(8, Number(raw.max_reason_count || base.max_reason_count))),
    paths: {
      latest_path: resolvePath(pathsRaw.latest_path || base.paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(pathsRaw.receipts_path || base.paths.receipts_path, base.paths.receipts_path)
    },
    sources: {
      task_decomposition: resolvePath(sourcesRaw.task_decomposition || base.sources.task_decomposition, base.sources.task_decomposition),
      explanation: resolvePath(sourcesRaw.explanation || base.sources.explanation, base.sources.explanation),
      passport: resolvePath(sourcesRaw.passport || base.sources.passport, base.sources.passport),
      duality: resolvePath(sourcesRaw.duality || base.sources.duality, base.sources.duality),
      self_improvement: resolvePath(sourcesRaw.self_improvement || base.sources.self_improvement, base.sources.self_improvement)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadSourcePayload(sourceId: string, filePath: string) {
  const payload = readJson(filePath, null);
  if (!payload || typeof payload !== 'object') return null;
  const ts = parseIsoTs((payload as any).ts)
    || parseIsoTs((payload as any).updated_at)
    || parseIsoTs((payload as any).created_at)
    || fileMtimeMs(filePath)
    || Date.now();
  return {
    source_id: sourceId,
    path: filePath,
    payload,
    ts_ms: ts
  };
}

function collectReasons(...values: any[]) {
  const out: string[] = [];
  for (const v of values) {
    if (!Array.isArray(v)) continue;
    for (const row of v) {
      const txt = cleanText(row, 220);
      if (!txt) continue;
      if (out.includes(txt)) continue;
      out.push(txt);
    }
  }
  return out;
}

function dualityLabel(score: unknown) {
  const n = Number(score);
  if (!Number.isFinite(n)) return null;
  if (n > 0) return 'positive';
  if (n < 0) return 'negative';
  return 'neutral';
}

function extractDecisionContext(row: any) {
  const payload = row && row.payload && typeof row.payload === 'object' ? row.payload : {};
  const source = String(row && row.source_id || 'unknown');

  if (source === 'task_decomposition') {
    const firstTask = first(payload.micro_tasks, {}) || {};
    const governance = firstTask.governance || payload.governance || {};
    const heroic = governance.heroic_echo || {};
    const constitution = governance.constitution || {};
    const duality = firstTask.duality || payload.duality || {};
    const reasons = collectReasons(governance.block_reasons, heroic.reason_codes, constitution.reasons);
    return {
      source_id: source,
      ts: cleanText(payload.ts || '', 64),
      decision_id: cleanText(payload.run_id || payload.goal && payload.goal.goal_id || '', 120),
      objective_id: cleanText(payload.goal && payload.goal.objective_id || '', 120),
      summary: cleanText(payload.goal && payload.goal.goal_text || firstTask.task_text || payload.type || '', 320),
      shadow_only: payload.shadow_only === true,
      blocked: governance.blocked === true || String(payload.status || '').toLowerCase() === 'blocked',
      decision: governance.blocked === true ? 'deny' : (payload.shadow_only === true ? 'shadow_only' : 'allow'),
      heroic_decision: cleanText(heroic.decision || '', 120),
      constitution_decision: cleanText(constitution.decision || '', 120),
      duality_score: Number.isFinite(Number(duality.score_trit)) ? Number(duality.score_trit) : null,
      duality_adjustment: cleanText(duality.recommended_adjustment || '', 140),
      reasons,
      passport_id: cleanText(payload.passport_id || '', 120)
    };
  }

  if (source === 'self_improvement') {
    const gates = payload.gates && payload.gates.gates ? payload.gates.gates : {};
    const blocked = Object.values(gates).some((v: any) => v === false);
    return {
      source_id: source,
      ts: cleanText(payload.ts || '', 64),
      decision_id: cleanText(payload.proposal_id || '', 120),
      objective_id: '',
      summary: cleanText(payload.transition || payload.type || 'self-improvement gate', 320),
      shadow_only: payload.sandbox && payload.sandbox.merged !== true,
      blocked,
      decision: blocked ? 'deny' : 'allow',
      heroic_decision: '',
      constitution_decision: '',
      duality_score: null,
      duality_adjustment: '',
      reasons: Object.entries(gates).filter(([, v]) => v === false).map(([k]) => `gate_failed:${k}`),
      passport_id: ''
    };
  }

  if (source === 'duality') {
    const d = payload.duality && typeof payload.duality === 'object' ? payload.duality : payload;
    return {
      source_id: source,
      ts: cleanText(payload.ts || payload.updated_at || '', 64),
      decision_id: cleanText(payload.evaluation_id || payload.trace_id || '', 120),
      objective_id: cleanText(payload.objective_id || '', 120),
      summary: cleanText(payload.context || payload.reason || 'duality advisory', 320),
      shadow_only: true,
      blocked: false,
      decision: 'advisory',
      heroic_decision: '',
      constitution_decision: '',
      duality_score: Number.isFinite(Number(d.score || d.score_trit)) ? Number(d.score || d.score_trit) : null,
      duality_adjustment: cleanText(d.recommended_adjustment || '', 140),
      reasons: [],
      passport_id: ''
    };
  }

  if (source === 'passport') {
    const lastAction = first(payload.latest_actions, {}) || {};
    return {
      source_id: source,
      ts: cleanText(payload.ts || payload.updated_at || '', 64),
      decision_id: cleanText(lastAction.action_id || '', 120),
      objective_id: cleanText(lastAction.action && lastAction.action.objective_id || '', 120),
      summary: cleanText(lastAction.action && lastAction.action.action_type || 'passport action', 320),
      shadow_only: false,
      blocked: false,
      decision: 'recorded',
      heroic_decision: '',
      constitution_decision: '',
      duality_score: null,
      duality_adjustment: '',
      reasons: [],
      passport_id: cleanText(payload.passport_id || '', 120)
    };
  }

  const reasons = collectReasons(payload.reasons, payload.reason_codes, payload.block_reasons);
  return {
    source_id: source,
    ts: cleanText(payload.ts || payload.updated_at || '', 64),
    decision_id: cleanText(payload.explanation_id || payload.decision_id || '', 120),
    objective_id: cleanText(payload.objective_id || '', 120),
    summary: cleanText(payload.summary || payload.category || payload.type || '', 320),
    shadow_only: payload.shadow_only === true,
    blocked: String(payload.decision || '').toLowerCase() === 'deny',
    decision: cleanText(payload.decision || (payload.shadow_only === true ? 'shadow_only' : 'allow'), 80),
    heroic_decision: '',
    constitution_decision: '',
    duality_score: null,
    duality_adjustment: '',
    reasons,
    passport_id: cleanText(payload.passport_id || '', 120)
  };
}

function buildNarrative(ctx: any, maxReasons: number) {
  const lines: string[] = [];
  const source = cleanText(ctx.source_id || 'unknown', 80);
  const when = cleanText(ctx.ts || '', 64) || 'unknown time';
  const summary = cleanText(ctx.summary || 'decision event', 280);
  lines.push(`Decision trace from ${source} at ${when}: ${summary}.`);

  if (ctx.blocked === true) lines.push('Outcome: blocked by governance safeguards.');
  else if (ctx.shadow_only === true) lines.push('Outcome: shadow-only execution, no live mutation or actuation was applied.');
  else lines.push('Outcome: allowed under current gates.');

  if (ctx.heroic_decision) lines.push(`Heroic Echo signal: ${ctx.heroic_decision}.`);
  if (ctx.constitution_decision) lines.push(`Constitution gate: ${ctx.constitution_decision}.`);

  const dLabel = dualityLabel(ctx.duality_score);
  if (dLabel) {
    let fragment = `Duality balance is ${dLabel}`;
    if (ctx.duality_adjustment) fragment += `; suggested adjustment is ${ctx.duality_adjustment}`;
    lines.push(`${fragment}.`);
  }

  const reasons = Array.isArray(ctx.reasons) ? ctx.reasons.slice(0, maxReasons) : [];
  if (reasons.length) lines.push(`Primary reasons: ${reasons.join('; ')}.`);
  if (ctx.passport_id) lines.push(`Chain-of-custody reference: passport ${ctx.passport_id}.`);

  return lines.join(' ');
}

function selectSource(policy: any, sourceArg: string, decisionId: string) {
  const sourceMap: Record<string, string> = {
    task_decomposition: policy.sources.task_decomposition,
    explanation: policy.sources.explanation,
    passport: policy.sources.passport,
    duality: policy.sources.duality,
    self_improvement: policy.sources.self_improvement
  };
  if (sourceArg && sourceArg !== 'auto') {
    const selectedPath = sourceMap[sourceArg];
    if (!selectedPath) return null;
    const row = loadSourcePayload(sourceArg, selectedPath);
    if (!row) return null;
    return row;
  }

  const rows = Object.entries(sourceMap)
    .map(([id, p]) => loadSourcePayload(id, p))
    .filter(Boolean) as any[];
  if (!rows.length) return null;

  if (decisionId) {
    const match = rows.find((row) => {
      const payload = row.payload || {};
      return [payload.run_id, payload.proposal_id, payload.explanation_id, payload.decision_id, payload.passport_id]
        .map((v) => cleanText(v || '', 160))
        .includes(decisionId);
    });
    if (match) return match;
  }

  rows.sort((a, b) => Number(b.ts_ms || 0) - Number(a.ts_ms || 0));
  return rows[0];
}

function cmdRun(args: any) {
  const policyPath = args.policy ? resolvePath(args.policy, 'config/explain_decision_policy.json') : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explain_decision', error: 'policy_disabled' })}\n`);
    process.exit(2);
  }

  const source = normalizeToken(args.source || 'auto', 80) || 'auto';
  const decisionId = cleanText(args['decision-id'] || '', 160);
  const selected = selectSource(policy, source, decisionId);
  if (!selected) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'explain_decision', error: 'source_not_found', source })}\n`);
    process.exit(3);
  }

  const ctx = extractDecisionContext(selected);
  const narrative = buildNarrative(ctx, policy.max_reason_count);
  const out = {
    ok: true,
    type: 'explain_decision',
    ts: nowIso(),
    source_id: ctx.source_id,
    source_path: rel(selected.path),
    policy_path: rel(policy.policy_path),
    decision_id: ctx.decision_id || null,
    objective_id: ctx.objective_id || null,
    decision: ctx.decision || null,
    shadow_only: ctx.shadow_only === true,
    blocked: ctx.blocked === true,
    duality_score: Number.isFinite(Number(ctx.duality_score)) ? Number(ctx.duality_score) : null,
    duality_adjustment: ctx.duality_adjustment || null,
    reasons: Array.isArray(ctx.reasons) ? ctx.reasons.slice(0, policy.max_reason_count) : [],
    narrative,
    plain_english: narrative
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdStatus(args: any) {
  const policyPath = args.policy ? resolvePath(args.policy, 'config/explain_decision_policy.json') : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const latest = readJson(policy.paths.latest_path, null);
  const receipts = fs.existsSync(policy.paths.receipts_path)
    ? fs.readFileSync(policy.paths.receipts_path, 'utf8').split('\n').filter(Boolean).length
    : 0;
  const out = {
    ok: true,
    type: 'explain_decision_status',
    ts: nowIso(),
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path),
    receipts_path: rel(policy.paths.receipts_path),
    counts: {
      receipts
    },
    latest: latest
      ? {
          ts: cleanText(latest.ts || '', 64) || null,
          source_id: cleanText(latest.source_id || '', 80) || null,
          decision_id: cleanText(latest.decision_id || '', 120) || null
        }
      : null
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 40) || 'run';
  if (cmd === 'help' || args.help || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  extractDecisionContext,
  buildNarrative,
  selectSource
};

