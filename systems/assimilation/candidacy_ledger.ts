#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function ensureDir(fsRef: AnyObj, dirPath: string) {
  fsRef.mkdirSync(dirPath, { recursive: true });
}

function readJson(fsRef: AnyObj, filePath: string, fallback: any) {
  try {
    if (!fsRef.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fsRef.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(fsRef: AnyObj, pathRef: AnyObj, filePath: string, value: AnyObj) {
  ensureDir(fsRef, pathRef.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fsRef.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fsRef.renameSync(tmpPath, filePath);
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeSourceType(v: unknown) {
  const token = normalizeToken(v, 64);
  if (!token) return 'external_tool';
  if (token === 'local_skill') return 'local_skill';
  if (token === 'external_adapter') return 'external_adapter';
  return 'external_tool';
}

function normalizeRiskClass(v: unknown) {
  const token = normalizeToken(v, 64);
  return token || 'general';
}

function defaultLedger() {
  return {
    version: '1.0',
    updated_at: null,
    capabilities: {}
  };
}

function loadLedger(fsRef: AnyObj, ledgerPath: string) {
  const payload = readJson(fsRef, ledgerPath, null);
  if (!payload || typeof payload !== 'object') return defaultLedger();
  return {
    version: cleanText(payload.version || '1.0', 32) || '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    capabilities: payload.capabilities && typeof payload.capabilities === 'object'
      ? payload.capabilities
      : {}
  };
}

function saveLedger(fsRef: AnyObj, pathRef: AnyObj, ledgerPath: string, ledger: AnyObj, nowTs = nowIso()) {
  const out = {
    version: cleanText(ledger && ledger.version || '1.0', 32) || '1.0',
    updated_at: nowTs,
    capabilities: ledger && ledger.capabilities && typeof ledger.capabilities === 'object'
      ? ledger.capabilities
      : {}
  };
  writeJsonAtomic(fsRef, pathRef, ledgerPath, out);
  return out;
}

function ensureCapability(ledger: AnyObj, capabilityId: string, seed: AnyObj = {}, nowTs = nowIso()) {
  const id = normalizeToken(capabilityId, 160);
  if (!id) return null;
  if (!ledger.capabilities || typeof ledger.capabilities !== 'object') ledger.capabilities = {};
  const prev = ledger.capabilities[id] && typeof ledger.capabilities[id] === 'object'
    ? ledger.capabilities[id]
    : {};
  const workflowCounts = prev.workflow_counts && typeof prev.workflow_counts === 'object'
    ? prev.workflow_counts
    : {};
  const sourceType = normalizeSourceType(seed.source_type || prev.source_type || 'external_tool');
  const sourceCounts = prev.source_counts && typeof prev.source_counts === 'object'
    ? prev.source_counts
    : {};
  if (!sourceCounts[sourceType]) sourceCounts[sourceType] = 0;
  const out = {
    capability_id: id,
    status: cleanText(prev.status || 'candidate', 64) || 'candidate',
    source_type: sourceType,
    source_counts: {
      ...sourceCounts
    },
    first_seen_ts: String(prev.first_seen_ts || nowTs),
    last_seen_ts: String(prev.last_seen_ts || nowTs),
    risk_class: normalizeRiskClass(seed.risk_class || prev.risk_class || 'general'),
    native_equivalent_id: normalizeToken(seed.native_equivalent_id || prev.native_equivalent_id || '', 160) || null,
    legal: prev.legal && typeof prev.legal === 'object'
      ? prev.legal
      : {},
    uses_total: clampInt(prev.uses_total, 0, 100000000, 0),
    successes_total: clampInt(prev.successes_total, 0, 100000000, 0),
    failures_total: clampInt(prev.failures_total, 0, 100000000, 0),
    workflow_counts: workflowCounts,
    pain_score_total: clampNumber(prev.pain_score_total, 0, 1000000, 0),
    cost_score_total: clampNumber(prev.cost_score_total, 0, 1000000, 0),
    attempts: prev.attempts && typeof prev.attempts === 'object'
      ? {
          total: clampInt(prev.attempts.total, 0, 100000000, 0),
          success: clampInt(prev.attempts.success, 0, 100000000, 0),
          reject: clampInt(prev.attempts.reject, 0, 100000000, 0),
          fail: clampInt(prev.attempts.fail, 0, 100000000, 0),
          shadow_only: clampInt(prev.attempts.shadow_only, 0, 100000000, 0)
        }
      : { total: 0, success: 0, reject: 0, fail: 0, shadow_only: 0 },
    attempts_history: Array.isArray(prev.attempts_history)
      ? prev.attempts_history.slice(-128)
      : [],
    cooldown_until_ts: prev.cooldown_until_ts ? String(prev.cooldown_until_ts) : null,
    last_attempt_ts: prev.last_attempt_ts ? String(prev.last_attempt_ts) : null,
    last_assimilation_ts: prev.last_assimilation_ts ? String(prev.last_assimilation_ts) : null,
    last_outcome: cleanText(prev.last_outcome || '', 64) || null,
    last_reason_codes: Array.isArray(prev.last_reason_codes) ? prev.last_reason_codes.slice(0, 24) : []
  };
  ledger.capabilities[id] = out;
  return out;
}

function updateLegalMeta(record: AnyObj, input: AnyObj = {}, nowTs = nowIso()) {
  record.legal = {
    license: normalizeToken(input.license || (record.legal && record.legal.license) || '', 80) || null,
    tos_ok: input.tos_ok == null ? (record.legal && record.legal.tos_ok) : !!input.tos_ok,
    robots_ok: input.robots_ok == null ? (record.legal && record.legal.robots_ok) : !!input.robots_ok,
    data_rights_ok: input.data_rights_ok == null
      ? (record.legal && record.legal.data_rights_ok)
      : !!input.data_rights_ok,
    last_checked_ts: nowTs
  };
}

function recordUsage(ledger: AnyObj, input: AnyObj = {}, nowTs = nowIso()) {
  const capabilityId = normalizeToken(input.capability_id || '', 160);
  if (!capabilityId) throw new Error('capability_id_required');
  const sourceType = normalizeSourceType(input.source_type || 'external_tool');
  const workflowId = normalizeToken(input.workflow_id || '', 120) || 'unknown_workflow';
  const success = input.success == null ? true : !!input.success;
  const painScore = clampNumber(input.pain_score, 0, 1, 0);
  const costScore = clampNumber(input.cost_score, 0, 1, 0);

  const record = ensureCapability(ledger, capabilityId, {
    source_type: sourceType,
    risk_class: input.risk_class,
    native_equivalent_id: input.native_equivalent_id
  }, nowTs);
  if (!record) throw new Error('capability_id_required');
  if (!record.source_counts[sourceType]) record.source_counts[sourceType] = 0;
  record.source_counts[sourceType] = clampInt(Number(record.source_counts[sourceType] || 0) + 1, 0, 100000000, 1);
  record.last_seen_ts = nowTs;
  record.uses_total = clampInt(Number(record.uses_total || 0) + 1, 0, 100000000, 1);
  if (success) record.successes_total = clampInt(Number(record.successes_total || 0) + 1, 0, 100000000, 1);
  if (!success) record.failures_total = clampInt(Number(record.failures_total || 0) + 1, 0, 100000000, 1);
  record.workflow_counts[workflowId] = clampInt(Number(record.workflow_counts[workflowId] || 0) + 1, 0, 100000000, 1);
  record.pain_score_total = Number((Number(record.pain_score_total || 0) + painScore).toFixed(6));
  record.cost_score_total = Number((Number(record.cost_score_total || 0) + costScore).toFixed(6));
  record.risk_class = normalizeRiskClass(input.risk_class || record.risk_class || 'general');
  if (input.native_equivalent_id != null) {
    record.native_equivalent_id = normalizeToken(input.native_equivalent_id, 160) || null;
  }
  updateLegalMeta(record, input, nowTs);
  return record;
}

function daysObserved(record: AnyObj, nowTs = nowIso()) {
  const nowMs = parseIsoMs(nowTs) || Date.now();
  const startMs = parseIsoMs(record && record.first_seen_ts);
  if (startMs == null) return 0;
  return Number(Math.max(0, (nowMs - startMs) / (24 * 60 * 60 * 1000)).toFixed(6));
}

function workflowSpread(record: AnyObj) {
  const workflows = record && record.workflow_counts && typeof record.workflow_counts === 'object'
    ? Object.keys(record.workflow_counts)
    : [];
  return workflows.filter(Boolean).length;
}

function attemptsToday(record: AnyObj, nowTs = nowIso()) {
  const nowMs = parseIsoMs(nowTs) || Date.now();
  const cutoff = nowMs - (24 * 60 * 60 * 1000);
  const rows = Array.isArray(record && record.attempts_history) ? record.attempts_history : [];
  return rows.filter((row) => {
    const tsMs = parseIsoMs(row && row.ts);
    return tsMs != null && tsMs >= cutoff;
  }).length;
}

function hasCooldown(record: AnyObj, nowTs = nowIso()) {
  const untilMs = parseIsoMs(record && record.cooldown_until_ts);
  const nowMs = parseIsoMs(nowTs) || Date.now();
  return untilMs != null && untilMs > nowMs;
}

function computeThresholdFlags(record: AnyObj, policy: AnyObj = {}, nowTs = nowIso()) {
  const trigger = policy && policy.trigger && typeof policy.trigger === 'object' ? policy.trigger : {};
  const antiGaming = policy && policy.anti_gaming && typeof policy.anti_gaming === 'object'
    ? policy.anti_gaming
    : {};
  const minUses = clampInt(trigger.min_uses, 1, 1000000, 12);
  const minWorkflowSpread = clampInt(trigger.min_workflow_spread, 1, 1000000, 3);
  const minDaysObserved = clampNumber(trigger.min_days_observed, 0, 3650, 7);
  const minPainScore = clampNumber(trigger.min_pain_score, 0, 1, 0.15);
  const maxAttemptsPerDay = clampInt(antiGaming.retry_rate_limit_per_capability_per_day, 1, 1000, 2);
  const spread = workflowSpread(record);
  const observedDays = daysObserved(record, nowTs);
  const pain = clampNumber(record && record.pain_score_total, 0, 1000000, 0);
  const uses = clampInt(record && record.uses_total, 0, 100000000, 0);
  const cooldownActive = hasCooldown(record, nowTs);
  const attempts24h = attemptsToday(record, nowTs);
  const improvementMode = !!(record && record.native_equivalent_id);

  const flags = {
    min_uses_met: uses >= minUses,
    min_workflow_spread_met: spread >= minWorkflowSpread,
    min_days_observed_met: observedDays >= minDaysObserved,
    min_pain_score_met: pain >= minPainScore,
    cooldown_clear: !cooldownActive,
    retry_budget_clear: attempts24h < maxAttemptsPerDay,
    dedupe_path_valid: true
  };
  const ready = Object.values(flags).every((v) => v === true);
  return {
    ready,
    flags,
    metrics: {
      uses_total: uses,
      workflow_spread: spread,
      observed_days: observedDays,
      pain_score_total: pain,
      attempts_24h: attempts24h,
      improvement_mode: improvementMode
    }
  };
}

function setAttemptOutcome(record: AnyObj, outcome: string, reasonCodes: string[] = [], policy: AnyObj = {}, nowTs = nowIso()) {
  if (!record.attempts || typeof record.attempts !== 'object') {
    record.attempts = { total: 0, success: 0, reject: 0, fail: 0, shadow_only: 0 };
  }
  record.attempts.total = clampInt(Number(record.attempts.total || 0) + 1, 0, 100000000, 1);
  if (outcome === 'success') record.attempts.success = clampInt(Number(record.attempts.success || 0) + 1, 0, 100000000, 1);
  if (outcome === 'reject') record.attempts.reject = clampInt(Number(record.attempts.reject || 0) + 1, 0, 100000000, 1);
  if (outcome === 'fail') record.attempts.fail = clampInt(Number(record.attempts.fail || 0) + 1, 0, 100000000, 1);
  if (outcome === 'shadow_only') record.attempts.shadow_only = clampInt(Number(record.attempts.shadow_only || 0) + 1, 0, 100000000, 1);
  record.last_attempt_ts = nowTs;
  record.last_outcome = cleanText(outcome, 64) || 'unknown';
  record.last_reason_codes = Array.isArray(reasonCodes) ? reasonCodes.slice(0, 24) : [];
  if (outcome === 'success') {
    record.last_assimilation_ts = nowTs;
  }
  const trigger = policy && policy.trigger && typeof policy.trigger === 'object' ? policy.trigger : {};
  const failureCooldownH = clampInt(trigger.cooldown_after_failure_hours, 0, 24 * 90, 24);
  const rejectCooldownH = clampInt(trigger.cooldown_after_rejection_hours, 0, 24 * 90, 12);
  if (outcome === 'fail' && failureCooldownH > 0) {
    const untilMs = (parseIsoMs(nowTs) || Date.now()) + (failureCooldownH * 60 * 60 * 1000);
    record.cooldown_until_ts = new Date(untilMs).toISOString();
  } else if (outcome === 'reject' && rejectCooldownH > 0) {
    const untilMs = (parseIsoMs(nowTs) || Date.now()) + (rejectCooldownH * 60 * 60 * 1000);
    record.cooldown_until_ts = new Date(untilMs).toISOString();
  } else {
    record.cooldown_until_ts = null;
  }
  if (!Array.isArray(record.attempts_history)) record.attempts_history = [];
  record.attempts_history = record.attempts_history.concat([{
    ts: nowTs,
    outcome: record.last_outcome,
    reason_codes: record.last_reason_codes
  }]).slice(-128);
}

function listReadyCandidates(ledger: AnyObj, policy: AnyObj = {}, nowTs = nowIso()) {
  const rows = Object.values((ledger && ledger.capabilities) || {}) as AnyObj[];
  return rows
    .map((record) => {
      const thresholds = computeThresholdFlags(record, policy, nowTs);
      return {
        capability_id: String(record.capability_id || ''),
        source_counts: record.source_counts && typeof record.source_counts === 'object'
          ? record.source_counts
          : {},
        risk_class: String(record.risk_class || 'general'),
        native_equivalent_id: record.native_equivalent_id || null,
        thresholds,
        score: Number((
          Number(record.pain_score_total || 0) * 0.55
          + Number(record.uses_total || 0) * 0.35
          + workflowSpread(record) * 0.1
        ).toFixed(6))
      };
    })
    .filter((row) => row.thresholds && row.thresholds.ready === true)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

module.exports = {
  normalizeSourceType,
  normalizeRiskClass,
  loadLedger,
  saveLedger,
  ensureCapability,
  recordUsage,
  computeThresholdFlags,
  setAttemptOutcome,
  listReadyCandidates
};
