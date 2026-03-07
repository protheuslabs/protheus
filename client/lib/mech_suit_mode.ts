'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_POLICY_REL = path.join('config', 'mech_suit_mode_policy.json');

function repoRoot(rootOverride = null) {
  if (rootOverride) return path.resolve(String(rootOverride));
  return path.resolve(__dirname, '..');
}

function readJsonSafe(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function writeJson(filePath, value) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function boolFromEnv(value, fallback) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function text(value, maxLen = 240) {
  return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeRelPath(value, fallback) {
  const raw = text(value, 400);
  return raw || fallback;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    state: {
      status_path: 'state/ops/mech_suit_mode/latest.json',
      history_path: 'state/ops/mech_suit_mode/history.jsonl'
    },
    spine: {
      heartbeat_hours: 4,
      manual_triggers_allowed: false,
      quiet_non_critical: true,
      silent_subprocess_output: true,
      critical_patterns: ['critical', 'fail', 'failed', 'emergency', 'blocked', 'halt', 'violation', 'integrity', 'outage']
    },
    eyes: {
      push_attention_queue: true,
      quiet_non_critical: true,
      attention_queue_path: 'state/attention/queue.jsonl',
      receipts_path: 'state/attention/receipts.jsonl',
      latest_path: 'state/attention/latest.json',
      attention_contract: {
        max_queue_depth: 2048,
        ttl_hours: 48,
        dedupe_window_hours: 24,
        backpressure_drop_below: 'critical',
        escalate_levels: ['critical'],
        priority_map: {
          critical: 100,
          warn: 60,
          info: 20
        }
      },
      push_event_types: ['external_item', 'eye_run_failed', 'infra_outage_state', 'eye_health_quarantine_set', 'eye_auto_dormant', 'collector_proposal_added'],
      focus_warn_score: 0.7,
      critical_error_codes: ['env_blocked', 'auth_denied', 'integrity_blocked', 'transport_blocked']
    },
    personas: {
      ambient_stance: true,
      auto_apply: true,
      full_reload: false,
      cache_path: 'state/personas/ambient_stance/cache.json',
      latest_path: 'state/personas/ambient_stance/latest.json',
      receipts_path: 'state/personas/ambient_stance/receipts.jsonl',
      max_personas: 256,
      max_patch_bytes: 65536
    },
    dopamine: {
      threshold_breach_only: true,
      surface_levels: ['warn', 'critical']
    },
    receipts: {
      silent_unless_critical: true
    }
  };
}

function normalizePolicy(raw, root) {
  const base = defaultPolicy();
  const src = raw && typeof raw === 'object' ? raw : {};
  const policy = {
    version: text(src.version || base.version, 40) || base.version,
    enabled: boolFromEnv(process.env.MECH_SUIT_MODE_FORCE, src.enabled == null ? base.enabled : !!src.enabled),
    state: {
      status_path: normalizeRelPath(src.state && src.state.status_path, base.state.status_path),
      history_path: normalizeRelPath(src.state && src.state.history_path, base.state.history_path)
    },
    spine: {
      heartbeat_hours: Math.max(1, Number(src.spine && src.spine.heartbeat_hours || base.spine.heartbeat_hours) || base.spine.heartbeat_hours),
      manual_triggers_allowed: !!(src.spine && src.spine.manual_triggers_allowed),
      quiet_non_critical: src.spine && src.spine.quiet_non_critical != null ? !!src.spine.quiet_non_critical : base.spine.quiet_non_critical,
      silent_subprocess_output: src.spine && src.spine.silent_subprocess_output != null ? !!src.spine.silent_subprocess_output : base.spine.silent_subprocess_output,
      critical_patterns: Array.isArray(src.spine && src.spine.critical_patterns) && (src.spine.critical_patterns).length > 0
        ? src.spine.critical_patterns.map((row) => text(row, 80)).filter(Boolean)
        : base.spine.critical_patterns.slice()
    },
    eyes: {
      push_attention_queue: src.eyes && src.eyes.push_attention_queue != null ? !!src.eyes.push_attention_queue : base.eyes.push_attention_queue,
      quiet_non_critical: src.eyes && src.eyes.quiet_non_critical != null ? !!src.eyes.quiet_non_critical : base.eyes.quiet_non_critical,
      attention_queue_path: normalizeRelPath(src.eyes && src.eyes.attention_queue_path, base.eyes.attention_queue_path),
      receipts_path: normalizeRelPath(src.eyes && src.eyes.receipts_path, base.eyes.receipts_path),
      latest_path: normalizeRelPath(src.eyes && src.eyes.latest_path, base.eyes.latest_path),
      attention_contract: {
        max_queue_depth: Math.max(
          1,
          Number(src.eyes && src.eyes.attention_contract && src.eyes.attention_contract.max_queue_depth || base.eyes.attention_contract.max_queue_depth) || base.eyes.attention_contract.max_queue_depth
        ),
        ttl_hours: Math.max(
          1,
          Number(src.eyes && src.eyes.attention_contract && src.eyes.attention_contract.ttl_hours || base.eyes.attention_contract.ttl_hours) || base.eyes.attention_contract.ttl_hours
        ),
        dedupe_window_hours: Math.max(
          1,
          Number(src.eyes && src.eyes.attention_contract && src.eyes.attention_contract.dedupe_window_hours || base.eyes.attention_contract.dedupe_window_hours) || base.eyes.attention_contract.dedupe_window_hours
        ),
        backpressure_drop_below: text(
          src.eyes && src.eyes.attention_contract && src.eyes.attention_contract.backpressure_drop_below,
          24
        ).toLowerCase() || base.eyes.attention_contract.backpressure_drop_below,
        escalate_levels: Array.isArray(src.eyes && src.eyes.attention_contract && src.eyes.attention_contract.escalate_levels)
          && src.eyes.attention_contract.escalate_levels.length > 0
          ? src.eyes.attention_contract.escalate_levels.map((row) => text(row, 24).toLowerCase()).filter(Boolean)
          : base.eyes.attention_contract.escalate_levels.slice(),
        priority_map: {
          critical: Number(
            src.eyes && src.eyes.attention_contract && src.eyes.attention_contract.priority_map && src.eyes.attention_contract.priority_map.critical
          ) || base.eyes.attention_contract.priority_map.critical,
          warn: Number(
            src.eyes && src.eyes.attention_contract && src.eyes.attention_contract.priority_map && src.eyes.attention_contract.priority_map.warn
          ) || base.eyes.attention_contract.priority_map.warn,
          info: Number(
            src.eyes && src.eyes.attention_contract && src.eyes.attention_contract.priority_map && src.eyes.attention_contract.priority_map.info
          ) || base.eyes.attention_contract.priority_map.info
        }
      },
      push_event_types: Array.isArray(src.eyes && src.eyes.push_event_types) && (src.eyes.push_event_types).length > 0
        ? src.eyes.push_event_types.map((row) => text(row, 80)).filter(Boolean)
        : base.eyes.push_event_types.slice(),
      focus_warn_score: Math.max(0, Math.min(1, Number(src.eyes && src.eyes.focus_warn_score || base.eyes.focus_warn_score) || base.eyes.focus_warn_score)),
      critical_error_codes: Array.isArray(src.eyes && src.eyes.critical_error_codes) && (src.eyes.critical_error_codes).length > 0
        ? src.eyes.critical_error_codes.map((row) => text(row, 80).toLowerCase()).filter(Boolean)
        : base.eyes.critical_error_codes.slice()
    },
    personas: {
      ambient_stance: src.personas && src.personas.ambient_stance != null ? !!src.personas.ambient_stance : base.personas.ambient_stance,
      auto_apply: src.personas && src.personas.auto_apply != null ? !!src.personas.auto_apply : base.personas.auto_apply,
      full_reload: src.personas && src.personas.full_reload != null ? !!src.personas.full_reload : base.personas.full_reload,
      cache_path: normalizeRelPath(src.personas && src.personas.cache_path, base.personas.cache_path),
      latest_path: normalizeRelPath(src.personas && src.personas.latest_path, base.personas.latest_path),
      receipts_path: normalizeRelPath(src.personas && src.personas.receipts_path, base.personas.receipts_path),
      max_personas: Math.max(
        1,
        Number(src.personas && src.personas.max_personas || base.personas.max_personas) || base.personas.max_personas
      ),
      max_patch_bytes: Math.max(
        256,
        Number(src.personas && src.personas.max_patch_bytes || base.personas.max_patch_bytes) || base.personas.max_patch_bytes
      )
    },
    dopamine: {
      threshold_breach_only: src.dopamine && src.dopamine.threshold_breach_only != null ? !!src.dopamine.threshold_breach_only : base.dopamine.threshold_breach_only,
      surface_levels: Array.isArray(src.dopamine && src.dopamine.surface_levels) && (src.dopamine.surface_levels).length > 0
        ? src.dopamine.surface_levels.map((row) => text(row, 40).toLowerCase()).filter(Boolean)
        : base.dopamine.surface_levels.slice()
    },
    receipts: {
      silent_unless_critical: src.receipts && src.receipts.silent_unless_critical != null ? !!src.receipts.silent_unless_critical : base.receipts.silent_unless_critical
    }
  };
  policy._root = root;
  policy._policy_path = resolvePolicyPath(root);
  return policy;
}

function resolvePolicyPath(rootOverride = null) {
  const root = repoRoot(rootOverride);
  const explicit = text(process.env.MECH_SUIT_MODE_POLICY_PATH, 400);
  if (!explicit) return path.join(root, DEFAULT_POLICY_REL);
  return path.resolve(explicit);
}

function loadMechSuitModePolicy(opts = {}) {
  const root = repoRoot(opts.root);
  const policyPath = resolvePolicyPath(root);
  const raw = readJsonSafe(policyPath, {});
  return normalizePolicy(raw, root);
}

function resolveStatePath(policy, relPath) {
  const root = policy && policy._root ? policy._root : repoRoot();
  const requested = String(relPath || '').trim();
  if (!requested) return root;
  if (path.isAbsolute(requested)) return requested;
  return path.join(root, requested);
}

function approxTokenCount(value) {
  const textValue = String(value == null ? '' : value);
  if (!textValue.trim()) return 0;
  return Math.max(1, Math.ceil(textValue.length / 4));
}

function classifySeverity(message, patterns = []) {
  const line = text(message, 600).toLowerCase();
  if (!line) return 'info';
  const criticalRe = /\b(critical|fail|failed|emergency|blocked|halt|panic|violation|integrity|outage|fatal)\b/i;
  if (criticalRe.test(line)) return 'critical';
  if (Array.isArray(patterns) && patterns.some((row) => row && line.includes(String(row).toLowerCase()))) {
    return 'critical';
  }
  if (/\b(warn|warning|degraded|retry|quarantine|dormant|slow|parked)\b/i.test(line)) return 'warn';
  return 'info';
}

function shouldEmitAmbientConsole(message, method, policy) {
  if (!policy || policy.enabled !== true) return true;
  const severity = classifySeverity(message, policy.spine && policy.spine.critical_patterns);
  if (severity === 'critical') return true;
  if (method === 'error' && severity === 'warn') return false;
  return false;
}

function emitAmbientConsole(message, method, policy) {
  if (!shouldEmitAmbientConsole(message, method, policy)) return false;
  const line = String(message == null ? '' : message);
  if (!line) return false;
  const target = method === 'error' ? process.stderr : process.stdout;
  target.write(line.endsWith('\n') ? line : `${line}\n`);
  return true;
}

function updateMechSuitStatus(component, patch, opts = {}) {
  const policy = opts.policy || loadMechSuitModePolicy({ root: opts.root });
  const latestPath = resolveStatePath(policy, policy.state.status_path);
  const historyPath = resolveStatePath(policy, policy.state.history_path);
  const latest = readJsonSafe(latestPath, {
    ts: null,
    active: policy.enabled === true,
    components: {}
  }) || { ts: null, active: policy.enabled === true, components: {} };
  if (!latest.components || typeof latest.components !== 'object') latest.components = {};
  latest.ts = new Date().toISOString();
  latest.active = policy.enabled === true;
  latest.policy_path = path.relative(policy._root || repoRoot(), policy._policy_path || resolvePolicyPath(policy._root || repoRoot()));
  latest.components[component] = {
    ...(latest.components[component] && typeof latest.components[component] === 'object' ? latest.components[component] : {}),
    ...(patch && typeof patch === 'object' ? patch : {})
  };
  writeJson(latestPath, latest);
  appendJsonl(historyPath, {
    ts: latest.ts,
    type: 'mech_suit_status',
    component,
    active: latest.active,
    patch: patch && typeof patch === 'object' ? patch : {}
  });
  return latest;
}

function buildAttentionEvent(event, policy) {
  const row = event && typeof event === 'object' ? event : {};
  const type = text(row.type, 80);
  const allowed = new Set(Array.isArray(policy.eyes && policy.eyes.push_event_types) ? policy.eyes.push_event_types : []);
  const explicitSource = text(row.source, 80);
  const explicitSourceType = text(row.source_type, 80);
  const allowGeneric = !!(explicitSource || explicitSourceType);
  if (!allowed.has(type) && !allowGeneric) return null;

  const eyeId = text(row.eye_id, 80) || 'unknown_eye';
  const parserType = text(row.parser_type, 60);
  const focusScore = Number.isFinite(Number(row.focus_score)) ? Number(row.focus_score) : null;
  const fallback = row.fallback === true;
  let severity = text(row.severity, 24).toLowerCase() || 'info';
  let summary = text(row.summary, 140) || `${type}:${eyeId}`;

  if (type === 'external_item') {
    severity = fallback ? 'info' : ((focusScore != null && focusScore >= Number(policy.eyes.focus_warn_score || 0.7)) || String(row.focus_mode || '') === 'focus' ? 'warn' : 'info');
    summary = text(row.title || `${eyeId} external item`, 140) || `${eyeId} external item`;
  } else if (type === 'eye_run_failed') {
    const code = text(row.error_code, 80).toLowerCase();
    severity = policy.eyes.critical_error_codes.includes(code) ? 'critical' : 'warn';
    summary = text(row.error || `${eyeId} collector failed`, 140) || `${eyeId} collector failed`;
  } else if (type === 'infra_outage_state') {
    severity = row.active === true ? 'critical' : 'warn';
    summary = row.active === true ? `eyes outage active (${Number(row.failed_transport_eyes || 0)} failed)` : 'eyes outage recovered';
  } else if (type === 'eye_health_quarantine_set') {
    severity = 'warn';
    summary = `${eyeId} quarantined: ${text(row.reason, 120) || 'health_quarantine'}`;
  } else if (type === 'eye_auto_dormant') {
    severity = 'warn';
    summary = `${eyeId} dormant: ${text(row.reason, 120) || 'auto_dormant'}`;
  } else if (type === 'collector_proposal_added') {
    severity = 'warn';
    summary = `${eyeId} remediation proposal added`;
  }

  const priorityMap = policy.eyes && policy.eyes.attention_contract && policy.eyes.attention_contract.priority_map
    ? policy.eyes.attention_contract.priority_map
    : { critical: 100, warn: 60, info: 20 };
  const payload = {
    ts: text(row.ts, 40) || new Date().toISOString(),
    type: 'attention_event',
    source: explicitSource || 'external_eyes',
    source_type: explicitSourceType || type,
    eye_id: eyeId,
    parser_type: parserType || null,
    severity,
    priority: Number(priorityMap[severity] || 20),
    summary,
    focus_mode: text(row.focus_mode, 24) || null,
    focus_score: focusScore,
    error_code: text(row.error_code, 80) || null,
    attention_key: text(row.attention_key, 160) || `${type}:${eyeId}:${text(row.item_hash || row.error_code || row.reason || row.title, 120)}`,
    raw_event: row
  };
  payload.receipt_hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  return payload;
}

function loadSpineConduitBridge(root) {
  try {
    return require(path.join(root, 'lib', 'spine_conduit_bridge.js'));
  } catch {
    return null;
  }
}

function appendAttentionQueueEventLegacy(attention, policy) {
  const queuePath = resolveStatePath(policy, policy.eyes.attention_queue_path);
  const receiptsPath = resolveStatePath(policy, policy.eyes.receipts_path);
  const latestPath = resolveStatePath(policy, policy.eyes.latest_path);
  appendJsonl(queuePath, attention);
  appendJsonl(receiptsPath, {
    ts: attention.ts,
    type: 'attention_receipt',
    queued: true,
    severity: attention.severity,
    eye_id: attention.eye_id,
    source_type: attention.source_type,
    receipt_hash: attention.receipt_hash
  });
  const latest = readJsonSafe(latestPath, { queued_total: 0 }) || { queued_total: 0 };
  latest.ts = attention.ts;
  latest.active = true;
  latest.queued_total = Number(latest.queued_total || 0) + 1;
  latest.last_event = {
    eye_id: attention.eye_id,
    source_type: attention.source_type,
    severity: attention.severity,
    summary: attention.summary
  };
  writeJson(latestPath, latest);
  return { ok: true, queued: true, event: attention, routed_via: 'js_fallback' };
}

async function appendAttentionQueueEvent(event, opts = {}) {
  const policy = opts.policy || loadMechSuitModePolicy({ root: opts.root });
  if (policy.enabled !== true || policy.eyes.push_attention_queue !== true) {
    return { ok: true, queued: false, reason: 'disabled' };
  }
  const attention = buildAttentionEvent(event, policy);
  if (!attention) return { ok: true, queued: false, reason: 'event_not_tracked' };

  const root = policy._root || repoRoot(opts.root);
  const bridge = loadSpineConduitBridge(root);
  let result = null;
  if (bridge && typeof bridge.runAttentionCommand === 'function') {
    const encoded = Buffer.from(JSON.stringify(attention), 'utf8').toString('base64');
    result = await bridge.runAttentionCommand(
      ['enqueue', `--event-json-base64=${encoded}`, `--run-context=${text(opts.runContext, 40) || 'eyes'}`],
      { cwdHint: root }
    );
  }
  if (!result || result.ok !== true) {
    result = appendAttentionQueueEventLegacy(attention, policy);
  }

  const payload = result && result.payload && typeof result.payload === 'object' ? result.payload : {};
  updateMechSuitStatus('eyes', {
    ambient: true,
    push_attention_queue: true,
    quiet_non_critical: policy.eyes.quiet_non_critical === true,
    last_attention_ts: attention.ts,
    last_attention_summary: attention.summary,
    attention_queue_path: policy.eyes.attention_queue_path,
    attention_receipts_path: policy.eyes.receipts_path,
    attention_last_decision: text(payload.decision, 32) || (result.queued === true ? 'admitted' : 'unknown'),
    attention_routed_via: result.routed_via || 'conduit'
  }, { policy });
  return {
    ok: result.ok !== false,
    queued: payload.queued === true || result.queued === true,
    event: attention,
    decision: text(payload.decision, 32) || null,
    routed_via: result.routed_via || 'conduit'
  };
}

module.exports = {
  approxTokenCount,
  appendAttentionQueueEvent,
  classifySeverity,
  emitAmbientConsole,
  loadMechSuitModePolicy,
  resolvePolicyPath,
  resolveStatePath,
  shouldEmitAmbientConsole,
  updateMechSuitStatus
};
