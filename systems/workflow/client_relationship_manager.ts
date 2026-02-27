#!/usr/bin/env node
'use strict';
export {};

/**
 * client_relationship_manager.js
 *
 * V3-BRG-001: governed client relationship manager lane.
 *
 * Usage:
 *   node systems/workflow/client_relationship_manager.js case-open --client-id=<id> [--channel=email] [--tier=standard]
 *   node systems/workflow/client_relationship_manager.js event --case-id=<id> --type=<negotiation|scope_change|dispute|repeat_business> --handled-by=<auto|human> [--workflow-id=<id>]
 *   node systems/workflow/client_relationship_manager.js evaluate [--days=30] [--strict=1|0]
 *   node systems/workflow/client_relationship_manager.js status [--days=30]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.CLIENT_RELATIONSHIP_MANAGER_POLICY_PATH
  ? path.resolve(String(process.env.CLIENT_RELATIONSHIP_MANAGER_POLICY_PATH))
  : path.join(ROOT, 'config', 'client_relationship_manager_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
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
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
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

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    qualified_case_tiers: ['standard', 'high', 'strategic'],
    event_types: ['negotiation', 'scope_change', 'dispute', 'repeat_business'],
    require_workflow_ref_for_auto: true,
    manual_intervention_target: 0.05,
    sla_hours_by_type: {
      negotiation: 24,
      scope_change: 12,
      dispute: 4,
      repeat_business: 24
    },
    state_path: 'state/workflow/client_relationship_manager/state.json',
    latest_path: 'state/workflow/client_relationship_manager/latest.json',
    receipts_path: 'state/workflow/client_relationship_manager/receipts.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const rootPath = (v: unknown, fallback: string) => {
    const text = clean(v || fallback, 320);
    return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
  };
  const eventTypes = Array.isArray(raw.event_types) ? raw.event_types : base.event_types;
  const tiers = Array.isArray(raw.qualified_case_tiers) ? raw.qualified_case_tiers : base.qualified_case_tiers;
  const slaRaw = raw.sla_hours_by_type && typeof raw.sla_hours_by_type === 'object'
    ? raw.sla_hours_by_type
    : base.sla_hours_by_type;
  const sla: Record<string, number> = {};
  for (const t of eventTypes) {
    const id = normalizeToken(t, 80);
    if (!id) continue;
    sla[id] = clampNum((slaRaw as AnyObj)[id], 1, 720, (base.sla_hours_by_type as AnyObj)[id] || 24);
  }
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    qualified_case_tiers: Array.from(new Set(tiers.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean))),
    event_types: Array.from(new Set(eventTypes.map((v: unknown) => normalizeToken(v, 80)).filter(Boolean))),
    require_workflow_ref_for_auto: toBool(raw.require_workflow_ref_for_auto, base.require_workflow_ref_for_auto),
    manual_intervention_target: clampNum(raw.manual_intervention_target, 0, 1, base.manual_intervention_target),
    sla_hours_by_type: sla,
    state_path: rootPath(raw.state_path, base.state_path),
    latest_path: rootPath(raw.latest_path, base.latest_path),
    receipts_path: rootPath(raw.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'client_relationship_manager_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    cases: {},
    events: []
  };
}

function loadState(policy: AnyObj) {
  const state = readJson(policy.state_path, defaultState());
  return {
    schema_id: 'client_relationship_manager_state',
    schema_version: '1.0',
    updated_at: clean(state.updated_at || nowIso(), 40) || nowIso(),
    cases: state.cases && typeof state.cases === 'object' ? state.cases : {},
    events: Array.isArray(state.events) ? state.events : []
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state_path, {
    ...state,
    updated_at: nowIso()
  });
}

function hoursBetween(aIso: string, bIso: string) {
  const a = Date.parse(clean(aIso, 40));
  const b = Date.parse(clean(bIso, 40));
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Number(((b - a) / (1000 * 60 * 60)).toFixed(3));
}

function cmdCaseOpen(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'client_relationship_case_open', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const clientId = normalizeToken(args['client-id'] || args.client_id || '', 120);
  if (!clientId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'client_relationship_case_open', error: 'client_id_required' })}\n`);
    process.exit(1);
  }
  const caseId = normalizeToken(args['case-id'] || args.case_id || `${clientId}_${Date.now()}`, 160);
  const channel = normalizeToken(args.channel || 'email', 80) || 'email';
  const tier = normalizeToken(args.tier || 'standard', 80) || 'standard';
  const state = loadState(policy);
  state.cases[caseId] = {
    case_id: caseId,
    client_id: clientId,
    channel,
    tier,
    opened_at: nowIso(),
    status: 'open'
  };
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'client_relationship_case_open',
    ts: nowIso(),
    case: state.cases[caseId],
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function cmdEvent(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const caseId = normalizeToken(args['case-id'] || args.case_id || '', 160);
  const type = normalizeToken(args.type || '', 80);
  const handledBy = normalizeToken(args['handled-by'] || args.handled_by || 'auto', 40);
  const workflowId = clean(args['workflow-id'] || args.workflow_id || '', 160);
  if (!caseId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'client_relationship_event', error: 'case_id_required' })}\n`);
    process.exit(1);
  }
  if (!policy.event_types.includes(type)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'client_relationship_event', error: 'invalid_event_type', event_type: type, allowed: policy.event_types })}\n`);
    process.exit(1);
  }
  if (!['auto', 'human'].includes(handledBy)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'client_relationship_event', error: 'invalid_handled_by', handled_by: handledBy })}\n`);
    process.exit(1);
  }
  if (handledBy === 'auto' && policy.require_workflow_ref_for_auto && !workflowId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'client_relationship_event', error: 'workflow_id_required_for_auto' })}\n`);
    process.exit(1);
  }
  const state = loadState(policy);
  const rowCase = state.cases[caseId];
  if (!rowCase) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'client_relationship_event', error: 'case_not_found', case_id: caseId })}\n`);
    process.exit(1);
  }
  const eventTs = nowIso();
  const elapsedH = hoursBetween(rowCase.opened_at, eventTs);
  const slaHours = Number(policy.sla_hours_by_type[type] || 24);
  const slaMet = elapsedH == null ? false : elapsedH <= slaHours;
  const event = {
    event_id: `${caseId}_${type}_${Date.now()}`,
    case_id: caseId,
    client_id: rowCase.client_id,
    tier: rowCase.tier,
    event_type: type,
    handled_by: handledBy,
    workflow_id: workflowId || null,
    ts: eventTs,
    elapsed_h: elapsedH,
    sla_hours: slaHours,
    sla_met: slaMet
  };
  state.events.push(event);
  state.cases[caseId].status = type === 'repeat_business' ? 'renewed' : rowCase.status;
  state.cases[caseId].last_event_at = eventTs;
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'client_relationship_event',
    ts: nowIso(),
    event,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function evaluateWindow(policy: AnyObj, days: number) {
  const state = loadState(policy);
  const cutoffMs = Date.now() - (days * 24 * 60 * 60 * 1000);
  const events = state.events.filter((row: AnyObj) => {
    const ts = Date.parse(clean(row.ts || '', 40));
    return Number.isFinite(ts) && ts >= cutoffMs;
  });
  const qualified = events.filter((row: AnyObj) => policy.qualified_case_tiers.includes(normalizeToken(row.tier || '', 80)));
  const manualCount = qualified.filter((row: AnyObj) => normalizeToken(row.handled_by || '', 40) === 'human').length;
  const autoCount = qualified.filter((row: AnyObj) => normalizeToken(row.handled_by || '', 40) === 'auto').length;
  const total = qualified.length;
  const manualRate = total > 0 ? Number((manualCount / total).toFixed(4)) : 0;
  const slaMet = qualified.filter((row: AnyObj) => row.sla_met === true).length;
  const slaRate = total > 0 ? Number((slaMet / total).toFixed(4)) : 1;
  const byType: Record<string, AnyObj> = {};
  for (const type of policy.event_types) {
    const subset = qualified.filter((row: AnyObj) => normalizeToken(row.event_type || '', 80) === type);
    const subsetSla = subset.filter((row: AnyObj) => row.sla_met === true).length;
    byType[type] = {
      count: subset.length,
      sla_rate: subset.length ? Number((subsetSla / subset.length).toFixed(4)) : 1
    };
  }
  return {
    total_events: events.length,
    qualified_events: total,
    auto_events: autoCount,
    manual_events: manualCount,
    manual_rate: manualRate,
    manual_target: policy.manual_intervention_target,
    manual_target_ok: manualRate <= policy.manual_intervention_target,
    sla_rate: slaRate,
    by_type: byType
  };
}

function cmdEvaluate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = toBool(args.strict, policy.strict_default === true);
  const days = clampInt(args.days, 1, 365, 30);
  const metrics = evaluateWindow(policy, days);
  const out = {
    ok: metrics.manual_target_ok,
    type: 'client_relationship_evaluate',
    ts: nowIso(),
    days,
    metrics,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const days = clampInt(args.days, 1, 365, 30);
  const state = loadState(policy);
  const metrics = evaluateWindow(policy, days);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'client_relationship_status',
    ts: nowIso(),
    open_cases: Object.values(state.cases).filter((row: AnyObj) => normalizeToken(row.status || '', 40) === 'open').length,
    total_cases: Object.keys(state.cases).length,
    days,
    metrics,
    policy: {
      path: rel(policy.policy_path),
      event_types: policy.event_types,
      qualified_case_tiers: policy.qualified_case_tiers,
      manual_intervention_target: policy.manual_intervention_target
    },
    paths: {
      state_path: rel(policy.state_path),
      latest_path: rel(policy.latest_path),
      receipts_path: rel(policy.receipts_path)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/client_relationship_manager.js case-open --client-id=<id> [--channel=email] [--tier=standard]');
  console.log('  node systems/workflow/client_relationship_manager.js event --case-id=<id> --type=<negotiation|scope_change|dispute|repeat_business> --handled-by=<auto|human> [--workflow-id=<id>]');
  console.log('  node systems/workflow/client_relationship_manager.js evaluate [--days=30] [--strict=1|0]');
  console.log('  node systems/workflow/client_relationship_manager.js status [--days=30]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'case-open') return cmdCaseOpen(args);
  if (cmd === 'event') return cmdEvent(args);
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
