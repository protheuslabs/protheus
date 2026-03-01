#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.UNIVERSAL_EXECUTION_POLICY_PATH
  ? path.resolve(process.env.UNIVERSAL_EXECUTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'universal_execution_primitive_policy.json');
const ACTUATION_EXECUTOR = process.env.ACTUATION_EXECUTOR_PATH
  ? path.resolve(process.env.ACTUATION_EXECUTOR_PATH)
  : path.join(ROOT, 'systems', 'actuation', 'actuation_executor.js');
const SUB_EXECUTOR_SYNTHESIS = process.env.SUB_EXECUTOR_SYNTHESIS_PATH
  ? path.resolve(process.env.SUB_EXECUTOR_SYNTHESIS_PATH)
  : path.join(ROOT, 'systems', 'actuation', 'sub_executor_synthesis.js');

function nowIso() {
  return new Date().toISOString();
}

function dayStr() {
  return nowIso().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/universal_execution_primitive.js run --profile-id=<id> [--intent=<intent>] --params=<json> [--context=<json>] [--dry-run]');
  console.log('  node systems/actuation/universal_execution_primitive.js run --profile-json=@/path/profile.json [--intent=<intent>] --params=<json> [--context=<json>] [--dry-run]');
  console.log('  node systems/actuation/universal_execution_primitive.js status [latest|YYYY-MM-DD]');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
}

function cleanText(v: unknown, maxLen = 320) {
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function parseJsonArg(raw: unknown, fallback: any) {
  const text = cleanText(raw, 20000);
  if (!text) return fallback;
  const payloadText = text.startsWith('@')
    ? fs.readFileSync(path.resolve(text.slice(1)), 'utf8')
    : text;
  try {
    return JSON.parse(payloadText);
  } catch {
    return fallback;
  }
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function shaHex(value: unknown) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    min_profile_confidence: 0.6,
    default_adapter_kind: 'http_request',
    allowed_adapter_kinds: [],
    profile_roots: [
      'state/assimilation/capability_profiles/profiles'
    ],
    source_type_adapter_map: {
      api: 'http_request',
      web_ui: 'browser_task',
      filesystem: 'filesystem_task',
      shell: 'shell_task',
      payment: 'payment_task',
      comms_email: 'email_message'
    },
    intent_adapter_map: {
      send_email: 'email_message',
      send_slack: 'slack_message',
      send_discord: 'discord_message',
      create_calendar_event: 'calendar_event',
      run_shell: 'shell_task',
      write_file: 'filesystem_task',
      pay_invoice: 'payment_task'
    },
    sub_executor_synthesis: {
      enabled: false,
      script_path: 'systems/actuation/sub_executor_synthesis.js',
      auto_propose_on_errors: [
        'adapter_kind_unresolved',
        'adapter_kind_not_allowed',
        'executor_failed'
      ],
      risk_class_by_error: {
        adapter_kind_unresolved: 'low',
        adapter_kind_not_allowed: 'medium',
        executor_failed: 'low'
      }
    },
    computer_use_hardening: {
      enabled: true,
      protected_adapter_kinds: ['browser_task', 'browser_action', 'api_request'],
      require_session_id: true,
      require_checkpoint_for_apply: true,
      max_recovery_attempts: 1,
      verification_keywords: ['captcha', 'verification_code', '2fa', 'one_time_code'],
      handoff_required_on_verification: true,
      checkpoints_path: 'state/actuation/universal_execution_primitive/checkpoints.jsonl',
      handoff_path: 'state/actuation/universal_execution_primitive/handoffs.jsonl'
    },
    computer_use_execution_verification: {
      enabled: true,
      protected_adapter_kinds: ['browser_task', 'browser_action', 'api_request'],
      max_verify_attempts: 2,
      fail_closed: true,
      require_success_markers: false,
      success_markers: ['success', 'completed', 'done'],
      failure_markers: ['blocked', 'captcha_required', 'verification_required'],
      expected_outcome_keys: ['expected_outcome', 'verification_target', 'expected_signal'],
      receipts_path: 'state/actuation/universal_execution_primitive/verification.jsonl'
    },
    computer_use_reliability_metrics: {
      enabled: true,
      tracked_adapter_kinds: ['browser_task', 'browser_action', 'api_request'],
      suite_keys: ['task_suite', 'suite', 'benchmark_suite'],
      case_keys: ['case_id', 'task_id', 'benchmark_case_id'],
      rolling_window: 500,
      target_success_rate: 0.7,
      webarena_aliases: ['webarena', 'webarena_lite'],
      metrics_path: 'state/actuation/universal_execution_primitive/computer_use_metrics.json'
    },
    receipts_path: 'state/actuation/universal_execution_primitive/receipts'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const roots = Array.isArray(src.profile_roots)
    ? src.profile_roots
    : base.profile_roots;
  const synthesis = src.sub_executor_synthesis && typeof src.sub_executor_synthesis === 'object'
    ? src.sub_executor_synthesis
    : {};
  const hardening = src.computer_use_hardening && typeof src.computer_use_hardening === 'object'
    ? src.computer_use_hardening
    : {};
  const verification = src.computer_use_execution_verification
    && typeof src.computer_use_execution_verification === 'object'
    ? src.computer_use_execution_verification
    : {};
  const reliabilityMetrics = src.computer_use_reliability_metrics
    && typeof src.computer_use_reliability_metrics === 'object'
    ? src.computer_use_reliability_metrics
    : {};
  const baseSynthesis = base.sub_executor_synthesis;
  const baseHardening = base.computer_use_hardening;
  const baseVerification = base.computer_use_execution_verification;
  const baseReliability = base.computer_use_reliability_metrics;
  const synthesisErrors = Array.isArray(synthesis.auto_propose_on_errors)
    ? synthesis.auto_propose_on_errors
    : baseSynthesis.auto_propose_on_errors;
  const synthesisRiskMap = synthesis.risk_class_by_error && typeof synthesis.risk_class_by_error === 'object'
    ? synthesis.risk_class_by_error
    : baseSynthesis.risk_class_by_error;
  return {
    version: cleanText(src.version || base.version, 32) || base.version,
    enabled: src.enabled !== false,
    min_profile_confidence: Math.max(0, Math.min(1, Number(src.min_profile_confidence != null ? src.min_profile_confidence : base.min_profile_confidence) || base.min_profile_confidence)),
    default_adapter_kind: normalizeToken(src.default_adapter_kind || base.default_adapter_kind, 80) || base.default_adapter_kind,
    allowed_adapter_kinds: Array.isArray(src.allowed_adapter_kinds)
      ? src.allowed_adapter_kinds.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : [],
    profile_roots: roots
      .map((row: unknown) => cleanText(row, 260))
      .filter(Boolean)
      .map((row: string) => (path.isAbsolute(row) ? row : path.join(ROOT, row))),
    source_type_adapter_map: src.source_type_adapter_map && typeof src.source_type_adapter_map === 'object'
      ? src.source_type_adapter_map
      : base.source_type_adapter_map,
    intent_adapter_map: src.intent_adapter_map && typeof src.intent_adapter_map === 'object'
      ? src.intent_adapter_map
      : base.intent_adapter_map,
    sub_executor_synthesis: {
      enabled: synthesis.enabled === true,
      script_path: path.isAbsolute(cleanText(synthesis.script_path || baseSynthesis.script_path, 320))
        ? cleanText(synthesis.script_path || baseSynthesis.script_path, 320)
        : path.join(ROOT, cleanText(synthesis.script_path || baseSynthesis.script_path, 320)),
      auto_propose_on_errors: synthesisErrors
        .map((row: unknown) => normalizeToken(row, 80))
        .filter(Boolean),
      risk_class_by_error: synthesisRiskMap && typeof synthesisRiskMap === 'object'
        ? synthesisRiskMap
        : {}
    },
    computer_use_hardening: {
      enabled: hardening.enabled !== false,
      protected_adapter_kinds: Array.isArray(hardening.protected_adapter_kinds)
        ? hardening.protected_adapter_kinds.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : baseHardening.protected_adapter_kinds.slice(0),
      require_session_id: hardening.require_session_id !== false,
      require_checkpoint_for_apply: hardening.require_checkpoint_for_apply !== false,
      max_recovery_attempts: Math.max(
        0,
        Math.min(
          5,
          Number(hardening.max_recovery_attempts != null
            ? hardening.max_recovery_attempts
            : baseHardening.max_recovery_attempts) || baseHardening.max_recovery_attempts
        )
      ),
      verification_keywords: Array.isArray(hardening.verification_keywords)
        ? hardening.verification_keywords.map((row: unknown) => cleanText(row, 80).toLowerCase()).filter(Boolean)
        : baseHardening.verification_keywords.slice(0),
      handoff_required_on_verification: hardening.handoff_required_on_verification !== false,
      checkpoints_path: path.isAbsolute(cleanText(hardening.checkpoints_path || baseHardening.checkpoints_path, 320))
        ? cleanText(hardening.checkpoints_path || baseHardening.checkpoints_path, 320)
        : path.join(ROOT, cleanText(hardening.checkpoints_path || baseHardening.checkpoints_path, 320)),
      handoff_path: path.isAbsolute(cleanText(hardening.handoff_path || baseHardening.handoff_path, 320))
        ? cleanText(hardening.handoff_path || baseHardening.handoff_path, 320)
        : path.join(ROOT, cleanText(hardening.handoff_path || baseHardening.handoff_path, 320))
    },
    computer_use_execution_verification: {
      enabled: verification.enabled !== false,
      protected_adapter_kinds: Array.isArray(verification.protected_adapter_kinds)
        ? verification.protected_adapter_kinds.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : baseVerification.protected_adapter_kinds.slice(0),
      max_verify_attempts: Math.max(
        0,
        Math.min(
          5,
          Number(
            verification.max_verify_attempts != null
              ? verification.max_verify_attempts
              : baseVerification.max_verify_attempts
          ) || baseVerification.max_verify_attempts
        )
      ),
      fail_closed: verification.fail_closed !== false,
      require_success_markers: verification.require_success_markers === true,
      success_markers: Array.isArray(verification.success_markers)
        ? verification.success_markers.map((row: unknown) => cleanText(row, 80).toLowerCase()).filter(Boolean)
        : baseVerification.success_markers.slice(0),
      failure_markers: Array.isArray(verification.failure_markers)
        ? verification.failure_markers.map((row: unknown) => cleanText(row, 80).toLowerCase()).filter(Boolean)
        : baseVerification.failure_markers.slice(0),
      expected_outcome_keys: Array.isArray(verification.expected_outcome_keys)
        ? verification.expected_outcome_keys.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : baseVerification.expected_outcome_keys.slice(0),
      receipts_path: path.isAbsolute(cleanText(verification.receipts_path || baseVerification.receipts_path, 320))
        ? cleanText(verification.receipts_path || baseVerification.receipts_path, 320)
        : path.join(ROOT, cleanText(verification.receipts_path || baseVerification.receipts_path, 320))
    },
    computer_use_reliability_metrics: {
      enabled: reliabilityMetrics.enabled !== false,
      tracked_adapter_kinds: Array.isArray(reliabilityMetrics.tracked_adapter_kinds)
        ? reliabilityMetrics.tracked_adapter_kinds.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : baseReliability.tracked_adapter_kinds.slice(0),
      suite_keys: Array.isArray(reliabilityMetrics.suite_keys)
        ? reliabilityMetrics.suite_keys.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : baseReliability.suite_keys.slice(0),
      case_keys: Array.isArray(reliabilityMetrics.case_keys)
        ? reliabilityMetrics.case_keys.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : baseReliability.case_keys.slice(0),
      rolling_window: Math.max(10, Math.min(10_000, Number(reliabilityMetrics.rolling_window || baseReliability.rolling_window))),
      target_success_rate: Math.max(0, Math.min(1, Number(reliabilityMetrics.target_success_rate || baseReliability.target_success_rate))),
      webarena_aliases: Array.isArray(reliabilityMetrics.webarena_aliases)
        ? reliabilityMetrics.webarena_aliases.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : baseReliability.webarena_aliases.slice(0),
      metrics_path: path.isAbsolute(cleanText(reliabilityMetrics.metrics_path || baseReliability.metrics_path, 320))
        ? cleanText(reliabilityMetrics.metrics_path || baseReliability.metrics_path, 320)
        : path.join(ROOT, cleanText(reliabilityMetrics.metrics_path || baseReliability.metrics_path, 320))
    },
    receipts_path: path.isAbsolute(cleanText(src.receipts_path || base.receipts_path, 260))
      ? cleanText(src.receipts_path || base.receipts_path, 260)
      : path.join(ROOT, cleanText(src.receipts_path || base.receipts_path, 260))
  };
}

function findProfileById(profileId: string, roots: string[]) {
  const targetId = normalizeToken(profileId, 160);
  if (!targetId) return null;
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const entries = fs.readdirSync(root).filter((row: string) => row.endsWith('.json')).sort();
    for (const fileName of entries) {
      const abs = path.join(root, fileName);
      const profile = readJson(abs, null);
      if (!profile || typeof profile !== 'object') continue;
      const id = normalizeToken(profile.profile_id || profile.capability_id || profile.source && profile.source.capability_id || '', 160);
      if (id && id === targetId) return { profile, profile_path: abs };
    }
  }
  return null;
}

function loadProfile(args: AnyObj, policy: AnyObj) {
  const profileJsonArg = args.profile_json || args['profile-json'] || '';
  if (profileJsonArg) {
    const profile = parseJsonArg(profileJsonArg, null);
    if (!profile || typeof profile !== 'object') return { ok: false, error: 'invalid_profile_json' };
    return {
      ok: true,
      profile,
      profile_path: String(profileJsonArg).startsWith('@') ? path.resolve(String(profileJsonArg).slice(1)) : null
    };
  }
  const profileId = cleanText(args.profile_id || args['profile-id'] || '', 160);
  if (!profileId) return { ok: false, error: 'profile_id_required' };
  const found = findProfileById(profileId, policy.profile_roots || []);
  if (!found) return { ok: false, error: 'profile_not_found', profile_id: normalizeToken(profileId, 160), search_roots: policy.profile_roots || [] };
  return {
    ok: true,
    profile: found.profile,
    profile_path: found.profile_path
  };
}

function resolveAdapterKind(profile: AnyObj, intent: string, policy: AnyObj) {
  const explicit = normalizeToken(profile && profile.execution && profile.execution.adapter_kind, 80);
  if (explicit) return { kind: explicit, source: 'profile.execution.adapter_kind' };
  const intentKey = normalizeToken(intent, 80);
  const intentMap = policy.intent_adapter_map && typeof policy.intent_adapter_map === 'object'
    ? policy.intent_adapter_map
    : {};
  if (intentKey && intentMap[intentKey]) {
    return {
      kind: normalizeToken(intentMap[intentKey], 80),
      source: `policy.intent_adapter_map.${intentKey}`
    };
  }
  const sourceType = normalizeToken(profile && profile.source && profile.source.source_type, 80);
  const sourceMap = policy.source_type_adapter_map && typeof policy.source_type_adapter_map === 'object'
    ? policy.source_type_adapter_map
    : {};
  if (sourceType && sourceMap[sourceType]) {
    return {
      kind: normalizeToken(sourceMap[sourceType], 80),
      source: `policy.source_type_adapter_map.${sourceType}`
    };
  }
  return {
    kind: normalizeToken(policy.default_adapter_kind, 80) || 'http_request',
    source: 'policy.default_adapter_kind'
  };
}

function parseExecutorPayload(stdout: string) {
  const lines = String(stdout || '')
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function parseChildJson(stdout: string) {
  const lines = String(stdout || '')
    .split('\n')
    .map((row) => row.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function containsVerificationKeyword(hints: string, keywords: string[]) {
  const haystack = String(hints || '').toLowerCase();
  if (!haystack) return false;
  for (const kwRaw of Array.isArray(keywords) ? keywords : []) {
    const kw = cleanText(kwRaw, 80).toLowerCase();
    if (!kw) continue;
    if (haystack.includes(kw)) return true;
  }
  return false;
}

function gatherVerificationEvidence(payload: AnyObj) {
  const out: string[] = [];
  if (!payload || typeof payload !== 'object') return out;
  const push = (v: unknown, maxLen = 240) => {
    const txt = cleanText(v, maxLen).toLowerCase();
    if (txt) out.push(txt);
  };
  push(payload.message);
  push(payload.result);
  push(payload.result_text);
  push(payload.output);
  push(payload.summary && payload.summary.reason);
  if (payload.data != null) push(JSON.stringify(payload.data), 800);
  if (payload.value != null) push(JSON.stringify(payload.value), 800);
  if (payload.response != null) push(JSON.stringify(payload.response), 800);
  return out;
}

function resolveExpectedOutcomes(cfg: AnyObj, params: AnyObj, contextRaw: AnyObj) {
  const keys = Array.isArray(cfg.expected_outcome_keys)
    ? cfg.expected_outcome_keys
    : [];
  const out: string[] = [];
  const push = (v: unknown) => {
    const txt = cleanText(v, 120).toLowerCase();
    if (txt) out.push(txt);
  };
  for (const keyRaw of keys) {
    const key = normalizeToken(keyRaw, 80);
    if (!key) continue;
    if (params && typeof params === 'object') push((params as AnyObj)[key]);
    if (contextRaw && typeof contextRaw === 'object') push((contextRaw as AnyObj)[key]);
  }
  return Array.from(new Set(out)).slice(0, 12);
}

function buildExecutionVerificationProfile(policy: AnyObj, adapterKind: string, params: AnyObj, contextRaw: AnyObj) {
  const cfg = policy && policy.computer_use_execution_verification
    && typeof policy.computer_use_execution_verification === 'object'
    ? policy.computer_use_execution_verification
    : {};
  const protectedKinds = Array.isArray(cfg.protected_adapter_kinds)
    ? cfg.protected_adapter_kinds.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : [];
  const protectedAdapter = cfg.enabled === true && protectedKinds.includes(normalizeToken(adapterKind, 80));
  return {
    enabled: protectedAdapter,
    max_verify_attempts: Math.max(0, Number(cfg.max_verify_attempts || 0)),
    fail_closed: cfg.fail_closed !== false,
    require_success_markers: cfg.require_success_markers === true,
    success_markers: Array.isArray(cfg.success_markers) ? cfg.success_markers.map((row: unknown) => cleanText(row, 80).toLowerCase()).filter(Boolean) : [],
    failure_markers: Array.isArray(cfg.failure_markers) ? cfg.failure_markers.map((row: unknown) => cleanText(row, 80).toLowerCase()).filter(Boolean) : [],
    expected_outcomes: resolveExpectedOutcomes(cfg, params, contextRaw),
    receipts_path: cleanText(cfg.receipts_path || '', 320) || null
  };
}

function evaluateExecutionVerification(profile: AnyObj, run: AnyObj, payload: AnyObj) {
  if (!profile || profile.enabled !== true) {
    return {
      enabled: false,
      passed: true,
      reason_codes: [],
      expected_outcomes: []
    };
  }
  const reasonCodes: string[] = [];
  if (!run || run.ok !== true) reasonCodes.push('executor_failed');
  if (payload && payload.ok === false) reasonCodes.push('payload_not_ok');
  const payloadError = cleanText(payload && payload.error || '', 180);
  if (payloadError) reasonCodes.push('payload_error_present');

  const evidenceRows = gatherVerificationEvidence(payload);
  const evidenceBlob = evidenceRows.join(' ');
  const successMatches = (Array.isArray(profile.success_markers) ? profile.success_markers : [])
    .filter((marker: string) => marker && evidenceBlob.includes(marker));
  const failureMatches = (Array.isArray(profile.failure_markers) ? profile.failure_markers : [])
    .filter((marker: string) => marker && evidenceBlob.includes(marker));
  if (failureMatches.length) reasonCodes.push('failure_marker_detected');
  if (profile.require_success_markers === true && successMatches.length === 0) {
    reasonCodes.push('success_marker_missing');
  }
  const expectedOutcomes = Array.isArray(profile.expected_outcomes) ? profile.expected_outcomes : [];
  const missingExpected = expectedOutcomes.filter((token: string) => !evidenceBlob.includes(token));
  if (missingExpected.length) reasonCodes.push('expected_outcome_not_observed');

  return {
    enabled: true,
    passed: reasonCodes.length === 0,
    reason_codes: reasonCodes,
    payload_error: payloadError || null,
    success_markers_matched: successMatches,
    failure_markers_matched: failureMatches,
    expected_outcomes: expectedOutcomes,
    expected_outcomes_missing: missingExpected
  };
}

function readTokenByKeys(params: AnyObj, contextRaw: AnyObj, keys: string[]) {
  for (const keyRaw of Array.isArray(keys) ? keys : []) {
    const key = normalizeToken(keyRaw, 80);
    if (!key) continue;
    const fromParams = cleanText(params && params[key], 140);
    if (fromParams) return normalizeToken(fromParams, 140);
    const fromContext = cleanText(contextRaw && contextRaw[key], 140);
    if (fromContext) return normalizeToken(fromContext, 140);
  }
  return null;
}

function loadComputerUseMetricsState(metricsPath: string, rollingWindow: number) {
  const src = readJson(metricsPath, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'computer_use_reliability_metrics',
      schema_version: '1.0',
      updated_at: null,
      rolling_window: Math.max(10, Number(rollingWindow || 500)),
      events: []
    };
  }
  return {
    schema_id: 'computer_use_reliability_metrics',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || '', 40) || null,
    rolling_window: Math.max(10, Number(src.rolling_window || rollingWindow || 500)),
    events: Array.isArray(src.events) ? src.events : []
  };
}

function summarizeComputerUseMetrics(state: AnyObj, aliases: string[]) {
  const events = Array.isArray(state && state.events) ? state.events : [];
  const suites: Record<string, AnyObj> = {};
  let success = 0;
  let total = 0;
  for (const row of events) {
    if (!row || typeof row !== 'object') continue;
    const suite = normalizeToken(row.suite_id || 'unknown', 120) || 'unknown';
    if (!suites[suite]) suites[suite] = { total: 0, success: 0 };
    suites[suite].total += 1;
    total += 1;
    if (row.ok === true) {
      suites[suite].success += 1;
      success += 1;
    }
  }
  const suiteSummary = Object.entries(suites)
    .map(([suite_id, row]: [string, AnyObj]) => ({
      suite_id,
      total_runs: Number(row.total || 0),
      successful_runs: Number(row.success || 0),
      success_rate: Number(row.total > 0 ? (row.success / row.total).toFixed(6) : 0)
    }))
    .sort((a, b) => b.total_runs - a.total_runs)
    .slice(0, 50);
  const normalizedAliases = Array.isArray(aliases)
    ? aliases.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : [];
  const aliasRows = suiteSummary.filter((row: AnyObj) => normalizedAliases.some((alias) => row.suite_id.includes(alias)));
  const aliasTotal = aliasRows.reduce((acc: number, row: AnyObj) => acc + Number(row.total_runs || 0), 0);
  const aliasSuccess = aliasRows.reduce((acc: number, row: AnyObj) => acc + Number(row.successful_runs || 0), 0);
  return {
    total_runs: total,
    successful_runs: success,
    success_rate: Number(total > 0 ? (success / total).toFixed(6) : 0),
    suites: suiteSummary,
    webarena_like_total_runs: aliasTotal,
    webarena_like_success_rate: Number(aliasTotal > 0 ? (aliasSuccess / aliasTotal).toFixed(6) : 0)
  };
}

function updateComputerUseMetrics(
  policy: AnyObj,
  adapterKind: string,
  params: AnyObj,
  contextRaw: AnyObj,
  finalOk: boolean
) {
  const cfg = policy && policy.computer_use_reliability_metrics
    && typeof policy.computer_use_reliability_metrics === 'object'
    ? policy.computer_use_reliability_metrics
    : {};
  const trackedKinds = Array.isArray(cfg.tracked_adapter_kinds)
    ? cfg.tracked_adapter_kinds.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : [];
  const tracked = cfg.enabled === true && trackedKinds.includes(normalizeToken(adapterKind, 80));
  if (!tracked) {
    return {
      tracked: false
    };
  }
  const metricsPath = cleanText(cfg.metrics_path || '', 320) || path.join(ROOT, 'state', 'actuation', 'universal_execution_primitive', 'computer_use_metrics.json');
  const rollingWindow = Math.max(10, Number(cfg.rolling_window || 500));
  const suiteId = readTokenByKeys(params, contextRaw, cfg.suite_keys || []) || 'unspecified_suite';
  const caseId = readTokenByKeys(params, contextRaw, cfg.case_keys || []) || null;
  const state = loadComputerUseMetricsState(metricsPath, rollingWindow);
  state.rolling_window = rollingWindow;
  state.events = (Array.isArray(state.events) ? state.events : [])
    .concat([{
      ts: nowIso(),
      adapter_kind: normalizeToken(adapterKind, 80),
      suite_id: suiteId,
      case_id: caseId,
      ok: finalOk === true
    }])
    .slice(-rollingWindow);
  state.updated_at = nowIso();
  const summary = summarizeComputerUseMetrics(state, cfg.webarena_aliases || []);
  state.summary = summary;
  writeJsonAtomic(metricsPath, state);
  const suiteRow = Array.isArray(summary.suites)
    ? summary.suites.find((row: AnyObj) => row && row.suite_id === suiteId) || null
    : null;
  return {
    tracked: true,
    suite_id: suiteId,
    case_id: caseId,
    metrics_path: relPath(metricsPath),
    target_success_rate: Number(cfg.target_success_rate || 0.7),
    overall_success_rate: Number(summary.success_rate || 0),
    suite_success_rate: suiteRow ? Number(suiteRow.success_rate || 0) : Number(summary.success_rate || 0),
    webarena_like_success_rate: Number(summary.webarena_like_success_rate || 0),
    webarena_like_total_runs: Number(summary.webarena_like_total_runs || 0),
    meets_target: Number(summary.success_rate || 0) >= Number(cfg.target_success_rate || 0.7)
  };
}

function buildComputerUseHardeningProfile(policy: AnyObj, adapterKind: string, params: AnyObj, contextRaw: AnyObj, dryRun: boolean) {
  const cfg = policy && policy.computer_use_hardening && typeof policy.computer_use_hardening === 'object'
    ? policy.computer_use_hardening
    : {};
  const protectedKinds = Array.isArray(cfg.protected_adapter_kinds)
    ? cfg.protected_adapter_kinds.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : [];
  const protectedAdapter = cfg.enabled === true && protectedKinds.includes(normalizeToken(adapterKind, 80));
  const contextSession = cleanText(contextRaw && contextRaw.session_id || '', 160) || null;
  const paramSession = cleanText(params && params.session_id || '', 160) || null;
  const sessionId = contextSession || paramSession;
  const existingCheckpointId = cleanText(
    contextRaw && (contextRaw.checkpoint_id || contextRaw.session_checkpoint_id)
    || params && params.checkpoint_id
    || '',
    160
  ) || null;
  const checkpointId = existingCheckpointId || `chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
  const checks = {
    session_id_present: protectedAdapter
      ? (cfg.require_session_id !== true || !!sessionId)
      : true,
    checkpoint_id_present: protectedAdapter
      ? (cfg.require_checkpoint_for_apply !== true || dryRun === true || !!checkpointId)
      : true
  };
  const verificationHints = JSON.stringify({
    params: params || {},
    context: contextRaw || {}
  });
  const verificationDetected = protectedAdapter
    && containsVerificationKeyword(verificationHints, cfg.verification_keywords || []);
  const assertionFailed = protectedAdapter && (!checks.session_id_present || !checks.checkpoint_id_present);
  return {
    enabled: cfg.enabled === true,
    protected_adapter: protectedAdapter,
    session_id: sessionId,
    checkpoint_id: checkpointId,
    verification_detected: verificationDetected,
    checks,
    assertion_failed: assertionFailed,
    assertion_reason: assertionFailed
      ? (!checks.session_id_present ? 'session_id_required' : 'checkpoint_required')
      : null
  };
}

function runExecutorOnce(adapterKind: string, params: AnyObj, context: AnyObj, dryRun: boolean) {
  const execArgs = [
    ACTUATION_EXECUTOR,
    'run',
    `--kind=${adapterKind}`,
    `--params=${JSON.stringify(params)}`,
    `--context=${JSON.stringify(context)}`
  ];
  if (dryRun) execArgs.push('--dry-run');
  const proc = spawnSync('node', execArgs, {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  const payload = parseExecutorPayload(String(proc.stdout || '')) || {};
  const ok = Number(proc.status || 0) === 0 && payload && payload.ok === true;
  return {
    ok,
    status: Number(proc.status == null ? 1 : proc.status),
    payload,
    stderr: cleanText(proc.stderr || '', 500)
  };
}

function maybeProposeSubExecutor(policy: AnyObj, input: AnyObj) {
  const cfg = policy && policy.sub_executor_synthesis && typeof policy.sub_executor_synthesis === 'object'
    ? policy.sub_executor_synthesis
    : {};
  if (cfg.enabled !== true) return null;
  const errorCode = normalizeToken(input.error_code || '', 80);
  const allow = Array.isArray(cfg.auto_propose_on_errors)
    ? cfg.auto_propose_on_errors.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : [];
  if (!errorCode || (allow.length && !allow.includes(errorCode))) return null;
  const profileId = normalizeToken(input.profile_id || '', 160);
  if (!profileId) return null;
  const scriptPath = cleanText(cfg.script_path || SUB_EXECUTOR_SYNTHESIS, 320) || SUB_EXECUTOR_SYNTHESIS;
  if (!fs.existsSync(scriptPath)) return null;
  const riskRaw = cfg.risk_class_by_error && typeof cfg.risk_class_by_error === 'object'
    ? cfg.risk_class_by_error[errorCode]
    : null;
  const riskClass = normalizeToken(riskRaw || 'low', 20) || 'low';
  const intent = normalizeToken(input.intent || '', 80) || 'unknown_intent';
  const failureReason = cleanText(input.failure_reason || errorCode || 'executor_failed', 200) || 'executor_failed';
  const proc = spawnSync('node', [
    scriptPath,
    'propose',
    `--profile-id=${profileId}`,
    `--intent=${intent}`,
    `--failure-reason=${failureReason}`,
    `--risk-class=${riskClass}`
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  const payload = parseChildJson(String(proc.stdout || ''));
  if (Number(proc.status || 0) !== 0 || !payload || payload.ok !== true) {
    return {
      ok: false,
      error: payload && payload.error ? payload.error : 'sub_executor_propose_failed',
      status: Number(proc.status == null ? 1 : proc.status),
      payload
    };
  }
  const candidate = payload && payload.candidate && typeof payload.candidate === 'object'
    ? payload.candidate
    : {};
  return {
    ok: true,
    reused: payload.reused === true,
    candidate_id: cleanText(candidate.candidate_id || '', 80) || null,
    candidate_status: cleanText(candidate.status || '', 40) || null,
    payload
  };
}

function receiptPath(policy: AnyObj, day = dayStr()) {
  return path.join(policy.receipts_path, `${day}.jsonl`);
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'universal_execution_primitive', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const profileLoad = loadProfile(args, policy);
  if (!profileLoad.ok) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'universal_execution_primitive', error: profileLoad.error, profile_id: profileLoad.profile_id || null })}\n`);
    process.exit(1);
  }
  const profile = profileLoad.profile && typeof profileLoad.profile === 'object' ? profileLoad.profile : {};
  const profileId = normalizeToken(profile.profile_id || profile.capability_id || profile.source && profile.source.capability_id || '', 160);
  if (!profileId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'universal_execution_primitive', error: 'profile_id_missing' })}\n`);
    process.exit(1);
  }
  const provenance = profile.provenance && typeof profile.provenance === 'object' ? profile.provenance : {};
  const profileConfidence = Math.max(0, Math.min(1, Number(provenance.confidence != null ? provenance.confidence : 0) || 0));
  if (profileConfidence < Number(policy.min_profile_confidence || 0)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'universal_execution_primitive',
      error: 'profile_confidence_below_minimum',
      profile_id: profileId,
      confidence: profileConfidence,
      min_required: Number(policy.min_profile_confidence || 0)
    })}\n`);
    process.exit(1);
  }

  const intent = normalizeToken(args.intent || '', 80);
  const adapter = resolveAdapterKind(profile, intent, policy);
  if (!adapter.kind) {
    const synthesis = maybeProposeSubExecutor(policy, {
      error_code: 'adapter_kind_unresolved',
      profile_id: profileId,
      intent,
      failure_reason: 'adapter_kind_unresolved'
    });
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'universal_execution_primitive',
      error: 'adapter_kind_unresolved',
      profile_id: profileId,
      sub_executor_candidate: synthesis && synthesis.ok === true ? synthesis : null
    })}\n`);
    process.exit(1);
  }
  const allowedKinds = Array.isArray(policy.allowed_adapter_kinds) ? policy.allowed_adapter_kinds : [];
  if (allowedKinds.length && !allowedKinds.includes(adapter.kind)) {
    const synthesis = maybeProposeSubExecutor(policy, {
      error_code: 'adapter_kind_not_allowed',
      profile_id: profileId,
      intent,
      failure_reason: `adapter_kind_not_allowed:${adapter.kind}`
    });
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'universal_execution_primitive',
      error: 'adapter_kind_not_allowed',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      sub_executor_candidate: synthesis && synthesis.ok === true ? synthesis : null
    })}\n`);
    process.exit(1);
  }

  const params = parseJsonArg(args.params, null);
  if (!params || typeof params !== 'object' || Array.isArray(params)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'universal_execution_primitive', error: 'invalid_params_json' })}\n`);
    process.exit(2);
  }
  const contextRaw = parseJsonArg(args.context, {});
  if (!contextRaw || typeof contextRaw !== 'object' || Array.isArray(contextRaw)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'universal_execution_primitive', error: 'invalid_context_json' })}\n`);
    process.exit(2);
  }
  const dryRun = args['dry-run'] === true;
  const profileHash = cleanText(profile.profile_hash || '', 80) || shaHex(profile).slice(0, 64);
  const passportLink = cleanText(
    contextRaw.passport_id
    || contextRaw.passport_link_id
    || contextRaw.passport_receipt_id
    || '',
    180
  ) || null;
  const context = {
    ...contextRaw,
    capability_profile: {
      profile_id: profileId,
      profile_hash: profileHash,
      source_type: normalizeToken(profile && profile.source && profile.source.source_type, 80) || null,
      adapter_kind: adapter.kind,
      adapter_resolution_source: adapter.source,
      confidence: profileConfidence
    },
    passport_link_id: passportLink
  };
  const hardening = buildComputerUseHardeningProfile(policy, adapter.kind, params, contextRaw, dryRun);
  if (hardening.protected_adapter) {
    appendJsonl(policy.computer_use_hardening.checkpoints_path, {
      ts: nowIso(),
      type: 'computer_use_checkpoint',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      checkpoint_id: hardening.checkpoint_id,
      session_id: hardening.session_id || null,
      assertion_failed: hardening.assertion_failed === true,
      assertion_reason: hardening.assertion_reason || null
    });
  }
  if (hardening.assertion_failed) {
    const out = {
      ok: false,
      type: 'universal_execution_primitive',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      error: `computer_use_assertion_failed:${hardening.assertion_reason || 'unknown'}`,
      hardening: {
        protected_adapter: true,
        checks: hardening.checks,
        session_id: hardening.session_id || null,
        checkpoint_id: hardening.checkpoint_id || null
      }
    };
    appendJsonl(receiptPath(policy), {
      ts: nowIso(),
      type: 'universal_execution_primitive',
      profile_id: profileId,
      profile_hash: profileHash,
      profile_path: profileLoad.profile_path ? relPath(String(profileLoad.profile_path)) : null,
      profile_confidence: profileConfidence,
      intent: intent || null,
      adapter_kind: adapter.kind,
      adapter_resolution_source: adapter.source,
      dry_run: dryRun,
      passport_link_id: passportLink,
      params_hash: shaHex(params).slice(0, 16),
      ok: false,
      executor_status: 1,
      executor_payload: null,
      hardening_protected: true,
      hardening_checks: hardening.checks,
      hardening_assertion_reason: hardening.assertion_reason || null
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }

  const contextWithHardening = {
    ...context,
    computer_use_hardening: {
      enabled: hardening.enabled,
      protected_adapter: hardening.protected_adapter,
      session_id: hardening.session_id || null,
      checkpoint_id: hardening.checkpoint_id || null,
      verification_detected: hardening.verification_detected === true,
      max_recovery_attempts: Number(policy.computer_use_hardening.max_recovery_attempts || 0)
    }
  };
  if (hardening.verification_detected && policy.computer_use_hardening.handoff_required_on_verification === true) {
    const handoff = {
      ts: nowIso(),
      type: 'computer_use_handoff_required',
      reason: 'verification_detected',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      session_id: hardening.session_id || null,
      checkpoint_id: hardening.checkpoint_id || null
    };
    appendJsonl(policy.computer_use_hardening.handoff_path, handoff);
    appendJsonl(receiptPath(policy), {
      ts: nowIso(),
      type: 'universal_execution_primitive',
      profile_id: profileId,
      profile_hash: profileHash,
      profile_path: profileLoad.profile_path ? relPath(String(profileLoad.profile_path)) : null,
      profile_confidence: profileConfidence,
      intent: intent || null,
      adapter_kind: adapter.kind,
      adapter_resolution_source: adapter.source,
      dry_run: dryRun,
      passport_link_id: passportLink,
      params_hash: shaHex(params).slice(0, 16),
      ok: false,
      executor_status: 1,
      executor_payload: null,
      verification_handoff_required: true,
      hardening_protected: hardening.protected_adapter === true
    });
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'universal_execution_primitive',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      error: 'verification_handoff_required',
      handoff
    })}\n`);
    process.exit(1);
  }

  const maxRecoveryAttempts = hardening.protected_adapter
    ? Number(policy.computer_use_hardening.max_recovery_attempts || 0)
    : 0;
  let recoveryAttempts = 0;
  let recoveryApplied = false;
  let run = runExecutorOnce(adapter.kind, params, contextWithHardening, dryRun);
  while (!run.ok && recoveryAttempts < maxRecoveryAttempts) {
    recoveryAttempts += 1;
    recoveryApplied = true;
    const retryParams = {
      ...params,
      session_resume: true,
      recovery_attempt: recoveryAttempts
    };
    const retryContext = {
      ...contextWithHardening,
      computer_use_hardening: {
        ...(contextWithHardening.computer_use_hardening || {}),
        recovery_attempt: recoveryAttempts,
        recovery_applied: true
      }
    };
    run = runExecutorOnce(adapter.kind, retryParams, retryContext, dryRun);
    if (run.ok) break;
  }

  let payload = run.payload || {};
  const executionVerificationProfile = buildExecutionVerificationProfile(policy, adapter.kind, params, contextRaw);
  let verificationAttempts = 0;
  let verificationApplied = false;
  let executionVerification = evaluateExecutionVerification(executionVerificationProfile, run, payload);
  while (
    run.ok === true
    && executionVerification.enabled === true
    && executionVerification.passed !== true
    && verificationAttempts < Number(executionVerificationProfile.max_verify_attempts || 0)
  ) {
    verificationAttempts += 1;
    verificationApplied = true;
    const verifyParams = {
      ...params,
      verification_retry: true,
      verification_attempt: verificationAttempts
    };
    const verifyContext = {
      ...contextWithHardening,
      computer_use_execution_verification: {
        enabled: true,
        verification_attempt: verificationAttempts,
        expected_outcomes: executionVerificationProfile.expected_outcomes
      }
    };
    run = runExecutorOnce(adapter.kind, verifyParams, verifyContext, dryRun);
    payload = run.payload || {};
    executionVerification = evaluateExecutionVerification(executionVerificationProfile, run, payload);
    if (run.ok !== true) break;
  }

  const ok = run.ok === true;
  const failureError = payload && payload.error
    ? cleanText(payload.error, 160)
    : (run.stderr || 'executor_failed');
  const failureHints = JSON.stringify({
    payload,
    error: failureError
  });
  const verificationFailure = hardening.protected_adapter
    && containsVerificationKeyword(failureHints, policy.computer_use_hardening.verification_keywords || []);
  if (!ok && verificationFailure && policy.computer_use_hardening.handoff_required_on_verification === true) {
    appendJsonl(policy.computer_use_hardening.handoff_path, {
      ts: nowIso(),
      type: 'computer_use_handoff_required',
      reason: 'verification_failure',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      session_id: hardening.session_id || null,
      checkpoint_id: hardening.checkpoint_id || null,
      recovery_attempts: recoveryAttempts
    });
  }
  const verificationFailedHard = executionVerification.enabled === true
    && executionVerification.passed !== true
    && executionVerificationProfile.fail_closed === true;
  const finalOk = ok && !verificationFailedHard;
  if (executionVerification.enabled === true && executionVerificationProfile.receipts_path) {
    appendJsonl(executionVerificationProfile.receipts_path, {
      ts: nowIso(),
      type: 'computer_use_execution_verification',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      run_ok: ok === true,
      verification_ok: executionVerification.passed === true,
      verification_fail_closed: executionVerificationProfile.fail_closed === true,
      verification_attempts: verificationAttempts,
      verification_applied: verificationApplied,
      reason_codes: Array.isArray(executionVerification.reason_codes)
        ? executionVerification.reason_codes
        : [],
      success_markers_matched: executionVerification.success_markers_matched || [],
      failure_markers_matched: executionVerification.failure_markers_matched || [],
      expected_outcomes: executionVerification.expected_outcomes || [],
      expected_outcomes_missing: executionVerification.expected_outcomes_missing || []
    });
  }
  const computerUseReliability = updateComputerUseMetrics(
    policy,
    adapter.kind,
    params,
    contextRaw,
    finalOk
  );
  const row = {
    ts: nowIso(),
    type: 'universal_execution_primitive',
    profile_id: profileId,
    profile_hash: profileHash,
    profile_path: profileLoad.profile_path ? relPath(String(profileLoad.profile_path)) : null,
    profile_confidence: profileConfidence,
    intent: intent || null,
    adapter_kind: adapter.kind,
    adapter_resolution_source: adapter.source,
    dry_run: dryRun,
    passport_link_id: passportLink,
    params_hash: shaHex(params).slice(0, 16),
    ok: finalOk,
    executor_status: Number(run.status == null ? 1 : run.status),
    executor_payload: payload,
    hardening_protected: hardening.protected_adapter === true,
    hardening_checks: hardening.checks,
    hardening_checkpoint_id: hardening.checkpoint_id || null,
    hardening_session_id_present: !!hardening.session_id,
    recovery_attempts: recoveryAttempts,
    recovery_applied: recoveryApplied,
    verification_handoff_required: !ok && verificationFailure,
    execution_verification_enabled: executionVerification.enabled === true,
    execution_verification_ok: executionVerification.passed === true,
    execution_verification_reason_codes: Array.isArray(executionVerification.reason_codes)
      ? executionVerification.reason_codes
      : [],
    execution_verification_attempts: verificationAttempts,
    execution_verification_applied: verificationApplied,
    computer_use_reliability: computerUseReliability
  };
  if (!finalOk) {
    const errorSummary = verificationFailedHard
      ? 'execution_verification_failed'
      : failureError;
    const synthesis = maybeProposeSubExecutor(policy, {
      error_code: 'executor_failed',
      profile_id: profileId,
      intent,
      failure_reason: errorSummary
    });
    if (synthesis && synthesis.ok === true) {
      row.sub_executor_candidate_id = synthesis.candidate_id || null;
      row.sub_executor_candidate_status = synthesis.candidate_status || null;
      row.sub_executor_candidate_reused = synthesis.reused === true;
    }
    appendJsonl(receiptPath(policy), row);
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'universal_execution_primitive',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      error: errorSummary,
      sub_executor_candidate: synthesis && synthesis.ok === true ? synthesis : null,
      execution_verification: executionVerification,
      computer_use_reliability: computerUseReliability,
      row
    })}\n`);
    process.exit(Number(run.status == null ? 1 : run.status) || 1);
  }
  appendJsonl(receiptPath(policy), row);
  process.stdout.write(`${JSON.stringify({
    ok: true,
      type: 'universal_execution_primitive',
      profile_id: profileId,
      adapter_kind: adapter.kind,
      computer_use_reliability: computerUseReliability,
      row
    })}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const key = cleanText(args._[1] || args.day || args.date || 'latest', 40);
  const day = key === 'latest' ? dayStr() : key;
  const rows = readJsonl(receiptPath(policy, day));
  const adapterCounts: Record<string, number> = {};
  let okCount = 0;
  let profileBased = 0;
  let hardeningProtectedRuns = 0;
  let handoffRequiredRuns = 0;
  let recoveryAppliedRuns = 0;
  let executionVerificationRuns = 0;
  let executionVerificationFailedRuns = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const adapter = normalizeToken(row.adapter_kind || '', 80) || 'unknown';
    adapterCounts[adapter] = Number(adapterCounts[adapter] || 0) + 1;
    if (row.ok === true) okCount += 1;
    if (row.profile_id) profileBased += 1;
    if (row.hardening_protected === true) hardeningProtectedRuns += 1;
    if (row.verification_handoff_required === true) handoffRequiredRuns += 1;
    if (row.recovery_applied === true) recoveryAppliedRuns += 1;
    if (row.execution_verification_enabled === true) executionVerificationRuns += 1;
    if (row.execution_verification_enabled === true && row.execution_verification_ok !== true) {
      executionVerificationFailedRuns += 1;
    }
  }
  const metricsCfg = policy.computer_use_reliability_metrics
    && typeof policy.computer_use_reliability_metrics === 'object'
    ? policy.computer_use_reliability_metrics
    : {};
  const metricsPath = cleanText(metricsCfg.metrics_path || '', 320);
  const metricsState = metricsPath ? readJson(metricsPath, null) : null;
  const metricsSummary = metricsState && typeof metricsState === 'object' && metricsState.summary
    ? metricsState.summary
    : summarizeComputerUseMetrics(
      loadComputerUseMetricsState(metricsPath || path.join(ROOT, 'state', 'actuation', 'universal_execution_primitive', 'computer_use_metrics.json'), Number(metricsCfg.rolling_window || 500)),
      metricsCfg.webarena_aliases || []
    );
  const out = {
    ok: true,
    type: 'universal_execution_primitive_status',
    ts: nowIso(),
    day,
    receipt_path: relPath(receiptPath(policy, day)),
    total_runs: rows.length,
    successful_runs: okCount,
    profile_based_runs: profileBased,
    profile_only_ratio: rows.length > 0 ? Number((profileBased / rows.length).toFixed(6)) : 0,
    adapter_counts: adapterCounts,
    hardening_protected_runs: hardeningProtectedRuns,
    verification_handoff_required_runs: handoffRequiredRuns,
    recovery_applied_runs: recoveryAppliedRuns,
    execution_verification_runs: executionVerificationRuns,
    execution_verification_failed_runs: executionVerificationFailedRuns,
    computer_use_reliability: {
      enabled: metricsCfg.enabled !== false,
      target_success_rate: Number(metricsCfg.target_success_rate || 0.7),
      metrics_path: metricsPath ? relPath(metricsPath) : null,
      overall_success_rate: Number(metricsSummary.success_rate || 0),
      overall_total_runs: Number(metricsSummary.total_runs || 0),
      webarena_like_success_rate: Number(metricsSummary.webarena_like_success_rate || 0),
      webarena_like_total_runs: Number(metricsSummary.webarena_like_total_runs || 0),
      meets_target: Number(metricsSummary.success_rate || 0) >= Number(metricsCfg.target_success_rate || 0.7)
    }
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
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
