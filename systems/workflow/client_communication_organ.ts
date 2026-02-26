#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/workflow/client_communication_organ.js
 *
 * Light outbound communication lifecycle controller.
 * BRG-003 implementation.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'client_communication_policy.json');
const DEFAULT_STATE_PATH = path.join(ROOT, 'state', 'adaptive', 'workflows', 'client_communication', 'state.json');
const DEFAULT_HISTORY_PATH = path.join(ROOT, 'state', 'adaptive', 'workflows', 'client_communication', 'history.jsonl');
const DEFAULT_INBOUND_PATH = path.join(ROOT, 'state', 'adaptive', 'workflows', 'client_communication', 'inbound_responses.jsonl');

function nowIso() {
  return new Date().toISOString();
}

function parseIsoMs(value: unknown) {
  const ts = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(ts) ? ts : null;
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

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readJsonlRows(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          const row = JSON.parse(line);
          return row && typeof row === 'object' ? row : null;
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stableId(seed: unknown, prefix = 'cco') {
  const digest = crypto.createHash('sha256').update(String(seed == null ? '' : seed)).digest('hex').slice(0, 14);
  return `${prefix}_${digest}`;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    channels: {
      default: {
        followup_hours: [24, 72],
        retry_backoff_sec: [300, 1800, 7200],
        escalation_hours: [24, 72, 168],
        max_followups: 2
      },
      email: {
        followup_hours: [24, 72],
        retry_backoff_sec: [300, 1800, 7200],
        escalation_hours: [24, 72, 168],
        max_followups: 2
      },
      discord: {
        followup_hours: [4, 24],
        retry_backoff_sec: [60, 300, 900],
        escalation_hours: [4, 24, 72],
        max_followups: 3
      },
      upwork: {
        followup_hours: [24, 72],
        retry_backoff_sec: [900, 3600, 14400],
        escalation_hours: [24, 72, 168],
        max_followups: 2
      }
    },
    human_gate: {
      enabled: true,
      require_gate_channels: ['email', 'discord', 'upwork'],
      high_value_confidence_threshold: 0.72,
      high_risk_levels: ['high', 'critical']
    }
  };
}

function normalizeChannelPolicy(raw: AnyObj, fallback: AnyObj) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const normalizeIntArray = (rows: unknown, lo: number, hi: number, fb: number[]) => {
    const out = (Array.isArray(rows) ? rows : fb)
      .map((v) => clampInt(v, lo, hi, 0))
      .filter((n) => n >= lo && n <= hi)
      .slice(0, 8);
    return out.length ? out : fb.slice(0);
  };
  return {
    followup_hours: normalizeIntArray(src.followup_hours, 1, 24 * 30, fallback.followup_hours),
    retry_backoff_sec: normalizeIntArray(src.retry_backoff_sec, 1, 24 * 60 * 60, fallback.retry_backoff_sec),
    escalation_hours: normalizeIntArray(src.escalation_hours, 1, 24 * 365, fallback.escalation_hours),
    max_followups: clampInt(src.max_followups, 0, 32, fallback.max_followups)
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const channelsRaw = raw.channels && typeof raw.channels === 'object' ? raw.channels : {};
  const channels: AnyObj = {};
  for (const key of ['default', 'email', 'discord', 'upwork']) {
    channels[key] = normalizeChannelPolicy(channelsRaw[key], base.channels[key] || base.channels.default);
  }
  const gateRaw = raw.human_gate && typeof raw.human_gate === 'object' ? raw.human_gate : {};
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: raw.enabled !== false,
    channels,
    human_gate: {
      enabled: gateRaw.enabled !== false,
      require_gate_channels: Array.isArray(gateRaw.require_gate_channels)
        ? gateRaw.require_gate_channels.map((v) => normalizeToken(v, 40)).filter(Boolean).slice(0, 8)
        : base.human_gate.require_gate_channels.slice(0),
      high_value_confidence_threshold: clampNumber(
        gateRaw.high_value_confidence_threshold,
        0,
        1,
        base.human_gate.high_value_confidence_threshold
      ),
      high_risk_levels: Array.isArray(gateRaw.high_risk_levels)
        ? gateRaw.high_risk_levels.map((v) => normalizeToken(v, 20)).filter(Boolean).slice(0, 8)
        : base.human_gate.high_risk_levels.slice(0)
    }
  };
}

function defaultState() {
  return {
    version: '1.0',
    updated_at: null,
    inbound_cursor: 0,
    threads: {}
  };
}

function loadState(statePath = DEFAULT_STATE_PATH) {
  const payload = readJson(statePath, defaultState());
  const threads = payload && payload.threads && typeof payload.threads === 'object' ? payload.threads : {};
  return {
    version: cleanText(payload.version || '1.0', 24) || '1.0',
    updated_at: payload.updated_at ? String(payload.updated_at) : null,
    inbound_cursor: clampInt(payload.inbound_cursor, 0, Number.MAX_SAFE_INTEGER, 0),
    threads
  };
}

function saveState(statePath: string, state: AnyObj) {
  const payload = {
    version: '1.0',
    updated_at: nowIso(),
    inbound_cursor: clampInt(state && state.inbound_cursor, 0, Number.MAX_SAFE_INTEGER, 0),
    threads: state && state.threads && typeof state.threads === 'object' ? state.threads : {}
  };
  writeJsonAtomic(statePath, payload);
  return payload;
}

function resolvePaths(opts: AnyObj = {}) {
  return {
    policy_path: path.resolve(String(opts.policyPath || opts.policy_path || process.env.CLIENT_COMMUNICATION_POLICY_PATH || DEFAULT_POLICY_PATH)),
    state_path: path.resolve(String(opts.statePath || opts.state_path || process.env.CLIENT_COMMUNICATION_STATE_PATH || DEFAULT_STATE_PATH)),
    history_path: path.resolve(String(opts.historyPath || opts.history_path || process.env.CLIENT_COMMUNICATION_HISTORY_PATH || DEFAULT_HISTORY_PATH)),
    inbound_path: path.resolve(String(opts.inboundPath || opts.inbound_path || process.env.CLIENT_COMMUNICATION_INBOUND_PATH || DEFAULT_INBOUND_PATH))
  };
}

function emitHistory(historyPath: string, row: AnyObj) {
  appendJsonl(historyPath, {
    ts: nowIso(),
    type: 'client_communication',
    ...row
  });
}

function classifyChannel(input: AnyObj = {}) {
  const adapter = normalizeToken(input.adapter || '', 80);
  const provider = normalizeToken(input.provider || '', 80);
  const objective = normalizeToken(input.objective || input.objective_id || '', 160);
  const hint = normalizeToken(input.channel || '', 40);
  const blob = `${hint} ${adapter} ${provider} ${objective}`;
  if (/\bupwork\b/.test(blob)) return 'upwork';
  if (/\bdiscord\b/.test(blob)) return 'discord';
  if (adapter.includes('slack')) return 'discord';
  if (/\bemail\b/.test(blob) || adapter.includes('email')) return 'email';
  return 'default';
}

function threadKey(input: AnyObj = {}, channel = 'default') {
  const workflowId = normalizeToken(input.workflow_id || '', 140) || 'wf_unknown';
  const objectiveId = normalizeToken(input.objective_id || '', 140) || 'obj_unknown';
  const targetRaw = cleanText(
    input.target
      || input.to
      || input.channel_id
      || input.channel
      || input.thread_id
      || input.recipient
      || input.provider
      || '',
    200
  ) || 'target_unknown';
  const target = normalizeToken(targetRaw, 180) || 'target_unknown';
  return stableId(`${workflowId}|${objectiveId}|${channel}|${target}`, 'thread');
}

function ensureThread(state: AnyObj, id: string, channel: string, provider: string, input: AnyObj, now: string) {
  if (!state.threads[id] || typeof state.threads[id] !== 'object') {
    state.threads[id] = {
      thread_id: id,
      channel,
      provider,
      workflow_id: cleanText(input.workflow_id || '', 120) || null,
      objective_id: cleanText(input.objective_id || '', 120) || null,
      created_at: now,
      status: 'initialized',
      outbound_attempts: 0,
      followups_sent: 0,
      last_outbound_at: null,
      first_outbound_at: null,
      last_response_at: null,
      retry_backoff_until: null,
      next_followup_at: null,
      escalation_tier: 0,
      requires_human_gate: false,
      last_failure_reason: null
    };
  }
  return state.threads[id];
}

function computeEscalationTier(thread: AnyObj, channelPolicy: AnyObj, nowMs: number) {
  const elapsedHours = (() => {
    const first = parseIsoMs(thread.first_outbound_at);
    if (!first) return 0;
    return Math.max(0, (nowMs - first) / (60 * 60 * 1000));
  })();
  const thresholds = Array.isArray(channelPolicy.escalation_hours) ? channelPolicy.escalation_hours : [];
  let tier = 0;
  for (let i = 0; i < thresholds.length; i += 1) {
    if (elapsedHours >= Number(thresholds[i] || 0)) tier = i + 1;
  }
  if (Number(thread.outbound_attempts || 0) >= 3) tier = Math.max(tier, 1);
  if (Number(thread.outbound_attempts || 0) >= 5) tier = Math.max(tier, 2);
  return tier;
}

function hasHumanGateApproval(input: AnyObj = {}) {
  if (input.human_approved === true) return true;
  if (input.communication_gate_approved === true) return true;
  const approval = input.approval && typeof input.approval === 'object' ? input.approval : {};
  return approval.communication_gate === true;
}

function applyInboundResponses(state: AnyObj, inboundPath: string, historyPath: string) {
  const rows = readJsonlRows(inboundPath);
  const cursor = clampInt(state.inbound_cursor, 0, Number.MAX_SAFE_INTEGER, 0);
  if (rows.length <= cursor) return;
  for (let i = cursor; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const explicitThread = cleanText(row.thread_id || '', 120);
    const channel = classifyChannel(row);
    const provider = normalizeToken(row.provider || 'default', 80) || 'default';
    const tid = explicitThread || threadKey(row, channel);
    const thread = ensureThread(state, tid, channel, provider, row, nowIso());
    thread.status = 'responded';
    thread.last_response_at = cleanText(row.responded_at || row.ts || nowIso(), 64) || nowIso();
    thread.requires_human_gate = false;
    thread.retry_backoff_until = null;
    emitHistory(historyPath, {
      stage: 'response_ingested',
      thread_id: tid,
      channel,
      provider,
      workflow_id: thread.workflow_id || null,
      objective_id: thread.objective_id || null,
      source: cleanText(row.source || 'inbound_feed', 80) || 'inbound_feed'
    });
  }
  state.inbound_cursor = rows.length;
}

function prepareCommunicationAttempt(input: AnyObj = {}, opts: AnyObj = {}) {
  const paths = resolvePaths(opts);
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(paths.policy_path);
  const nowMs = Number.isFinite(Number(input.now_ms)) ? Number(input.now_ms) : Date.now();
  const now = new Date(nowMs).toISOString();
  const dryRun = input.dry_run === true;

  if (policy.enabled !== true) {
    return {
      ok: true,
      applicable: false,
      reason: 'communication_policy_disabled',
      policy_path: relPath(paths.policy_path)
    };
  }

  const channel = classifyChannel(input);
  if (!['email', 'discord', 'upwork', 'default'].includes(channel)) {
    return {
      ok: true,
      applicable: false,
      reason: 'communication_channel_unclassified',
      channel,
      policy_path: relPath(paths.policy_path)
    };
  }

  const provider = normalizeToken(input.provider || 'default', 80) || 'default';
  const state = loadState(paths.state_path);
  applyInboundResponses(state, paths.inbound_path, paths.history_path);

  const tid = threadKey(input, channel);
  const thread = ensureThread(state, tid, channel, provider, input, now);
  const channelPolicy = policy.channels[channel] || policy.channels.default;

  const risk = normalizeToken(input.risk || 'medium', 20) || 'medium';
  const highValueConfidence = clampNumber(input.high_value_confidence, 0, 1, 0);
  const gateCfg = policy.human_gate;
  const gateChannelSet = new Set((Array.isArray(gateCfg.require_gate_channels) ? gateCfg.require_gate_channels : []).map((v) => normalizeToken(v, 40)).filter(Boolean));
  const gateRiskSet = new Set((Array.isArray(gateCfg.high_risk_levels) ? gateCfg.high_risk_levels : []).map((v) => normalizeToken(v, 20)).filter(Boolean));
  const humanApproved = hasHumanGateApproval(input);
  const requiresGate = gateCfg.enabled === true
    && gateChannelSet.has(channel)
    && !humanApproved
    && (
      highValueConfidence >= Number(gateCfg.high_value_confidence_threshold || 0.72)
      || gateRiskSet.has(risk)
    );

  if (requiresGate) {
    thread.requires_human_gate = true;
    thread.status = 'awaiting_human_gate';
    thread.last_failure_reason = 'communication_human_gate_required';
    thread.escalation_tier = computeEscalationTier(thread, channelPolicy, nowMs);
    saveState(paths.state_path, state);
    emitHistory(paths.history_path, {
      stage: 'blocked_human_gate',
      thread_id: tid,
      channel,
      provider,
      workflow_id: thread.workflow_id || null,
      objective_id: thread.objective_id || null,
      high_value_confidence: Number(highValueConfidence.toFixed(4)),
      risk,
      reason: 'communication_human_gate_required',
      policy_path: relPath(paths.policy_path),
      state_path: relPath(paths.state_path)
    });
    return {
      ok: false,
      applicable: true,
      allowed: false,
      reason: 'communication_human_gate_required',
      channel,
      provider,
      thread_id: tid,
      escalation_tier: thread.escalation_tier,
      requires_human_gate: true,
      policy_path: relPath(paths.policy_path),
      state_path: relPath(paths.state_path)
    };
  }

  thread.requires_human_gate = false;
  thread.status = dryRun ? 'drafted' : 'sending';
  if (!dryRun) {
    thread.outbound_attempts = Number(thread.outbound_attempts || 0) + 1;
    thread.last_outbound_at = now;
    if (!thread.first_outbound_at) thread.first_outbound_at = now;
    const followupHours = Array.isArray(channelPolicy.followup_hours) ? channelPolicy.followup_hours : [];
    const idx = Math.max(0, Math.min(followupHours.length - 1, Number(thread.followups_sent || 0)));
    const nextHours = Number(followupHours[idx] || 0);
    thread.next_followup_at = nextHours > 0
      ? new Date(nowMs + (nextHours * 60 * 60 * 1000)).toISOString()
      : null;
  }
  thread.escalation_tier = computeEscalationTier(thread, channelPolicy, nowMs);
  saveState(paths.state_path, state);

  emitHistory(paths.history_path, {
    stage: dryRun ? 'draft_created' : 'send_preflight',
    thread_id: tid,
    channel,
    provider,
    workflow_id: thread.workflow_id || null,
    objective_id: thread.objective_id || null,
    high_value_confidence: Number(highValueConfidence.toFixed(4)),
    risk,
    escalation_tier: thread.escalation_tier,
    next_followup_at: thread.next_followup_at || null,
    policy_path: relPath(paths.policy_path),
    state_path: relPath(paths.state_path)
  });

  return {
    ok: true,
    applicable: true,
    allowed: true,
    channel,
    provider,
    thread_id: tid,
    escalation_tier: thread.escalation_tier,
    next_followup_at: thread.next_followup_at || null,
    requires_human_gate: false,
    policy_path: relPath(paths.policy_path),
    state_path: relPath(paths.state_path)
  };
}

function finalizeCommunicationAttempt(input: AnyObj = {}, opts: AnyObj = {}) {
  const paths = resolvePaths(opts);
  const policy = opts.policy && typeof opts.policy === 'object' ? opts.policy : loadPolicy(paths.policy_path);
  const nowMs = Number.isFinite(Number(input.now_ms)) ? Number(input.now_ms) : Date.now();
  const now = new Date(nowMs).toISOString();

  if (policy.enabled !== true) {
    return { ok: true, applicable: false, reason: 'communication_policy_disabled' };
  }

  const threadId = cleanText(input.thread_id || '', 120);
  if (!threadId) return { ok: true, applicable: false, reason: 'missing_thread_id' };

  const state = loadState(paths.state_path);
  applyInboundResponses(state, paths.inbound_path, paths.history_path);
  const thread = state.threads[threadId];
  if (!thread || typeof thread !== 'object') {
    return { ok: true, applicable: false, reason: 'thread_not_found', thread_id: threadId };
  }

  const channel = normalizeToken(thread.channel || 'default', 40) || 'default';
  const channelPolicy = policy.channels[channel] || policy.channels.default;
  const outcomeOk = input.ok === true;
  const dryRun = input.dry_run === true;
  const failureReason = cleanText(input.failure_reason || '', 180) || null;

  if (!dryRun) {
    if (outcomeOk) {
      thread.status = 'sent';
      thread.retry_backoff_until = null;
      thread.last_failure_reason = null;
    } else {
      thread.status = 'retry_pending';
      thread.last_failure_reason = failureReason;
      const backoffs = Array.isArray(channelPolicy.retry_backoff_sec) ? channelPolicy.retry_backoff_sec : [];
      const idx = Math.max(0, Math.min(backoffs.length - 1, Math.max(0, Number(thread.outbound_attempts || 1) - 1)));
      const backoffSec = Number(backoffs[idx] || 300);
      thread.retry_backoff_until = new Date(nowMs + (backoffSec * 1000)).toISOString();
    }
    thread.escalation_tier = computeEscalationTier(thread, channelPolicy, nowMs);
    saveState(paths.state_path, state);
  }

  emitHistory(paths.history_path, {
    stage: 'send_result',
    thread_id: threadId,
    channel,
    provider: normalizeToken(thread.provider || 'default', 80) || 'default',
    workflow_id: thread.workflow_id || null,
    objective_id: thread.objective_id || null,
    ok: outcomeOk,
    failure_reason: failureReason,
    retry_backoff_until: thread.retry_backoff_until || null,
    escalation_tier: thread.escalation_tier,
    dry_run: dryRun,
    policy_path: relPath(paths.policy_path),
    state_path: relPath(paths.state_path)
  });

  return {
    ok: true,
    applicable: true,
    channel,
    thread_id: threadId,
    status: thread.status,
    escalation_tier: Number(thread.escalation_tier || 0),
    retry_backoff_until: thread.retry_backoff_until || null,
    next_followup_at: thread.next_followup_at || null
  };
}

module.exports = {
  classifyChannel,
  loadPolicy,
  loadState,
  prepareCommunicationAttempt,
  finalizeCommunicationAttempt
};
