#!/usr/bin/env node
'use strict';
export {};

/**
 * proactive_t1_initiative_engine.js
 *
 * V3-PRO-001:
 * Proactive goal-pursuit loop that executes low/medium workflows without prompting.
 *
 * Commands:
 *   node systems/autonomy/proactive_t1_initiative_engine.js enqueue --initiative-json="{...}"
 *   node systems/autonomy/proactive_t1_initiative_engine.js tick [--context-json="{...}"] [--source=<id>] [--apply=0|1]
 *   node systems/autonomy/proactive_t1_initiative_engine.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.PROACTIVE_T1_INITIATIVE_ENGINE_POLICY_PATH
  ? path.resolve(process.env.PROACTIVE_T1_INITIATIVE_ENGINE_POLICY_PATH)
  : path.join(ROOT, 'config', 'proactive_t1_initiative_engine_policy.json');
const ZPL_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'zero_permission_conversational_layer.js');
const UOP_SCRIPT = path.join(ROOT, 'systems', 'workflow', 'universal_outreach_primitive.js');
const SYM_SCRIPT = path.join(ROOT, 'systems', 'symbiosis', 'deep_symbiosis_understanding_layer.js');
const BURN_ORACLE_LATEST = path.join(ROOT, 'state', 'ops', 'dynamic_burn_budget_oracle', 'latest.json');

type AnyObj = Record<string, any>;

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 240) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}
function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v); if (!Number.isFinite(n)) return fallback; const i = Math.floor(n); if (i < lo) return lo; if (i > hi) return hi; return i;
}
function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const idx = tok.indexOf('=');
    if (idx >= 0) { out[tok.slice(2, idx)] = tok.slice(idx + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function parseJsonArg(raw: unknown, fallback: any = {}) {
  const txt = String(raw == null ? '' : raw).trim();
  if (!txt) return fallback;
  try { const parsed = JSON.parse(txt); return parsed && typeof parsed === 'object' ? parsed : fallback; } catch { return fallback; }
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
}
function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean).map((line) => {
      try { const row = JSON.parse(line); return row && typeof row === 'object' ? row : null; } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}
function writeJsonl(filePath: string, rows: AnyObj[]) {
  ensureDir(path.dirname(filePath));
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 420);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}
function parseJsonOutput(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { return JSON.parse(lines[i]); } catch {}
    }
  }
  return null;
}
function runNodeJson(scriptPath: string, args: string[], timeoutMs = 15000) {
  const proc = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  return {
    ok: proc.status === 0,
    code: Number(proc.status || 0),
    payload: parseJsonOutput(proc.stdout),
    stdout: String(proc.stdout || '').trim(),
    stderr: String(proc.stderr || '').trim(),
    timed_out: Boolean(proc.error && (proc.error as AnyObj).code === 'ETIMEDOUT')
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    auto_generate_from_context: true,
    min_tick_interval_sec: 300,
    max_initiatives_per_tick: 6,
    objective_id: 'T1_make_jay_billionaire_v1',
    auto_execute_risk_tiers: ['low', 'medium'],
    state: {
      state_path: 'state/autonomy/proactive_t1_initiative_engine/state.json',
      queue_path: 'state/autonomy/proactive_t1_initiative_engine/queue.jsonl',
      latest_path: 'state/autonomy/proactive_t1_initiative_engine/latest.json',
      receipts_path: 'state/autonomy/proactive_t1_initiative_engine/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    auto_generate_from_context: raw.auto_generate_from_context !== false,
    min_tick_interval_sec: clampInt(raw.min_tick_interval_sec, 0, 24 * 60 * 60, base.min_tick_interval_sec),
    max_initiatives_per_tick: clampInt(raw.max_initiatives_per_tick, 1, 256, base.max_initiatives_per_tick),
    objective_id: normalizeToken(raw.objective_id || base.objective_id, 160) || base.objective_id,
    auto_execute_risk_tiers: Array.from(new Set(
      (Array.isArray(raw.auto_execute_risk_tiers) ? raw.auto_execute_risk_tiers : base.auto_execute_risk_tiers)
        .map((row: unknown) => normalizeToken(row, 20))
        .filter((row: string) => ['low', 'medium', 'high'].includes(row))
    )),
    state: {
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      queue_path: resolvePath(state.queue_path || base.state.queue_path, base.state.queue_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'proactive_t1_initiative_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_tick_ts: null,
    tick_count: 0,
    executed_total: 0,
    escalated_total: 0
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'proactive_t1_initiative_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60) || nowIso(),
    last_tick_ts: src.last_tick_ts || null,
    tick_count: clampInt(src.tick_count, 0, 1_000_000_000, 0),
    executed_total: clampInt(src.executed_total, 0, 1_000_000_000, 0),
    escalated_total: clampInt(src.escalated_total, 0, 1_000_000_000, 0)
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'proactive_t1_initiative_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_tick_ts: state.last_tick_ts || null,
    tick_count: clampInt(state.tick_count, 0, 1_000_000_000, 0),
    executed_total: clampInt(state.executed_total, 0, 1_000_000_000, 0),
    escalated_total: clampInt(state.escalated_total, 0, 1_000_000_000, 0)
  });
}

function persistLatest(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.state.latest_path, row);
  appendJsonl(policy.state.receipts_path, row);
}

function normalizeInitiative(raw: AnyObj, objectiveId: string) {
  const kind = normalizeToken(raw.kind || 'noop', 60) || 'noop';
  return {
    initiative_id: normalizeToken(raw.initiative_id || `init_${Date.now().toString(36)}`, 120) || `init_${Date.now().toString(36)}`,
    ts: cleanText(raw.ts || nowIso(), 60) || nowIso(),
    source: normalizeToken(raw.source || 'proactive_engine', 120) || 'proactive_engine',
    objective_id: normalizeToken(raw.objective_id || objectiveId, 160) || objectiveId,
    kind,
    risk_tier: normalizeToken(raw.risk_tier || raw.risk || 'medium', 20) || 'medium',
    estimated_cost_usd: Number.isFinite(Number(raw.estimated_cost_usd)) ? Number(raw.estimated_cost_usd) : 8,
    liability_score: Number.isFinite(Number(raw.liability_score)) ? Number(raw.liability_score) : 0.35,
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {}
  };
}

function generateContextInitiatives(policy: AnyObj, context: AnyObj, source: string) {
  if (!policy.auto_generate_from_context) return [];
  const out: AnyObj[] = [];
  const leads = Array.isArray(context.leads) ? context.leads : Array.isArray(context.leads_json) ? context.leads_json : [];
  if (leads.length) {
    out.push(normalizeInitiative({
      source,
      kind: 'outreach_campaign',
      risk_tier: cleanText(context.risk_tier || 'medium', 20) || 'medium',
      estimated_cost_usd: Number(leads.length) * 8,
      liability_score: 0.35,
      payload: {
        campaign_id: normalizeToken(context.campaign_id || `auto_campaign_${Date.now().toString(36)}`, 120),
        leads,
        offer: context.offer && typeof context.offer === 'object' ? context.offer : { offer: 'quick growth teardown' }
      }
    }, policy.objective_id));
  }
  if (!out.length) {
    const burn = readJson(BURN_ORACLE_LATEST, {});
    const pressure = normalizeToken(burn && burn.projection && burn.projection.pressure || 'none', 20) || 'none';
    out.push(normalizeInitiative({
      source,
      kind: 'noop',
      risk_tier: pressure === 'critical' ? 'high' : 'low',
      estimated_cost_usd: 0,
      liability_score: 0.05,
      payload: { note: 'background_t1_scan', pressure }
    }, policy.objective_id));
  }
  return out;
}

function enqueue(policy: AnyObj, args: AnyObj) {
  const rowRaw = parseJsonArg(args['initiative-json'] || args.initiative_json, {});
  const row = normalizeInitiative(rowRaw, policy.objective_id);
  appendJsonl(policy.state.queue_path, row);
  const out = {
    ok: true,
    type: 'proactive_t1_enqueue',
    ts: nowIso(),
    initiative: row,
    paths: {
      queue_path: rel(policy.state.queue_path),
      latest_path: rel(policy.state.latest_path)
    }
  };
  persistLatest(policy, out);
  return out;
}

function executeInitiative(policy: AnyObj, initiative: AnyObj) {
  const decision = runNodeJson(ZPL_SCRIPT, [
    'decide',
    `--action-id=${initiative.initiative_id}`,
    `--risk-tier=${initiative.risk_tier}`,
    `--estimated-cost-usd=${Number(initiative.estimated_cost_usd || 0).toFixed(6)}`,
    `--liability-score=${Number(initiative.liability_score || 0).toFixed(6)}`,
    '--apply=0'
  ]);
  const decisionPayload = decision.payload && typeof decision.payload === 'object' ? decision.payload : {};
  const riskTier = normalizeToken(decisionPayload.risk_tier || initiative.risk_tier || 'medium', 20) || 'medium';
  const executeAllowed = policy.auto_execute_risk_tiers.includes(riskTier)
    && decisionPayload.execute_now !== false;

  const sym = runNodeJson(SYM_SCRIPT, [
    'predict',
    `--intent=${normalizeToken(initiative.kind || 'general', 80) || 'general'}`,
    `--context-json=${JSON.stringify({ priority: riskTier === 'high' ? 'high' : 'normal' })}`
  ], 5000);

  if (!executeAllowed) {
    return {
      executed: false,
      escalated: true,
      risk_tier: riskTier,
      decision: decisionPayload,
      symbiosis: sym.payload && typeof sym.payload === 'object' ? sym.payload : null,
      reason: 'not_in_auto_execute_tiers'
    };
  }

  if (initiative.kind === 'outreach_campaign') {
    const payload = initiative.payload && typeof initiative.payload === 'object' ? initiative.payload : {};
    const leads = Array.isArray(payload.leads) ? payload.leads : [];
    const offer = payload.offer && typeof payload.offer === 'object' ? payload.offer : { offer: 'quick growth teardown' };
    const campaignId = normalizeToken(payload.campaign_id || `auto_${initiative.initiative_id}`, 120) || `auto_${initiative.initiative_id}`;

    const plan = runNodeJson(UOP_SCRIPT, [
      'plan',
      `--campaign-id=${campaignId}`,
      `--leads-json=${JSON.stringify(leads)}`,
      `--offer-json=${JSON.stringify(offer)}`,
      '--apply=0'
    ], 20000);
    const run = plan.ok
      ? runNodeJson(UOP_SCRIPT, [
        'run',
        `--campaign-id=${campaignId}`,
        '--force=1',
        '--apply=0'
      ], 20000)
      : { ok: false, payload: null };

    return {
      executed: plan.ok && run.ok,
      escalated: !(plan.ok && run.ok),
      risk_tier: riskTier,
      decision: decisionPayload,
      plan: plan.payload && typeof plan.payload === 'object' ? plan.payload : null,
      run: run.payload && typeof run.payload === 'object' ? run.payload : null,
      symbiosis: sym.payload && typeof sym.payload === 'object' ? sym.payload : null,
      reason: plan.ok && run.ok ? null : 'outreach_execution_failed'
    };
  }

  return {
    executed: true,
    escalated: false,
    risk_tier: riskTier,
    decision: decisionPayload,
    symbiosis: sym.payload && typeof sym.payload === 'object' ? sym.payload : null,
    reason: null
  };
}

function tick(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const now = Date.now();
  const lastTickMs = Date.parse(String(state.last_tick_ts || ''));
  const minIntervalMs = Number(policy.min_tick_interval_sec || 0) * 1000;
  if (Number.isFinite(lastTickMs) && minIntervalMs > 0 && (now - Number(lastTickMs)) < minIntervalMs && toBool(args.force, false) !== true) {
    return {
      ok: true,
      type: 'proactive_t1_tick',
      ts: nowIso(),
      skipped: true,
      reason: 'min_tick_interval_not_elapsed',
      next_eligible_at: new Date(Number(lastTickMs) + minIntervalMs).toISOString()
    };
  }

  const source = normalizeToken(args.source || 'manual', 80) || 'manual';
  const context = parseJsonArg(args['context-json'] || args.context_json, {});
  const queue = readJsonl(policy.state.queue_path);
  const generated = generateContextInitiatives(policy, context, source);
  const merged = [...queue, ...generated]
    .map((row: AnyObj) => normalizeInitiative(row, policy.objective_id));

  const limit = clampInt(policy.max_initiatives_per_tick, 1, 256, 6);
  const selected = merged.slice(0, limit);
  const remainder = merged.slice(selected.length);

  const outcomes = selected.map((initiative: AnyObj) => {
    const result = executeInitiative(policy, initiative);
    return {
      initiative_id: initiative.initiative_id,
      kind: initiative.kind,
      objective_id: initiative.objective_id,
      risk_tier: initiative.risk_tier,
      result
    };
  });

  writeJsonl(policy.state.queue_path, remainder);

  const executedCount = outcomes.filter((row: AnyObj) => row.result && row.result.executed === true).length;
  const escalatedCount = outcomes.filter((row: AnyObj) => row.result && row.result.escalated === true).length;

  state.last_tick_ts = nowIso();
  state.tick_count = clampInt(Number(state.tick_count || 0) + 1, 0, 1_000_000_000, 0);
  state.executed_total = clampInt(Number(state.executed_total || 0) + executedCount, 0, 1_000_000_000, 0);
  state.escalated_total = clampInt(Number(state.escalated_total || 0) + escalatedCount, 0, 1_000_000_000, 0);
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'proactive_t1_tick',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    objective_id: policy.objective_id,
    source,
    selected: selected.length,
    generated: generated.length,
    queue_remainder: remainder.length,
    executed_count: executedCount,
    escalated_count: escalatedCount,
    outcomes
  };
  persistLatest(policy, out);
  return out;
}

function status(policy: AnyObj) {
  const state = loadState(policy);
  const latest = readJson(policy.state.latest_path, null);
  const queue = readJsonl(policy.state.queue_path);
  return {
    ok: true,
    type: 'proactive_t1_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      objective_id: policy.objective_id,
      auto_execute_risk_tiers: policy.auto_execute_risk_tiers
    },
    state,
    queue_depth: queue.length,
    latest: latest && typeof latest === 'object'
      ? {
        type: cleanText(latest.type || '', 80) || null,
        ts: cleanText(latest.ts || '', 60) || null,
        executed_count: clampInt(latest.executed_count, 0, 100000, 0),
        escalated_count: clampInt(latest.escalated_count, 0, 100000, 0)
      }
      : null,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state.state_path),
      queue_path: rel(policy.state.queue_path),
      latest_path: rel(policy.state.latest_path),
      receipts_path: rel(policy.state.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/proactive_t1_initiative_engine.js enqueue --initiative-json="{...}"');
  console.log('  node systems/autonomy/proactive_t1_initiative_engine.js tick [--context-json="{...}"] [--source=<id>] [--apply=0|1]');
  console.log('  node systems/autonomy/proactive_t1_initiative_engine.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  let out: AnyObj;
  if (!policy.enabled) {
    out = { ok: false, type: 'proactive_t1_initiative_engine', ts: nowIso(), error: 'policy_disabled' };
  } else if (cmd === 'enqueue') {
    out = enqueue(policy, args);
  } else if (cmd === 'tick') {
    out = tick(policy, args);
  } else if (cmd === 'status') {
    out = status(policy);
  } else if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  } else {
    out = { ok: false, type: 'proactive_t1_initiative_engine', ts: nowIso(), error: `unknown_command:${cmd}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  enqueue,
  tick,
  status
};
