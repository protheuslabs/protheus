#!/usr/bin/env node
'use strict';
export {};

/**
 * disposable_infrastructure_organ.js
 *
 * V3-ACT-001 scaffold:
 * - Shadow-first disposable account/proxy/session pooling.
 * - Compliance/risk-aware routing hints for outreach actuation.
 * - Deterministic receipts with reversible session lifecycle.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DISPOSABLE_INFRASTRUCTURE_POLICY_PATH
  ? path.resolve(process.env.DISPOSABLE_INFRASTRUCTURE_POLICY_PATH)
  : path.join(ROOT, 'config', 'disposable_infrastructure_organ_policy.json');
const SOUL_GUARD_SCRIPT = path.join(ROOT, 'systems', 'security', 'soul_token_guard.js');

function nowIso() {
  return new Date().toISOString();
}

function dayStr(ts = nowIso()) {
  return String(ts || '').slice(0, 10);
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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function parseJsonOutput(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {}
    }
  }
  return null;
}

function runNodeJson(scriptPath: string, args: string[], timeoutMs = 2500) {
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

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 420);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function stableStringify(value: unknown): string {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  const obj = value as AnyObj;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function sha12(value: unknown) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex').slice(0, 12);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    compliance: {
      enforce_can_spam: true,
      enforce_opt_out_footer: true,
      enforce_identity_disclosure: true,
      default_jurisdiction: 'us',
      do_not_contact_path: 'state/compliance/do_not_contact.json'
    },
    risk: {
      max_daily_sends_per_account: 40,
      rotate_on_bounce_rate: 0.08,
      rotate_on_block_score: 0.7,
      min_reputation_for_send: 0.45
    },
    autonomous_execution: {
      enabled: true,
      high_risk_min_approval_note_chars: 12,
      default_cost_usd: 8,
      default_liability_score: 0.35,
      threshold_usd: {
        low: 100,
        medium: 1000
      },
      liability_threshold: {
        low: 0.2,
        medium: 0.55
      }
    },
    pools: {
      accounts: {
        max_active: 48,
        providers_allowed: ['gmail', 'outlook', 'fastmail', 'proton'],
        warmup_days_min: 7
      },
      proxies: {
        max_active: 128,
        providers_allowed: ['residential_pool', 'mobile_pool']
      }
    },
    state: {
      state_path: 'state/actuation/disposable_infrastructure_organ/state.json',
      latest_path: 'state/actuation/disposable_infrastructure_organ/latest.json',
      receipts_path: 'state/actuation/disposable_infrastructure_organ/receipts.jsonl',
      sessions_path: 'state/actuation/disposable_infrastructure_organ/sessions.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const compliance = raw.compliance && typeof raw.compliance === 'object' ? raw.compliance : {};
  const risk = raw.risk && typeof raw.risk === 'object' ? raw.risk : {};
  const autoExec = raw.autonomous_execution && typeof raw.autonomous_execution === 'object'
    ? raw.autonomous_execution
    : {};
  const thresholdUsd = autoExec.threshold_usd && typeof autoExec.threshold_usd === 'object'
    ? autoExec.threshold_usd
    : {};
  const liabilityThreshold = autoExec.liability_threshold && typeof autoExec.liability_threshold === 'object'
    ? autoExec.liability_threshold
    : {};
  const pools = raw.pools && typeof raw.pools === 'object' ? raw.pools : {};
  const accounts = pools.accounts && typeof pools.accounts === 'object' ? pools.accounts : {};
  const proxies = pools.proxies && typeof pools.proxies === 'object' ? pools.proxies : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    compliance: {
      enforce_can_spam: compliance.enforce_can_spam !== false,
      enforce_opt_out_footer: compliance.enforce_opt_out_footer !== false,
      enforce_identity_disclosure: compliance.enforce_identity_disclosure !== false,
      default_jurisdiction: normalizeToken(compliance.default_jurisdiction || base.compliance.default_jurisdiction, 24) || base.compliance.default_jurisdiction,
      do_not_contact_path: resolvePath(compliance.do_not_contact_path || base.compliance.do_not_contact_path, base.compliance.do_not_contact_path)
    },
    risk: {
      max_daily_sends_per_account: clampInt(risk.max_daily_sends_per_account, 1, 10000, base.risk.max_daily_sends_per_account),
      rotate_on_bounce_rate: clampNumber(risk.rotate_on_bounce_rate, 0, 1, base.risk.rotate_on_bounce_rate),
      rotate_on_block_score: clampNumber(risk.rotate_on_block_score, 0, 1, base.risk.rotate_on_block_score),
      min_reputation_for_send: clampNumber(risk.min_reputation_for_send, 0, 1, base.risk.min_reputation_for_send)
    },
    autonomous_execution: {
      enabled: autoExec.enabled !== false,
      high_risk_min_approval_note_chars: clampInt(
        autoExec.high_risk_min_approval_note_chars,
        1,
        200,
        base.autonomous_execution.high_risk_min_approval_note_chars
      ),
      default_cost_usd: clampNumber(
        autoExec.default_cost_usd,
        0,
        1000000,
        base.autonomous_execution.default_cost_usd
      ),
      default_liability_score: clampNumber(
        autoExec.default_liability_score,
        0,
        1,
        base.autonomous_execution.default_liability_score
      ),
      threshold_usd: {
        low: clampNumber(thresholdUsd.low, 0, 1000000, base.autonomous_execution.threshold_usd.low),
        medium: clampNumber(thresholdUsd.medium, 0, 10000000, base.autonomous_execution.threshold_usd.medium)
      },
      liability_threshold: {
        low: clampNumber(
          liabilityThreshold.low,
          0,
          1,
          base.autonomous_execution.liability_threshold.low
        ),
        medium: clampNumber(
          liabilityThreshold.medium,
          0,
          1,
          base.autonomous_execution.liability_threshold.medium
        )
      }
    },
    pools: {
      accounts: {
        max_active: clampInt(accounts.max_active, 1, 100000, base.pools.accounts.max_active),
        providers_allowed: Array.from(new Set(
          (Array.isArray(accounts.providers_allowed) ? accounts.providers_allowed : base.pools.accounts.providers_allowed)
            .map((row: unknown) => normalizeToken(row, 80))
            .filter(Boolean)
        )),
        warmup_days_min: clampInt(accounts.warmup_days_min, 0, 3650, base.pools.accounts.warmup_days_min)
      },
      proxies: {
        max_active: clampInt(proxies.max_active, 1, 100000, base.pools.proxies.max_active),
        providers_allowed: Array.from(new Set(
          (Array.isArray(proxies.providers_allowed) ? proxies.providers_allowed : base.pools.proxies.providers_allowed)
            .map((row: unknown) => normalizeToken(row, 80))
            .filter(Boolean)
        ))
      }
    },
    state: {
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      sessions_path: resolvePath(state.sessions_path || base.state.sessions_path, base.state.sessions_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'disposable_infrastructure_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    accounts: {},
    proxies: {},
    sessions: {},
    metrics: {
      sessions_total: 0,
      sessions_released: 0,
      rotations_recommended: 0
    }
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') return defaultState();
  const metricsRaw = src.metrics && typeof src.metrics === 'object' ? src.metrics : {};
  return {
    schema_id: 'disposable_infrastructure_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60) || nowIso(),
    accounts: src.accounts && typeof src.accounts === 'object' ? src.accounts : {},
    proxies: src.proxies && typeof src.proxies === 'object' ? src.proxies : {},
    sessions: src.sessions && typeof src.sessions === 'object' ? src.sessions : {},
    metrics: {
      sessions_total: clampInt(metricsRaw.sessions_total, 0, 1_000_000_000, 0),
      sessions_released: clampInt(metricsRaw.sessions_released, 0, 1_000_000_000, 0),
      rotations_recommended: clampInt(metricsRaw.rotations_recommended, 0, 1_000_000_000, 0)
    }
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'disposable_infrastructure_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    accounts: state.accounts && typeof state.accounts === 'object' ? state.accounts : {},
    proxies: state.proxies && typeof state.proxies === 'object' ? state.proxies : {},
    sessions: state.sessions && typeof state.sessions === 'object' ? state.sessions : {},
    metrics: state.metrics && typeof state.metrics === 'object' ? state.metrics : defaultState().metrics
  });
}

function persistLatest(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.state.latest_path, row);
  appendJsonl(policy.state.receipts_path, row);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/disposable_infrastructure_organ.js register-account --account-id=<id> --provider=<provider> [--warmup-days=<n>] [--reputation=<0..1>] [--apply=0|1]');
  console.log('  node systems/actuation/disposable_infrastructure_organ.js register-proxy --proxy-id=<id> --provider=<provider> [--region=<id>] [--quality-score=<0..1>] [--apply=0|1]');
  console.log('  node systems/actuation/disposable_infrastructure_organ.js acquire-session --task-id=<id> [--risk-class=<low|medium|high>] [--estimated-cost-usd=<n>] [--liability-score=<0..1>] [--approval-note="..."] [--apply=0|1]');
  console.log('  node systems/actuation/disposable_infrastructure_organ.js report-deliverability --session-id=<id> --bounce-rate=<0..1> --block-score=<0..1> [--apply=0|1]');
  console.log('  node systems/actuation/disposable_infrastructure_organ.js release-session --session-id=<id> [--reason=<text>] [--apply=0|1]');
  console.log('  node systems/actuation/disposable_infrastructure_organ.js status');
}

function gateApply(policy: AnyObj, applyRequested: boolean) {
  const reasonCodes: string[] = [];
  let applyAllowed = applyRequested;
  if (policy.shadow_only === true && applyRequested) {
    reasonCodes.push('shadow_only_mode');
    applyAllowed = false;
  }
  return { apply_requested: applyRequested, apply_allowed: applyAllowed, reason_codes: reasonCodes };
}

function isProviderAllowed(provider: string, allowlist: string[]) {
  if (!allowlist.length) return true;
  return allowlist.includes(provider);
}

function countActive(rows: AnyObj) {
  return Object.values(rows || {}).filter((row: any) => row && row.status !== 'retired' && row.status !== 'quarantined').length;
}

function ensureAccountDailyCounter(account: AnyObj, today: string) {
  if (String(account.send_day || '') !== today) {
    account.send_day = today;
    account.sends_today = 0;
  }
  account.sends_today = clampInt(account.sends_today, 0, 100000, 0);
}

function cmdRegisterAccount(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const accountId = normalizeToken(args['account-id'] || args.account_id || '', 160);
  const provider = normalizeToken(args.provider || '', 80);
  if (!accountId || !provider) {
    return { ok: false, type: 'disposable_infrastructure_register_account', ts: nowIso(), error: 'account_id_and_provider_required' };
  }
  if (!isProviderAllowed(provider, policy.pools.accounts.providers_allowed || [])) {
    return { ok: false, type: 'disposable_infrastructure_register_account', ts: nowIso(), error: 'provider_not_allowed', provider };
  }

  const warmupDays = clampInt(args['warmup-days'] || args.warmup_days, 0, 3650, 0);
  if (warmupDays < Number(policy.pools.accounts.warmup_days_min || 0)) {
    return {
      ok: false,
      type: 'disposable_infrastructure_register_account',
      ts: nowIso(),
      error: 'warmup_days_below_minimum',
      warmup_days: warmupDays,
      min_required: Number(policy.pools.accounts.warmup_days_min || 0)
    };
  }
  const existing = state.accounts[accountId];
  if (!existing && countActive(state.accounts) >= Number(policy.pools.accounts.max_active || 0)) {
    return { ok: false, type: 'disposable_infrastructure_register_account', ts: nowIso(), error: 'account_pool_capacity_reached' };
  }

  const applyGate = gateApply(policy, toBool(args.apply, false));
  const record = {
    account_id: accountId,
    provider,
    warmup_days: warmupDays,
    reputation: clampNumber(args.reputation, 0, 1, 0.6),
    status: applyGate.apply_allowed ? 'active' : 'shadow_active',
    created_at: existing && existing.created_at ? existing.created_at : nowIso(),
    updated_at: nowIso(),
    sends_today: existing ? clampInt(existing.sends_today, 0, 100000, 0) : 0,
    send_day: existing && existing.send_day ? String(existing.send_day) : dayStr(),
    last_rotation_recommendation_at: existing && existing.last_rotation_recommendation_at ? existing.last_rotation_recommendation_at : null
  };
  state.accounts[accountId] = record;
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'disposable_infrastructure_register_account',
    ts: nowIso(),
    ...applyGate,
    account: record
  };
  persistLatest(policy, out);
  return out;
}

function cmdRegisterProxy(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const proxyId = normalizeToken(args['proxy-id'] || args.proxy_id || '', 160);
  const provider = normalizeToken(args.provider || '', 80);
  if (!proxyId || !provider) {
    return { ok: false, type: 'disposable_infrastructure_register_proxy', ts: nowIso(), error: 'proxy_id_and_provider_required' };
  }
  if (!isProviderAllowed(provider, policy.pools.proxies.providers_allowed || [])) {
    return { ok: false, type: 'disposable_infrastructure_register_proxy', ts: nowIso(), error: 'provider_not_allowed', provider };
  }
  const existing = state.proxies[proxyId];
  if (!existing && countActive(state.proxies) >= Number(policy.pools.proxies.max_active || 0)) {
    return { ok: false, type: 'disposable_infrastructure_register_proxy', ts: nowIso(), error: 'proxy_pool_capacity_reached' };
  }

  const applyGate = gateApply(policy, toBool(args.apply, false));
  const record = {
    proxy_id: proxyId,
    provider,
    region: normalizeToken(args.region || 'global', 80) || 'global',
    quality_score: clampNumber(args['quality-score'] || args.quality_score, 0, 1, 0.65),
    status: applyGate.apply_allowed ? 'active' : 'shadow_active',
    created_at: existing && existing.created_at ? existing.created_at : nowIso(),
    updated_at: nowIso()
  };
  state.proxies[proxyId] = record;
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'disposable_infrastructure_register_proxy',
    ts: nowIso(),
    ...applyGate,
    proxy: record
  };
  persistLatest(policy, out);
  return out;
}

function chooseAccount(state: AnyObj, policy: AnyObj) {
  const today = dayStr();
  const rows = Object.values(state.accounts || {})
    .map((row: any) => row && typeof row === 'object' ? row : null)
    .filter(Boolean)
    .map((row: AnyObj) => {
      ensureAccountDailyCounter(row, today);
      return row;
    })
    .filter((row: AnyObj) => row.status !== 'quarantined' && row.status !== 'retired')
    .filter((row: AnyObj) => Number(row.reputation || 0) >= Number(policy.risk.min_reputation_for_send || 0))
    .filter((row: AnyObj) => Number(row.sends_today || 0) < Number(policy.risk.max_daily_sends_per_account || 0))
    .sort((a: AnyObj, b: AnyObj) => {
      const repDiff = Number(b.reputation || 0) - Number(a.reputation || 0);
      if (repDiff !== 0) return repDiff;
      const sendDiff = Number(a.sends_today || 0) - Number(b.sends_today || 0);
      if (sendDiff !== 0) return sendDiff;
      return String(a.account_id || '').localeCompare(String(b.account_id || ''));
    });
  return rows.length ? rows[0] : null;
}

function chooseProxy(state: AnyObj) {
  const rows = Object.values(state.proxies || {})
    .map((row: any) => row && typeof row === 'object' ? row : null)
    .filter(Boolean)
    .filter((row: AnyObj) => row.status !== 'quarantined' && row.status !== 'retired')
    .sort((a: AnyObj, b: AnyObj) => {
      const qualityDiff = Number(b.quality_score || 0) - Number(a.quality_score || 0);
      if (qualityDiff !== 0) return qualityDiff;
      return String(a.proxy_id || '').localeCompare(String(b.proxy_id || ''));
    });
  return rows.length ? rows[0] : null;
}

function inferSessionRiskTier(policy: AnyObj, args: AnyObj) {
  const cfg = policy.autonomous_execution && typeof policy.autonomous_execution === 'object'
    ? policy.autonomous_execution
    : defaultPolicy().autonomous_execution;
  const override = normalizeToken(args['risk-class'] || args.risk_class || args['risk-tier'] || args.risk_tier || '', 40);
  const estimatedCostUsd = clampNumber(
    args['estimated-cost-usd'] || args.estimated_cost_usd,
    0,
    1_000_000_000,
    cfg.default_cost_usd
  );
  const liabilityScore = clampNumber(
    args['liability-score'] || args.liability_score,
    0,
    1,
    cfg.default_liability_score
  );
  let riskTier = ['low', 'medium', 'high'].includes(override) ? override : '';
  if (!riskTier) {
    if (
      estimatedCostUsd <= Number(cfg.threshold_usd && cfg.threshold_usd.low || 100)
      && liabilityScore <= Number(cfg.liability_threshold && cfg.liability_threshold.low || 0.2)
    ) riskTier = 'low';
    else if (
      estimatedCostUsd <= Number(cfg.threshold_usd && cfg.threshold_usd.medium || 1000)
      && liabilityScore <= Number(cfg.liability_threshold && cfg.liability_threshold.medium || 0.55)
    ) riskTier = 'medium';
    else riskTier = 'high';
  }
  return {
    risk_tier: riskTier,
    estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
    liability_score: Number(liabilityScore.toFixed(6))
  };
}

function evaluateSessionAutonomy(policy: AnyObj, riskTier: string, args: AnyObj) {
  const cfg = policy.autonomous_execution && typeof policy.autonomous_execution === 'object'
    ? policy.autonomous_execution
    : defaultPolicy().autonomous_execution;
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 800);
  const reasonCodes: string[] = [];
  let mode = 'execute_and_report';
  let allowExecution = true;
  let soulVerified = false;
  if (riskTier === 'medium') {
    mode = 'shadow_then_auto_execute_unless_vetoed';
  } else if (riskTier === 'high') {
    mode = 'explicit_approval_required';
    allowExecution = false;
    if (approvalNote.length < Number(cfg.high_risk_min_approval_note_chars || 12)) {
      reasonCodes.push('high_risk_approval_note_required');
    } else {
      const soul = runNodeJson(SOUL_GUARD_SCRIPT, ['verify', '--strict=1'], 5000);
      soulVerified = soul.ok === true;
      if (!soulVerified) {
        reasonCodes.push(soul.timed_out ? 'soul_probe_timeout' : 'soul_gate_failed');
      } else {
        allowExecution = true;
      }
    }
  }
  if (policy.shadow_only === true && riskTier !== 'high') {
    reasonCodes.push('autonomous_tier_override_shadow');
  } else if (policy.shadow_only === true && riskTier === 'high') {
    reasonCodes.push('shadow_only_mode');
    allowExecution = false;
  }
  return {
    risk_tier: riskTier,
    execution_mode: mode,
    allow_execution: allowExecution,
    operator_prompt_required: riskTier === 'high',
    approval_note: approvalNote || null,
    soul_verified: soulVerified,
    reason_codes: reasonCodes
  };
}

function cmdAcquireSession(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const taskId = normalizeToken(args['task-id'] || args.task_id || '', 160);
  if (!taskId) return { ok: false, type: 'disposable_infrastructure_acquire_session', ts: nowIso(), error: 'task_id_required' };
  const account = chooseAccount(state, policy);
  if (!account) return { ok: false, type: 'disposable_infrastructure_acquire_session', ts: nowIso(), error: 'no_eligible_account' };
  const proxy = chooseProxy(state);
  if (!proxy) return { ok: false, type: 'disposable_infrastructure_acquire_session', ts: nowIso(), error: 'no_eligible_proxy' };
  const riskProfile = inferSessionRiskTier(policy, args);
  const autonomy = evaluateSessionAutonomy(policy, riskProfile.risk_tier, args);
  const applyGate = gateApply(policy, toBool(args.apply, false));
  const applyAllowed = autonomy.allow_execution === true;
  const sessionId = `ds_${sha12({ taskId, account: account.account_id, proxy: proxy.proxy_id, ts: nowIso() })}`;

  const session = {
    session_id: sessionId,
    task_id: taskId,
    risk_class: riskProfile.risk_tier,
    risk_profile: riskProfile,
    execution_mode: autonomy.execution_mode,
    account_id: account.account_id,
    proxy_id: proxy.proxy_id,
    status: applyAllowed ? 'active' : 'approval_required',
    created_at: nowIso(),
    updated_at: nowIso(),
    apply_allowed: applyAllowed
  };
  state.sessions[sessionId] = session;
  if (applyAllowed) {
    ensureAccountDailyCounter(account, dayStr());
    account.sends_today = clampInt(Number(account.sends_today || 0) + 1, 0, 100000, 0);
    account.updated_at = nowIso();
    state.accounts[account.account_id] = account;
  }
  state.metrics.sessions_total = clampInt(Number(state.metrics.sessions_total || 0) + 1, 0, 1_000_000_000, 0);
  saveState(policy, state);
  appendJsonl(policy.state.sessions_path, {
    ts: nowIso(),
    type: 'disposable_infrastructure_session',
    session
  });

  const out = {
    ok: true,
    type: 'disposable_infrastructure_acquire_session',
    ts: nowIso(),
    ...applyGate,
    autonomy_contract: autonomy,
    session,
    routing_hint: {
      lane: 'disposable_outreach',
      identity_mode: 'isolated_disposable',
      compliance_enforced: policy.compliance.enforce_can_spam === true
    },
    reason_codes: []
      .concat(applyGate.reason_codes || [])
      .concat(autonomy.reason_codes || [])
  };
  persistLatest(policy, out);
  return out;
}

function cmdReportDeliverability(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const sessionId = normalizeToken(args['session-id'] || args.session_id || '', 160);
  const session = sessionId ? state.sessions[sessionId] : null;
  if (!session) return { ok: false, type: 'disposable_infrastructure_report_deliverability', ts: nowIso(), error: 'session_not_found' };
  const account = state.accounts[session.account_id];
  if (!account) return { ok: false, type: 'disposable_infrastructure_report_deliverability', ts: nowIso(), error: 'account_not_found' };

  const bounceRate = clampNumber(args['bounce-rate'] || args.bounce_rate, 0, 1, 0);
  const blockScore = clampNumber(args['block-score'] || args.block_score, 0, 1, 0);
  const applyGate = gateApply(policy, toBool(args.apply, false));
  const rotateRecommended = bounceRate >= Number(policy.risk.rotate_on_bounce_rate || 1)
    || blockScore >= Number(policy.risk.rotate_on_block_score || 1);

  session.updated_at = nowIso();
  session.deliverability = {
    bounce_rate: bounceRate,
    block_score: blockScore
  };
  state.sessions[sessionId] = session;

  account.reputation = clampNumber(Number(account.reputation || 0) - (bounceRate * 0.25) - (blockScore * 0.35), 0, 1, 0);
  account.updated_at = nowIso();
  if (rotateRecommended) {
    account.status = applyGate.apply_allowed ? 'cooldown' : 'shadow_cooldown';
    account.last_rotation_recommendation_at = nowIso();
    state.metrics.rotations_recommended = clampInt(Number(state.metrics.rotations_recommended || 0) + 1, 0, 1_000_000_000, 0);
  }
  state.accounts[session.account_id] = account;
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'disposable_infrastructure_report_deliverability',
    ts: nowIso(),
    ...applyGate,
    session_id: sessionId,
    account_id: session.account_id,
    deliverability: {
      bounce_rate: bounceRate,
      block_score: blockScore
    },
    rotate_recommended: rotateRecommended,
    reason_codes: rotateRecommended ? ['rotation_threshold_crossed'] : []
  };
  persistLatest(policy, out);
  return out;
}

function cmdReleaseSession(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const sessionId = normalizeToken(args['session-id'] || args.session_id || '', 160);
  const session = sessionId ? state.sessions[sessionId] : null;
  if (!session) return { ok: false, type: 'disposable_infrastructure_release_session', ts: nowIso(), error: 'session_not_found' };
  const applyGate = gateApply(policy, toBool(args.apply, false));
  session.status = applyGate.apply_allowed ? 'released' : 'shadow_released';
  session.release_reason = cleanText(args.reason || 'completed', 220) || 'completed';
  session.updated_at = nowIso();
  state.sessions[sessionId] = session;
  state.metrics.sessions_released = clampInt(Number(state.metrics.sessions_released || 0) + 1, 0, 1_000_000_000, 0);
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'disposable_infrastructure_release_session',
    ts: nowIso(),
    ...applyGate,
    session
  };
  persistLatest(policy, out);
  return out;
}

function cmdStatus(policy: AnyObj) {
  const state = loadState(policy);
  const latest = readJson(policy.state.latest_path, null);
  const doNotContact = readJson(policy.compliance.do_not_contact_path, []);
  const sessionRows = Object.values(state.sessions || {});
  const openSessions = sessionRows.filter((row: any) => row && !String(row.status || '').includes('released')).length;
  return {
    ok: true,
    type: 'disposable_infrastructure_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true
    },
    pools: {
      accounts_total: Object.keys(state.accounts || {}).length,
      proxies_total: Object.keys(state.proxies || {}).length,
      sessions_total: sessionRows.length,
      sessions_open: openSessions
    },
    compliance: {
      enforce_can_spam: policy.compliance.enforce_can_spam === true,
      enforce_opt_out_footer: policy.compliance.enforce_opt_out_footer === true,
      enforce_identity_disclosure: policy.compliance.enforce_identity_disclosure === true,
      do_not_contact_count: Array.isArray(doNotContact) ? doNotContact.length : 0
    },
    risk: policy.risk,
    metrics: state.metrics,
    latest: latest && typeof latest === 'object'
      ? {
        type: cleanText(latest.type || '', 120) || null,
        ts: cleanText(latest.ts || '', 60) || null
      }
      : null,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state.state_path),
      latest_path: rel(policy.state.latest_path),
      receipts_path: rel(policy.state.receipts_path),
      sessions_path: rel(policy.state.sessions_path)
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  let out: AnyObj;
  if (!policy.enabled) {
    out = {
      ok: false,
      type: 'disposable_infrastructure',
      ts: nowIso(),
      error: 'policy_disabled'
    };
  } else if (cmd === 'status') {
    out = cmdStatus(policy);
  } else if (cmd === 'register-account') {
    out = cmdRegisterAccount(policy, args);
  } else if (cmd === 'register-proxy') {
    out = cmdRegisterProxy(policy, args);
  } else if (cmd === 'acquire-session') {
    out = cmdAcquireSession(policy, args);
  } else if (cmd === 'report-deliverability') {
    out = cmdReportDeliverability(policy, args);
  } else if (cmd === 'release-session') {
    out = cmdReleaseSession(policy, args);
  } else if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  } else {
    out = {
      ok: false,
      type: 'disposable_infrastructure',
      ts: nowIso(),
      error: `unknown_command:${cmd}`
    };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdStatus,
  cmdRegisterAccount,
  cmdRegisterProxy,
  cmdAcquireSession,
  cmdReportDeliverability,
  cmdReleaseSession
};
