#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(REPO_ROOT, 'config', 'subsumption_adapter_policy.json');
const DEFAULT_STATE_PATH = path.join(REPO_ROOT, 'state', 'eye', 'subsumption_registry_state.json');
const DEFAULT_AUDIT_PATH = path.join(REPO_ROOT, 'state', 'eye', 'audit', 'subsumption_registry.jsonl');
const DEFAULT_LATEST_PATH = path.join(REPO_ROOT, 'state', 'eye', 'subsumption_latest.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/eye/subsumption_registry.js register --provider=<id> [--adapter=<id>] [--trust=0..1] [--daily-tokens=N] [--enabled=1|0] [--min-trust=0..1] [--apply=1|0]');
  console.log('  node systems/eye/subsumption_registry.js evaluate --provider=<id> [--estimated-tokens=N] [--risk=low|medium|high|critical] [--apply=1|0]');
  console.log('  node systems/eye/subsumption_registry.js disable --provider=<id> --approval-note=<note> [--reason=<text>] [--apply=1|0]');
  console.log('  node systems/eye/subsumption_registry.js enable --provider=<id> --approval-note=<note> [--apply=1|0]');
  console.log('  node systems/eye/subsumption_registry.js status');
}

function nowIso() {
  return new Date().toISOString();
}

function dateStr(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    min_trust_allow: 0.7,
    min_trust_escalate: 0.45,
    global_daily_tokens: 32000,
    providers: {
      openai: { enabled: true, adapter: 'openai.v1', trust_score: 0.82, min_trust: 0.72, daily_tokens: 10000 },
      anthropic: { enabled: true, adapter: 'anthropic.v1', trust_score: 0.8, min_trust: 0.72, daily_tokens: 9000 },
      google: { enabled: true, adapter: 'google.v1', trust_score: 0.78, min_trust: 0.72, daily_tokens: 8000 },
      ollama: { enabled: true, adapter: 'ollama.local', trust_score: 0.75, min_trust: 0.68, daily_tokens: 12000 }
    }
  };
}

function normalizeProviderEntry(raw: AnyObj, fallback: AnyObj) {
  const base = fallback && typeof fallback === 'object' ? fallback : {};
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: src.enabled !== false,
    adapter: cleanText(src.adapter || base.adapter || '', 120) || null,
    trust_score: clampNumber(src.trust_score, 0, 1, Number(base.trust_score || 0.5)),
    min_trust: clampNumber(src.min_trust, 0, 1, Number(base.min_trust || 0.5)),
    daily_tokens: clampInt(src.daily_tokens, 0, 10_000_000, Number(base.daily_tokens || 0)),
    disabled_at: src.disabled_at ? String(src.disabled_at) : null,
    disabled_reason: src.disabled_reason ? cleanText(src.disabled_reason, 220) : null
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const providerNames = Array.from(new Set([
    ...Object.keys(base.providers || {}),
    ...Object.keys(raw.providers && typeof raw.providers === 'object' ? raw.providers : {})
  ]));
  const providers: AnyObj = {};
  for (const name of providerNames) {
    providers[name] = normalizeProviderEntry(
      raw.providers && raw.providers[name] ? raw.providers[name] : {},
      base.providers && base.providers[name] ? base.providers[name] : {}
    );
  }
  return {
    version: cleanText(raw.version || base.version, 40) || '1.0',
    min_trust_allow: clampNumber(raw.min_trust_allow, 0, 1, base.min_trust_allow),
    min_trust_escalate: clampNumber(raw.min_trust_escalate, 0, 1, base.min_trust_escalate),
    global_daily_tokens: clampInt(raw.global_daily_tokens, 0, 10_000_000, base.global_daily_tokens),
    providers
  };
}

function defaultState() {
  return {
    schema_id: 'subsumption_registry_state',
    schema_version: '1.0',
    updated_at: null,
    providers: {},
    days: {}
  };
}

function loadState(statePath: string, policy: AnyObj) {
  const raw = readJson(statePath, defaultState());
  const out: AnyObj = {
    schema_id: 'subsumption_registry_state',
    schema_version: '1.0',
    updated_at: raw.updated_at ? String(raw.updated_at) : null,
    providers: raw.providers && typeof raw.providers === 'object' ? raw.providers : {},
    days: raw.days && typeof raw.days === 'object' ? raw.days : {}
  };
  for (const provider of Object.keys(policy && policy.providers ? policy.providers : {})) {
    if (!out.providers[provider] || typeof out.providers[provider] !== 'object') {
      out.providers[provider] = normalizeProviderEntry(policy.providers[provider], policy.providers[provider]);
    } else {
      out.providers[provider] = normalizeProviderEntry(out.providers[provider], policy.providers[provider]);
    }
  }
  return out;
}

function ensureDayState(state: AnyObj, policy: AnyObj, day: string) {
  if (!state.days || typeof state.days !== 'object') state.days = {};
  if (!state.days[day] || typeof state.days[day] !== 'object') {
    state.days[day] = {
      global_tokens_used: 0,
      providers: {}
    };
  }
  const dayState = state.days[day];
  if (!dayState.providers || typeof dayState.providers !== 'object') dayState.providers = {};
  for (const provider of Object.keys(policy && policy.providers ? policy.providers : {})) {
    if (!dayState.providers[provider] || typeof dayState.providers[provider] !== 'object') {
      dayState.providers[provider] = {
        requests: 0,
        allow: 0,
        deny: 0,
        escalate: 0,
        tokens_used: 0
      };
    }
  }
  return dayState;
}

function resolveProvider(state: AnyObj, policy: AnyObj, provider: string) {
  const key = String(provider || '').trim().toLowerCase();
  if (!key) return { key: null, entry: null };
  const stateEntry = state.providers && state.providers[key] ? state.providers[key] : null;
  const policyEntry = policy.providers && policy.providers[key] ? policy.providers[key] : null;
  if (!stateEntry && !policyEntry) return { key, entry: null };
  const entry = normalizeProviderEntry(stateEntry || policyEntry, policyEntry || stateEntry);
  return { key, entry };
}

function evaluateProviderRoute(request: AnyObj, state: AnyObj, policy: AnyObj, opts: AnyObj = {}) {
  const providerKey = String(request.provider || '').trim().toLowerCase();
  const apply = opts.apply === true;
  const day = dateStr(opts.date || nowIso());
  const estimatedTokens = clampInt(request.estimated_tokens, 0, 10_000_000, 0);
  const risk = String(request.risk || 'low').trim().toLowerCase();
  const reasons: string[] = [];

  const resolved = resolveProvider(state, policy, providerKey);
  if (!providerKey) reasons.push('provider_required');
  if (!resolved.entry) reasons.push('provider_unknown');
  const entry = resolved.entry;

  if (entry && entry.enabled !== true) reasons.push('provider_disabled');
  if (risk === 'high' || risk === 'critical') reasons.push('risk_denied');

  const dayState = ensureDayState(state, policy, day);
  const providerUsage = dayState.providers && dayState.providers[providerKey]
    ? dayState.providers[providerKey]
    : { requests: 0, allow: 0, deny: 0, escalate: 0, tokens_used: 0 };

  if (entry && entry.daily_tokens > 0 && (Number(providerUsage.tokens_used || 0) + estimatedTokens) > Number(entry.daily_tokens || 0)) {
    reasons.push('provider_daily_budget_exceeded');
  }
  if (Number(policy.global_daily_tokens || 0) > 0 && (Number(dayState.global_tokens_used || 0) + estimatedTokens) > Number(policy.global_daily_tokens || 0)) {
    reasons.push('global_daily_budget_exceeded');
  }

  let decision = 'allow';
  if (reasons.length) decision = 'deny';
  else if (entry) {
    const allowFloor = Math.max(Number(policy.min_trust_allow || 0.7), Number(entry.min_trust || 0.5));
    const escalateFloor = Number(policy.min_trust_escalate || 0.45);
    if (entry.trust_score < escalateFloor) {
      decision = 'deny';
      reasons.push('trust_below_floor');
    } else if (entry.trust_score < allowFloor) {
      decision = 'escalate';
      reasons.push('trust_requires_escalation');
    }
  }

  if (apply && providerKey && entry) {
    dayState.providers[providerKey] = providerUsage;
    providerUsage.requests = Number(providerUsage.requests || 0) + 1;
    providerUsage[decision] = Number(providerUsage[decision] || 0) + 1;
    if (decision === 'allow') {
      providerUsage.tokens_used = Number(providerUsage.tokens_used || 0) + estimatedTokens;
      dayState.global_tokens_used = Number(dayState.global_tokens_used || 0) + estimatedTokens;
    }
    state.updated_at = nowIso();
  }

  return {
    provider: providerKey,
    entry,
    decision,
    reasons: Array.from(new Set(reasons)),
    estimated_tokens: estimatedTokens,
    risk,
    day,
    day_state: dayState
  };
}

function emitReceipt(filePath: string, latestPath: string, row: AnyObj) {
  appendJsonl(filePath, row);
  writeJsonAtomic(latestPath, row);
}

function cmdRegister(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(args.state || DEFAULT_STATE_PATH));
  const auditPath = path.resolve(String(args.audit || DEFAULT_AUDIT_PATH));
  const latestPath = path.resolve(String(args.latest || DEFAULT_LATEST_PATH));
  const apply = boolFlag(args.apply, true);

  const policy = loadPolicy(policyPath);
  const state = loadState(statePath, policy);
  const provider = String(args.provider || '').trim().toLowerCase();
  if (!provider) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'provider_required' })}\n`);
    process.exit(1);
  }

  const current = resolveProvider(state, policy, provider).entry || normalizeProviderEntry({}, {});
  const next = normalizeProviderEntry({
    ...current,
    adapter: args.adapter != null ? args.adapter : current.adapter,
    trust_score: args.trust != null ? args.trust : current.trust_score,
    min_trust: args['min-trust'] != null ? args['min-trust'] : current.min_trust,
    daily_tokens: args['daily-tokens'] != null ? args['daily-tokens'] : current.daily_tokens,
    enabled: args.enabled != null ? boolFlag(args.enabled, true) : current.enabled
  }, current);

  if (apply) {
    state.providers[provider] = next;
    state.updated_at = nowIso();
    writeJsonAtomic(statePath, state);
  }

  const row = {
    ts: nowIso(),
    type: 'subsumption_provider_register',
    provider,
    adapter: next.adapter,
    trust_score: next.trust_score,
    min_trust: next.min_trust,
    daily_tokens: next.daily_tokens,
    enabled: next.enabled,
    apply
  };
  emitReceipt(auditPath, latestPath, row);
  process.stdout.write(`${JSON.stringify({ ok: true, type: row.type, provider, entry: next, apply, state_path: statePath })}\n`);
}

function cmdEvaluate(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(args.state || DEFAULT_STATE_PATH));
  const auditPath = path.resolve(String(args.audit || DEFAULT_AUDIT_PATH));
  const latestPath = path.resolve(String(args.latest || DEFAULT_LATEST_PATH));
  const apply = boolFlag(args.apply, true);
  const policy = loadPolicy(policyPath);
  const state = loadState(statePath, policy);
  const evaluated = evaluateProviderRoute({
    provider: args.provider,
    estimated_tokens: args['estimated-tokens'] || args.estimated_tokens,
    risk: args.risk || 'low'
  }, state, policy, {
    apply,
    date: args.date
  });

  if (apply) writeJsonAtomic(statePath, state);
  const row = {
    ts: nowIso(),
    type: 'subsumption_provider_evaluate',
    provider: evaluated.provider,
    decision: evaluated.decision,
    reasons: evaluated.reasons,
    estimated_tokens: evaluated.estimated_tokens,
    risk: evaluated.risk,
    trust_score: evaluated.entry ? evaluated.entry.trust_score : null,
    day: evaluated.day,
    apply
  };
  emitReceipt(auditPath, latestPath, row);
  const out = {
    ok: evaluated.decision !== 'deny',
    type: row.type,
    provider: evaluated.provider,
    decision: evaluated.decision,
    reasons: evaluated.reasons,
    estimated_tokens: evaluated.estimated_tokens,
    risk: evaluated.risk,
    trust_score: evaluated.entry ? evaluated.entry.trust_score : null,
    apply,
    day: evaluated.day
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(evaluated.decision === 'deny' ? 1 : 0);
}

function cmdSetEnabled(args: AnyObj, enabled: boolean) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(args.state || DEFAULT_STATE_PATH));
  const auditPath = path.resolve(String(args.audit || DEFAULT_AUDIT_PATH));
  const latestPath = path.resolve(String(args.latest || DEFAULT_LATEST_PATH));
  const apply = boolFlag(args.apply, true);
  const provider = String(args.provider || '').trim().toLowerCase();
  const approvalNote = cleanText(args['approval-note'] || args.approval_note, 220);
  if (!provider) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'provider_required' })}\n`);
    process.exit(1);
  }
  if (!approvalNote) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'approval_note_required' })}\n`);
    process.exit(1);
  }

  const policy = loadPolicy(policyPath);
  const state = loadState(statePath, policy);
  const resolved = resolveProvider(state, policy, provider);
  if (!resolved.entry) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'provider_unknown', provider })}\n`);
    process.exit(1);
  }
  const next = {
    ...resolved.entry,
    enabled,
    disabled_at: enabled ? null : nowIso(),
    disabled_reason: enabled ? null : cleanText(args.reason || 'manual_disable', 220)
  };
  if (apply) {
    state.providers[provider] = next;
    state.updated_at = nowIso();
    writeJsonAtomic(statePath, state);
  }
  const row = {
    ts: nowIso(),
    type: enabled ? 'subsumption_provider_enable' : 'subsumption_provider_disable',
    provider,
    enabled,
    reason: enabled ? null : next.disabled_reason,
    approval_note: approvalNote,
    apply
  };
  emitReceipt(auditPath, latestPath, row);
  process.stdout.write(`${JSON.stringify({ ok: true, type: row.type, provider, enabled, apply })}\n`);
}

function cmdStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const statePath = path.resolve(String(args.state || DEFAULT_STATE_PATH));
  const policy = loadPolicy(policyPath);
  const state = loadState(statePath, policy);
  const day = dateStr(args.date || nowIso());
  const dayState = ensureDayState(state, policy, day);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'subsumption_registry_status',
    policy_path: policyPath,
    state_path: statePath,
    policy_version: policy.version,
    day,
    providers: state.providers,
    day_state: dayState
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }
  if (cmd === 'register') return cmdRegister(args);
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'disable') return cmdSetEnabled(args, false);
  if (cmd === 'enable') return cmdSetEnabled(args, true);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'subsumption_registry',
      error: String(err && err.message ? err.message : err || 'subsumption_registry_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  loadState,
  evaluateProviderRoute,
  main
};

