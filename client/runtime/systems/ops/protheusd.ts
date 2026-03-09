#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync } = require('child_process');
const {
  runSpineCommand,
  runAttentionCommand,
  runMemoryAmbientCommand,
  runOpsDomainCommand
} = require('../../lib/spine_conduit_bridge');
const { CANONICAL_PATHS, normalizeForRoot } = require('../../lib/runtime_path_registry');

const ROOT = path.resolve(__dirname, '..', '..');
const INTERNAL_AMBIENT_LOOP = '__ambient-loop';

function usage() {
  console.log('Usage: protheusd [attach|start|stop|restart|status|diagnostics|tick|subscribe] [--policy=<path>] [--conduit] [--allow-legacy-fallback] [--autostart] [--no-autostart] [--no-cockpit]');
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJson(text: unknown) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, payload: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath: string, payload: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readJsonl(filePath: string, maxRows = 50000) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = String(fs.readFileSync(filePath, 'utf8') || '');
    if (!raw.trim()) return [];
    const out: any[] = [];
    const lines = raw.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        out.push(JSON.parse(line));
      } catch {}
      if (out.length >= maxRows) break;
    }
    return out;
  } catch {
    return [];
  }
}

function deterministicHash(payload: any) {
  const canonical = JSON.stringify(payload, Object.keys(payload || {}).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function withReceipt(payload: any) {
  const out = payload && typeof payload === 'object' ? payload : {};
  out.receipt_hash = deterministicHash(out);
  return out;
}

function toBool(v: unknown, fallback = false) {
  const raw = String(v == null ? '' : v).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function toInt(v: unknown, fallback: number, lo: number, hi: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function toFloat(v: unknown, fallback: number, lo: number, hi: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function parseFlag(argv: string[], key: string) {
  const pref = `--${key}=`;
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (token.startsWith(pref)) return token.slice(pref.length);
    if (token === `--${key}`) {
      const next = String(argv[i + 1] || '');
      if (next && !next.startsWith('--')) return next;
      return '1';
    }
  }
  return null;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

function estimateTokens(text: unknown) {
  const raw = String(text == null ? '' : text);
  if (!raw) return 0;
  return Math.max(1, Math.ceil(raw.length / 4));
}

function readFileHead(filePath: string, maxChars: number) {
  try {
    if (!fs.existsSync(filePath)) return { exists: false, excerpt: '', truncated: false };
    const raw = String(fs.readFileSync(filePath, 'utf8') || '');
    if (!raw) return { exists: true, excerpt: '', truncated: false };
    const cap = Math.max(64, Math.min(200000, Number(maxChars) || 2000));
    const excerpt = raw.slice(0, cap);
    return {
      exists: true,
      excerpt,
      truncated: raw.length > excerpt.length
    };
  } catch {
    return { exists: false, excerpt: '', truncated: false };
  }
}

function loadIdentityHydrationPolicy(runtime: any) {
  const fallback = {
    enabled: true,
    startup_token_budget: 180,
    per_file_max_chars: 220,
    base_files: [
      'docs/workspace/SOUL.md',
      'docs/workspace/USER.md'
    ],
    lazy_pages: [
      'docs/workspace/MEMORY_INDEX.md',
      'docs/workspace/TAGS_INDEX.md',
      'docs/workspace/MEMORY.md',
      'client/runtime/local/state/memory/conversation_eye/nodes.jsonl',
      'client/runtime/local/state/attention/latest.json'
    ]
  };
  const raw = readJson(runtime.identityHydrationPolicyPath, fallback) || fallback;
  return {
    enabled: raw.enabled !== false,
    startup_token_budget: toInt(raw.startup_token_budget, fallback.startup_token_budget, 64, 64000),
    per_file_max_chars: toInt(raw.per_file_max_chars, fallback.per_file_max_chars, 64, 200000),
    base_files: Array.isArray(raw.base_files) ? raw.base_files.map((row: any) => cleanText(row, 500)).filter(Boolean) : fallback.base_files,
    lazy_pages: Array.isArray(raw.lazy_pages) ? raw.lazy_pages.map((row: any) => cleanText(row, 500)).filter(Boolean) : fallback.lazy_pages
  };
}

function buildIdentityHydrationSnapshot(runtime: any) {
  const policy = loadIdentityHydrationPolicy(runtime);
  const now = nowIso();
  const out = {
    schema_version: '1.0',
    enabled: policy.enabled,
    ts: now,
    startup_token_budget: policy.startup_token_budget,
    estimated_tokens_loaded: 0,
    files_loaded: [] as any[],
    files_deferred: [] as any[]
  };
  if (!policy.enabled) return out;
  let remainingBudget = Number(policy.startup_token_budget || 0);
  for (const rel of policy.base_files) {
    const abs = path.isAbsolute(rel) ? rel : path.join(runtime.workspaceRoot, rel);
    const head = readFileHead(abs, policy.per_file_max_chars);
    if (!head.exists) {
      out.files_deferred.push({
        file: rel,
        reason: 'missing'
      });
      continue;
    }
    const tokenCost = estimateTokens(head.excerpt);
    if (remainingBudget - tokenCost < 0) {
      out.files_deferred.push({
        file: rel,
        reason: 'startup_budget_exceeded',
        estimated_tokens: tokenCost
      });
      continue;
    }
    remainingBudget -= tokenCost;
    out.estimated_tokens_loaded += tokenCost;
    out.files_loaded.push({
      file: rel,
      estimated_tokens: tokenCost,
      truncated: head.truncated === true
    });
  }
  for (const rel of policy.lazy_pages) {
    out.files_deferred.push({
      file: rel,
      reason: 'lazy_hydration'
    });
  }
  return out;
}

async function buildResidentMemorySnapshot(runtime: any) {
  const now = nowIso();
  const out = {
    schema_version: '1.0',
    ts: now,
    mode: 'ambient_resident',
    rust_authoritative: true,
    sqlite_path: path.join(runtime.workspaceRoot, 'core', 'local', 'state', 'memory', 'runtime_memory.sqlite'),
    working_set_cache_path: path.join(runtime.workspaceRoot, 'core', 'local', 'state', 'memory', 'working_set_cache.json'),
    conversation_nodes_path: runtime.conversationEyeIndexPath,
    hotset: {
      conversation_nodes: 0,
      attention_last_ts: null as string | null,
      ambient_last_ts: null as string | null
    },
    health: {
      memory_ambient_ok: null as boolean | null,
      memory_ambient_reason: null as string | null
    }
  };
  const convo = readJson(runtime.conversationEyeIndexPath, null);
  if (convo && typeof convo === 'object') {
    out.hotset.conversation_nodes = convo.emitted_node_ids && typeof convo.emitted_node_ids === 'object'
      ? Object.keys(convo.emitted_node_ids).length
      : 0;
  }
  const attentionLatest = readJson(runtime.mechPolicy.attentionLatestPath, null);
  if (attentionLatest && typeof attentionLatest === 'object') {
    out.hotset.attention_last_ts = cleanText(attentionLatest.ts || '', 64) || null;
  }
  try {
    const mem = await runMemoryAmbientCommand(['status'], {
      cwdHint: runtime.root,
      runContext: 'protheusd_resident_memory',
      timeoutMs: Math.max(2000, Math.min(20000, runtime.cockpitConduitTimeoutMs * 2))
    });
    out.health.memory_ambient_ok = !!(mem && mem.ok === true);
    out.health.memory_ambient_reason = cleanText(
      mem && mem.payload && mem.payload.reason
        ? mem.payload.reason
        : mem && mem.stderr
          ? mem.stderr
          : '',
      260
    ) || null;
    out.hotset.ambient_last_ts = cleanText(
      mem && mem.payload && mem.payload.ts ? mem.payload.ts : '',
      64
    ) || null;
  } catch (error: any) {
    out.health.memory_ambient_ok = false;
    out.health.memory_ambient_reason = cleanText(error && error.message ? error.message : String(error), 260) || 'memory_ambient_status_failed';
  }
  return out;
}

function toMb(bytes: unknown) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Number((n / (1024 * 1024)).toFixed(2));
}

function collectResourceSnapshot(memoryPressureRatio: number) {
  const usage = process.memoryUsage();
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedRatio = totalMem > 0 ? Number(((totalMem - freeMem) / totalMem).toFixed(6)) : 0;
  return {
    ts: nowIso(),
    pid: process.pid,
    process_rss_mb: toMb(usage.rss),
    process_heap_used_mb: toMb(usage.heapUsed),
    process_heap_total_mb: toMb(usage.heapTotal),
    process_external_mb: toMb(usage.external),
    process_array_buffers_mb: toMb((usage as any).arrayBuffers || 0),
    system_total_mb: toMb(totalMem),
    system_free_mb: toMb(freeMem),
    system_used_ratio: usedRatio,
    memory_pressure_threshold: Number(memoryPressureRatio.toFixed(3)),
    memory_pressure: usedRatio >= memoryPressureRatio
  };
}

function shouldBackoffCockpit(errorText: unknown) {
  const text = String(errorText == null ? '' : errorText);
  if (!text.trim()) return false;
  return /\bETIMEDOUT\b/i.test(text)
    || /spawn_timeout:/i.test(text)
    || /conduit_stdio_timeout:/i.test(text)
    || /conduit_bridge_timeout:/i.test(text)
    || /dyld_loader_stall_detected/i.test(text)
    || /stale_build_script_detected/i.test(text);
}

function bridgeReasonMarker(reason: string) {
  const marker = 'conduit_runtime_gate_active_until:';
  const raw = String(reason || '');
  const index = raw.indexOf(marker);
  if (index === -1) return null;
  return raw.slice(index + marker.length).trim();
}

function bridgeReasonFromRuntimeGate(gate: any) {
  if (!gate || gate.gate_active !== true) return null;
  const until = cleanText(gate.blocked_until || '', 64)
    || new Date(Date.now() + Math.max(0, Number(gate.remaining_ms || 0))).toISOString();
  return cleanText(`conduit_runtime_gate_active_until:${until}`, 260);
}

function isBridgeTimeoutReason(value: unknown) {
  const text = String(value == null ? '' : value).toLowerCase();
  if (!text) return false;
  return text.includes('conduit_runtime_gate_active_until:')
    || text.includes('conduit_stdio_timeout:')
    || text.includes('conduit_bridge_timeout:')
    || text.includes('conduit_startup_probe_timeout:')
    || text.includes('bridge_wait_failed')
    || text.includes('conduit_stdio_exit:')
    || text.includes('conduit_stdio_error:')
    || text.includes('dyld_loader_stall_detected')
    || text.includes('stale_build_script_detected');
}

function bridgeReasonFromSpineResult(spine: any) {
  if (!spine || typeof spine !== 'object') return null;
  if (spine.ok === true && Number.isFinite(Number(spine.status)) && Number(spine.status) === 0) {
    return null;
  }
  const payloadReason = cleanText(spine.payload && spine.payload.reason, 260);
  if (payloadReason && isBridgeTimeoutReason(payloadReason)) return payloadReason;
  const stderrReason = cleanText(spine.stderr, 260);
  if (stderrReason && isBridgeTimeoutReason(stderrReason)) return stderrReason;
  return null;
}

function bridgeProbeBaseMs() {
  return toInt(process.env.PROTHEUSD_BRIDGE_PROBE_BASE_MS, 30000, 5000, 60 * 60 * 1000);
}

function bridgeProbeMaxMs() {
  return toInt(
    process.env.PROTHEUSD_BRIDGE_PROBE_MAX_MS,
    30 * 60 * 1000,
    bridgeProbeBaseMs(),
    6 * 60 * 60 * 1000
  );
}

function bridgeProbeDelayMs(consecutiveFailures: number, reason: string, gate: any) {
  if (gate && gate.gate_active === true) {
    const remaining = Number(gate.remaining_ms || 0);
    if (Number.isFinite(remaining) && remaining > 0) {
      return Math.max(5000, Math.min(bridgeProbeMaxMs(), Math.floor(remaining)));
    }
  }
  const marker = bridgeReasonMarker(reason || '');
  if (marker) {
    const untilMs = Date.parse(marker);
    if (Number.isFinite(untilMs) && untilMs > Date.now()) {
      const remaining = untilMs - Date.now();
      return Math.max(5000, Math.min(bridgeProbeMaxMs(), Math.floor(remaining)));
    }
  }
  const safeFailures = Math.max(1, Number.isFinite(Number(consecutiveFailures)) ? Number(consecutiveFailures) : 1);
  const scaled = bridgeProbeBaseMs() * Math.pow(2, Math.min(8, safeFailures - 1));
  return Math.min(bridgeProbeMaxMs(), Math.max(bridgeProbeBaseMs(), Math.floor(scaled)));
}

function normalizedBridgeHealth(existing: any = {}) {
  const out = existing && typeof existing === 'object' ? existing : {};
  return {
    status: out.degraded === true ? 'degraded' : (cleanText(out.status || 'healthy', 40) || 'healthy'),
    degraded: out.degraded === true,
    reason: cleanText(out.reason || '', 260) || null,
    source: cleanText(out.source || '', 80) || null,
    since: cleanText(out.since || '', 64) || null,
    last_probe_at: cleanText(out.last_probe_at || '', 64) || null,
    last_probe_ok: out.last_probe_ok === true,
    next_probe_at: cleanText(out.next_probe_at || '', 64) || null,
    consecutive_failures: Number.isFinite(Number(out.consecutive_failures))
      ? Math.max(0, Number(out.consecutive_failures))
      : 0,
    gate_active: out.gate_active === true,
    gate_remaining_ms: Number.isFinite(Number(out.gate_remaining_ms))
      ? Math.max(0, Number(out.gate_remaining_ms))
      : 0,
    last_recovered_at: cleanText(out.last_recovered_at || '', 64) || null
  };
}

function markBridgeDegraded(state: any, runtime: any, reason: string, source: string) {
  const gate = readConduitRuntimeGate(runtime.root);
  const current = normalizedBridgeHealth(state.bridge_health);
  const now = Date.now();
  const failures = Math.max(1, Number(current.consecutive_failures || 0) + 1);
  const delayMs = bridgeProbeDelayMs(failures, reason, gate);
  const nextProbeAt = new Date(now + delayMs).toISOString();
  state.bridge_health = {
    ...current,
    status: 'degraded',
    degraded: true,
    reason: cleanText(reason || 'conduit_bridge_degraded', 260) || 'conduit_bridge_degraded',
    source: cleanText(source || 'ambient_loop', 80) || 'ambient_loop',
    since: current.degraded === true && current.since ? current.since : new Date(now).toISOString(),
    last_probe_at: new Date(now).toISOString(),
    last_probe_ok: false,
    next_probe_at: nextProbeAt,
    consecutive_failures: failures,
    gate_active: gate && gate.gate_active === true,
    gate_remaining_ms: Number.isFinite(Number(gate && gate.remaining_ms)) ? Math.max(0, Number(gate.remaining_ms)) : 0
  };
  state.last_error = cleanText(`bridge_degraded:${state.bridge_health.reason}`, 260);
  state.last_heartbeat_code = 1;
  state.next_heartbeat_at = nextProbeAt;
}

function clearBridgeDegraded(state: any, source: string) {
  const current = normalizedBridgeHealth(state.bridge_health);
  const now = nowIso();
  state.bridge_health = {
    ...current,
    status: 'healthy',
    degraded: false,
    reason: null,
    source: cleanText(source || 'ambient_loop', 80) || 'ambient_loop',
    since: null,
    last_probe_at: now,
    last_probe_ok: true,
    next_probe_at: null,
    consecutive_failures: 0,
    gate_active: false,
    gate_remaining_ms: 0,
    last_recovered_at: now
  };
  if (String(state.last_error || '').startsWith('bridge_degraded:')) {
    state.last_error = null;
  }
}

function bridgeProbeDue(state: any) {
  const health = normalizedBridgeHealth(state && state.bridge_health);
  if (!health.degraded) return true;
  const dueAtMs = health.next_probe_at ? Date.parse(String(health.next_probe_at)) : 0;
  if (!Number.isFinite(dueAtMs) || dueAtMs <= 0) return true;
  return Date.now() >= dueAtMs;
}

function resolvePath(root: string, maybePath: unknown, fallbackRel: string) {
  const raw = cleanText(maybePath, 500);
  const base = raw || fallbackRel;
  if (path.isAbsolute(base)) return base;
  return path.join(root, normalizeForRoot(root, base));
}

function isPidAlive(pid: unknown) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

function defaultControlPlanePaths(root: string) {
  const stateRoot = path.join(root, 'local', 'state', 'ops', 'protheus_control_plane');
  return {
    stateRoot,
    daemonPath: path.join(stateRoot, 'daemon.json'),
    commandsPath: path.join(stateRoot, 'commands.jsonl'),
    latestPath: path.join(stateRoot, 'latest.json'),
    receiptsPath: path.join(stateRoot, 'receipts.jsonl')
  };
}

function readConduitRuntimeGate(root: string) {
  const gatePath = path.join(root, 'local', 'state', 'conduit', 'runtime_gate.json');
  const payload = readJson(gatePath, null);
  if (!payload || typeof payload !== 'object') {
    return {
      available: false,
      path: gatePath,
      gate_active: false
    };
  }
  const blockedUntilMs = Number.isFinite(Number(payload.blocked_until_ms))
    ? Number(payload.blocked_until_ms)
    : null;
  const remainingMs = blockedUntilMs != null
    ? Math.max(0, blockedUntilMs - Date.now())
    : 0;
  const gateActive = payload.gate_active === true && remainingMs > 0;
  return {
    available: true,
    path: gatePath,
    gate_active: gateActive,
    blocked_until: cleanText(payload.blocked_until || '', 64) || null,
    blocked_until_ms: blockedUntilMs,
    remaining_ms: remainingMs,
    consecutive_failures: Number.isFinite(Number(payload.consecutive_failures))
      ? Number(payload.consecutive_failures)
      : 0,
    threshold: Number.isFinite(Number(payload.threshold))
      ? Number(payload.threshold)
      : null,
    last_error: cleanText(payload.last_error || '', 260) || null,
    last_failure_at: cleanText(payload.last_failure_at || '', 64) || null,
    updated_at: cleanText(payload.updated_at || '', 64) || null
  };
}

function loadMechPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const spine = raw && raw.spine && typeof raw.spine === 'object' ? raw.spine : {};
  const state = raw && raw.state && typeof raw.state === 'object' ? raw.state : {};
  const eyes = raw && raw.eyes && typeof raw.eyes === 'object' ? raw.eyes : {};
  const personas = raw && raw.personas && typeof raw.personas === 'object' ? raw.personas : {};
  const dopamine = raw && raw.dopamine && typeof raw.dopamine === 'object' ? raw.dopamine : {};
  return {
    enabled: raw && raw.enabled !== false,
    heartbeatHours: toInt(spine.heartbeat_hours, 4, 1, 168),
    manualTriggersAllowed: spine.manual_triggers_allowed === true,
    statusPath: resolvePath(ROOT, state.status_path, `${CANONICAL_PATHS.client_state_root}/ops/mech_suit_mode/latest.json`),
    attentionQueuePath: resolvePath(ROOT, eyes.attention_queue_path, `${CANONICAL_PATHS.client_state_root}/attention/queue.jsonl`),
    attentionCursorRoot: resolvePath(ROOT, eyes.consumer_state_path, `${CANONICAL_PATHS.client_state_root}/attention/consumers`),
    attentionLatestPath: resolvePath(ROOT, eyes.latest_path, `${CANONICAL_PATHS.client_state_root}/attention/latest.json`),
    personaLatestPath: resolvePath(ROOT, personas.latest_path, `${CANONICAL_PATHS.client_state_root}/personas/ambient_stance/latest.json`),
    dopamineLatestPath: resolvePath(ROOT, dopamine.latest_path, `${CANONICAL_PATHS.client_state_root}/dopamine/ambient/latest.json`)
  };
}

function resolveRuntime(argv: string[]) {
  const policyArg = cleanText(parseFlag(argv, 'policy') || process.env.PROTHEUS_CONTROL_PLANE_POLICY_PATH, 500);
  const policyPath = policyArg
    ? (path.isAbsolute(policyArg) ? policyArg : path.join(ROOT, policyArg))
    : path.join(ROOT, 'config', 'protheus_control_plane_policy.json');
  const policy = readJson(policyPath, {});
  const originIntegrityPolicy = policy && policy.origin_integrity && typeof policy.origin_integrity === 'object'
    ? policy.origin_integrity
    : {};
  const defaults = defaultControlPlanePaths(ROOT);
  const paths = policy && policy.paths && typeof policy.paths === 'object' ? policy.paths : {};
  const stateRoot = resolvePath(ROOT, paths.state_root, path.relative(ROOT, defaults.stateRoot));
  const daemonPath = resolvePath(ROOT, paths.daemon_path, path.relative(ROOT, defaults.daemonPath));
  const commandsPath = resolvePath(ROOT, paths.commands_path, path.relative(ROOT, defaults.commandsPath));
  const latestPath = resolvePath(ROOT, paths.latest_path, path.relative(ROOT, defaults.latestPath));
  const receiptsPath = resolvePath(ROOT, paths.receipts_path, path.relative(ROOT, defaults.receiptsPath));

  const mechPolicyPathRaw = cleanText(process.env.MECH_SUIT_MODE_POLICY_PATH || '', 500);
  const mechPolicyPath = mechPolicyPathRaw
    ? (path.isAbsolute(mechPolicyPathRaw) ? mechPolicyPathRaw : path.join(ROOT, mechPolicyPathRaw))
    : path.join(ROOT, 'config', 'mech_suit_mode_policy.json');
  const mechPolicy = loadMechPolicy(mechPolicyPath);

  const heartbeatOverrideSec = toInt(process.env.PROTHEUS_AMBIENT_HEARTBEAT_SECONDS, 0, 0, 365 * 24 * 3600);
  const heartbeatMs = heartbeatOverrideSec > 0
    ? heartbeatOverrideSec * 1000
    : mechPolicy.heartbeatHours * 60 * 60 * 1000;
  const pollMs = toInt(process.env.PROTHEUS_AMBIENT_LOOP_POLL_MS, 15000, 1000, 300000);
  const spineRunTimeoutMs = toInt(
    process.env.PROTHEUSD_SPINE_RUN_TIMEOUT_MS || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS,
    30000,
    1000,
    15 * 60 * 1000
  );
  const spineStatusTimeoutMs = toInt(
    process.env.PROTHEUSD_SPINE_STATUS_TIMEOUT_MS || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS,
    10000,
    1000,
    15 * 60 * 1000
  );
  const cockpitOnceTimeoutMs = toInt(
    process.env.PROTHEUSD_COCKPIT_ONCE_TIMEOUT_MS,
    12000,
    1000,
    15 * 60 * 1000
  );
  const cockpitConduitTimeoutMs = toInt(
    process.env.PROTHEUSD_COCKPIT_CONDUIT_TIMEOUT_MS || process.env.COCKPIT_CONDUIT_PROBE_TIMEOUT_MS,
    4000,
    1000,
    15 * 60 * 1000
  );
  if (!cleanText(process.env.PROTHEUS_CONDUIT_STARTUP_PROBE || '', 16)) {
    process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
  }
  // Keep conduit startup probe aligned with cockpit bridge timeout to avoid false degraded states
  // when the daemon is healthy but cold-start probe defaults are too aggressive.
  if (!cleanText(process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS || '', 32)) {
    process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS = String(Math.max(5000, cockpitConduitTimeoutMs));
  }
  const cockpitCooldownMs = toInt(
    process.env.PROTHEUSD_COCKPIT_RETRY_COOLDOWN_MS,
    10 * 60 * 1000,
    5000,
    6 * 60 * 60 * 1000
  );
  const conversationEyeEnabled = toBool(process.env.PROTHEUSD_CONVERSATION_EYE_ENABLED, true);
  const conversationEyeTimeoutMs = toInt(
    process.env.PROTHEUSD_CONVERSATION_EYE_TIMEOUT_MS,
    30000,
    1000,
    15 * 60 * 1000
  );
  const conversationEyeCooldownMs = toInt(
    process.env.PROTHEUSD_CONVERSATION_EYE_RETRY_COOLDOWN_MS,
    10 * 60 * 1000,
    5000,
    6 * 60 * 60 * 1000
  );
  const memoryPressureRatio = toFloat(
    process.env.PROTHEUSD_MEMORY_PRESSURE_RATIO,
    0.99,
    0.7,
    0.995
  );
  const runtimeRetentionHookEnabled = toBool(process.env.PROTHEUSD_RUNTIME_RETENTION_HOOK, false);
  const runtimeRetentionPolicyPath = cleanText(
    process.env.RUNTIME_RETENTION_POLICY_PATH || path.join(ROOT, 'config', 'runtime_retention_policy.json'),
    500
  );
  // ROOT points at client/runtime; workspaceRoot must be repository root.
  const workspaceRoot = path.resolve(ROOT, '..', '..');
  const originIntegrityEnabled = toBool(
    process.env.PROTHEUSD_ORIGIN_INTEGRITY_ENABLED,
    toBool(originIntegrityPolicy.enabled, true)
  );
  const originIntegrityTimeoutMs = toInt(
    process.env.PROTHEUSD_ORIGIN_INTEGRITY_TIMEOUT_MS || originIntegrityPolicy.timeout_ms,
    30000,
    1000,
    15 * 60 * 1000
  );
  const originIntegrityRequirePass = toBool(
    process.env.PROTHEUSD_ORIGIN_INTEGRITY_REQUIRE_PASS,
    toBool(originIntegrityPolicy.require_pass_on_start, true)
  );
  const originIntegrityAllowTimeoutDegradedStart = toBool(
    process.env.PROTHEUSD_ORIGIN_INTEGRITY_ALLOW_TIMEOUT_DEGRADED_START,
    toBool(originIntegrityPolicy.allow_timeout_degraded_start, true)
  );
  const originIntegrityRetryMs = toInt(
    process.env.PROTHEUSD_ORIGIN_INTEGRITY_RETRY_MS || originIntegrityPolicy.retry_ms,
    10 * 60 * 1000,
    30 * 1000,
    6 * 60 * 60 * 1000
  );
  const originIntegrityPolicyRaw = cleanText(
    process.env.PROTHEUS_ORIGIN_INTEGRITY_POLICY_PATH || originIntegrityPolicy.policy_path || 'config/origin_integrity_policy.json',
    500
  );
  const originIntegrityPolicyPath = path.isAbsolute(originIntegrityPolicyRaw)
    ? originIntegrityPolicyRaw
    : path.join(ROOT, originIntegrityPolicyRaw);
  const verifyScriptPath = path.join(workspaceRoot, 'verify.sh');
  const protheusOpsManifestPath = path.join(workspaceRoot, 'core', 'layer0', 'ops', 'Cargo.toml');
  const protheusOpsReleasePath = path.join(workspaceRoot, 'target', 'release', 'protheus-ops');
  const protheusOpsDebugPath = path.join(workspaceRoot, 'target', 'debug', 'protheus-ops');

  const cockpitInboxDirRaw = cleanText(parseFlag(argv, 'inbox-dir') || process.env.COCKPIT_INBOX_DIR, 500);
  const cockpitInboxDir = cockpitInboxDirRaw
    ? (path.isAbsolute(cockpitInboxDirRaw) ? cockpitInboxDirRaw : path.join(ROOT, cockpitInboxDirRaw))
    : path.join(ROOT, 'local', 'state', 'cockpit', 'inbox');
  const identityHydrationPolicyPathRaw = cleanText(
    process.env.PROTHEUSD_IDENTITY_HYDRATION_POLICY_PATH || path.join(ROOT, 'config', 'cockpit_identity_hydration_policy.json'),
    500
  );
  const identityHydrationPolicyPath = path.isAbsolute(identityHydrationPolicyPathRaw)
    ? identityHydrationPolicyPathRaw
    : path.join(ROOT, identityHydrationPolicyPathRaw);
  const identityHydrationStatePath = path.join(ROOT, 'local', 'state', 'ops', 'identity_hydration', 'latest.json');
  const residentMemoryStatePath = path.join(ROOT, 'local', 'state', 'ops', 'resident_memory', 'latest.json');
  const consumerId = cleanText(parseFlag(argv, 'consumer') || process.env.COCKPIT_CONSUMER_ID || 'cockpit_llm', 80)
    .toLowerCase()
    .replace(/[^a-z0-9._:@-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'cockpit_llm';
  const batchLimit = toInt(parseFlag(argv, 'limit') || process.env.COCKPIT_BATCH_LIMIT, 24, 1, 512);

  return {
    root: ROOT,
    policyPath,
    policy,
    stateRoot,
    daemonPath,
    commandsPath,
    latestPath,
    receiptsPath,
    mechPolicyPath,
    mechPolicy,
    heartbeatMs,
    spineRunTimeoutMs,
    spineStatusTimeoutMs,
    cockpitOnceTimeoutMs,
    cockpitConduitTimeoutMs,
    cockpitCooldownMs,
    conversationEyeEnabled,
    conversationEyeTimeoutMs,
    conversationEyeCooldownMs,
    memoryPressureRatio,
    pollMs,
    cockpitInboxDir,
    cockpitLatestPath: path.join(cockpitInboxDir, 'latest.json'),
    cockpitStatePath: path.join(cockpitInboxDir, 'state.json'),
    conversationEyeIndexPath: path.join(ROOT, 'local', 'state', 'memory', 'conversation_eye', 'index.json'),
    runtimeRetentionHookEnabled,
    runtimeRetentionPolicyPath: path.isAbsolute(runtimeRetentionPolicyPath)
      ? runtimeRetentionPolicyPath
      : path.join(ROOT, runtimeRetentionPolicyPath),
    workspaceRoot,
    originIntegrityEnabled,
    originIntegrityTimeoutMs,
    originIntegrityRequirePass,
    originIntegrityAllowTimeoutDegradedStart,
    originIntegrityRetryMs,
    originIntegrityPolicyPath,
    verifyScriptPath,
    protheusOpsManifestPath,
    protheusOpsReleasePath,
    protheusOpsDebugPath,
    consumerId,
    batchLimit,
    identityHydrationPolicyPath,
    identityHydrationStatePath,
    residentMemoryStatePath
  };
}

function loadDaemonState(runtime: any) {
  const existing = readJson(runtime.daemonPath, {});
  return {
    schema_version: '1.0',
    running: existing && existing.running === true,
    mode: cleanText(existing && existing.mode || 'ambient', 40) || 'ambient',
    pid: Number.isFinite(Number(existing && existing.pid)) ? Number(existing.pid) : null,
    started_at: cleanText(existing && existing.started_at || '', 64) || null,
    updated_at: cleanText(existing && existing.updated_at || '', 64) || null,
    request_seq: Number.isFinite(Number(existing && existing.request_seq)) ? Number(existing.request_seq) : 0,
    run_seq: Number.isFinite(Number(existing && existing.run_seq)) ? Number(existing.run_seq) : 0,
    heartbeat_hours: runtime.mechPolicy.heartbeatHours,
    last_heartbeat_at: cleanText(existing && existing.last_heartbeat_at || '', 64) || null,
    next_heartbeat_at: cleanText(existing && existing.next_heartbeat_at || '', 64) || null,
    last_heartbeat_code: Number.isFinite(Number(existing && existing.last_heartbeat_code))
      ? Number(existing.last_heartbeat_code)
      : null,
    cockpit_watch: existing && existing.cockpit_watch && typeof existing.cockpit_watch === 'object'
      ? existing.cockpit_watch
      : {
          pid: null,
          restarts: 0,
          started_at: null,
          last_exit_at: null,
          last_exit_code: null
        },
    bridge_health: normalizedBridgeHealth(existing && existing.bridge_health),
    last_error: cleanText(existing && existing.last_error || '', 260) || null,
    last_cockpit_error: cleanText(existing && existing.last_cockpit_error || '', 260) || null,
    last_conversation_eye_error: cleanText(existing && existing.last_conversation_eye_error || '', 260) || null,
    cockpit_backoff_until: cleanText(existing && existing.cockpit_backoff_until || '', 64) || null,
    conversation_eye_backoff_until: cleanText(existing && existing.conversation_eye_backoff_until || '', 64) || null,
    resource_snapshot: existing && existing.resource_snapshot && typeof existing.resource_snapshot === 'object'
      ? existing.resource_snapshot
      : null,
    identity_hydration: existing && existing.identity_hydration && typeof existing.identity_hydration === 'object'
      ? existing.identity_hydration
      : null,
    resident_memory: existing && existing.resident_memory && typeof existing.resident_memory === 'object'
      ? existing.resident_memory
      : null,
    origin_integrity: existing && existing.origin_integrity && typeof existing.origin_integrity === 'object'
      ? {
          ok: existing.origin_integrity.ok === true,
          ts: cleanText(existing.origin_integrity.ts || '', 64) || null,
          trigger: cleanText(existing.origin_integrity.trigger || '', 80) || null,
          source: cleanText(existing.origin_integrity.source || '', 80) || null,
          status: Number.isFinite(Number(existing.origin_integrity.status)) ? Number(existing.origin_integrity.status) : null,
          reason: cleanText(existing.origin_integrity.reason || '', 260) || null,
          receipt_hash: cleanText(existing.origin_integrity.receipt_hash || '', 96) || null,
          safety_plane_state_hash: cleanText(existing.origin_integrity.safety_plane_state_hash || '', 128) || null,
          pending: existing.origin_integrity.pending === true,
          next_retry_at: cleanText(existing.origin_integrity.next_retry_at || '', 64) || null,
          last_success_ts: cleanText(existing.origin_integrity.last_success_ts || '', 64) || null
        }
      : null
  };
}

function persistDaemonState(runtime: any, state: any) {
  const normalized = {
    ...state,
    updated_at: nowIso()
  };
  writeJson(runtime.daemonPath, normalized);
  return normalized;
}

function emitLatest(runtime: any, payload: any) {
  writeJson(runtime.latestPath, payload);
  appendJsonl(runtime.receiptsPath, payload);
}

function recordCommand(runtime: any, command: string, args: string[], requestId: string) {
  appendJsonl(runtime.commandsPath, {
    ts: nowIso(),
    request_id: requestId,
    command,
    args: {
      _: args
    },
    status: 'queued'
  });
}

function tailFileLines(filePath: string, maxLines = 20) {
  const cap = Math.max(1, Math.min(200, Number(maxLines) || 20));
  try {
    if (!fs.existsSync(filePath)) return [];
    const lines = String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    if (lines.length <= cap) return lines;
    return lines.slice(lines.length - cap);
  } catch {
    return [];
  }
}

function parseJsonLineRecords(filePath: string, maxLines = 20) {
  return tailFileLines(filePath, maxLines)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((row) => !!row);
}

function runNode(script: string, args: string[], opts: any = {}) {
  const timeoutMs = Number.isFinite(Number(opts.timeoutMs)) && Number(opts.timeoutMs) > 0
    ? Math.floor(Number(opts.timeoutMs))
    : 0;
  const out = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd || ROOT,
    encoding: 'utf8',
    timeout: timeoutMs > 0 ? timeoutMs : undefined,
    killSignal: 'SIGTERM',
    env: {
      ...process.env,
      ...(opts.env || {})
    }
  });
  const timedOut = !!(out.error && (out.error as any).code === 'ETIMEDOUT');
  const spawnError = out.error ? String((out.error as any).message || out.error) : '';
  const stderrParts = [String(out.stderr || '').trim(), timedOut ? `spawn_timeout:${timeoutMs}` : '', spawnError].filter(Boolean);
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : (timedOut ? 124 : 1),
    stdout: String(out.stdout || ''),
    stderr: stderrParts.join('\n'),
    payload: parseJson(out.stdout)
  };
}

function resolveOriginIntegrityCommand(runtime: any) {
  const explicitBin = cleanText(process.env.PROTHEUS_OPS_BIN || '', 500);
  if (explicitBin) {
    return {
      source: 'explicit_bin',
      cmd: explicitBin,
      args: [
        'origin-integrity',
        'run',
        '--strict=1',
        `--policy=${runtime.originIntegrityPolicyPath}`
      ]
    };
  }

  if (fs.existsSync(runtime.protheusOpsReleasePath)) {
    return {
      source: 'release_bin',
      cmd: runtime.protheusOpsReleasePath,
      args: [
        'origin-integrity',
        'run',
        '--strict=1',
        `--policy=${runtime.originIntegrityPolicyPath}`
      ]
    };
  }

  if (fs.existsSync(runtime.protheusOpsDebugPath)) {
    return {
      source: 'debug_bin',
      cmd: runtime.protheusOpsDebugPath,
      args: [
        'origin-integrity',
        'run',
        '--strict=1',
        `--policy=${runtime.originIntegrityPolicyPath}`
      ]
    };
  }

  if (fs.existsSync(runtime.verifyScriptPath)) {
    return {
      source: 'verify_script',
      cmd: 'bash',
      args: [runtime.verifyScriptPath]
    };
  }

  return {
    source: 'cargo_run',
    cmd: 'cargo',
    args: [
      'run',
      '--quiet',
      '--manifest-path',
      runtime.protheusOpsManifestPath,
      '--bin',
      'protheus-ops',
      '--',
      'origin-integrity',
      'run',
      '--strict=1',
      `--policy=${runtime.originIntegrityPolicyPath}`
    ]
  };
}

function runOriginIntegrityCheck(runtime: any, trigger: string) {
  if (runtime.originIntegrityEnabled !== true) {
    return withReceipt({
      ok: true,
      type: 'protheusd_origin_integrity_check',
      ts: nowIso(),
      trigger: cleanText(trigger, 80) || 'unknown',
      skipped: true,
      reason: 'origin_integrity_disabled'
    });
  }

  const command = resolveOriginIntegrityCommand(runtime);
  const out = spawnSync(command.cmd, command.args, {
    cwd: runtime.workspaceRoot,
    encoding: 'utf8',
    timeout: runtime.originIntegrityTimeoutMs,
    killSignal: 'SIGTERM',
    env: {
      ...process.env
    }
  });
  const timedOut = !!(out.error && (out.error as any).code === 'ETIMEDOUT');
  const stderr = [
    String(out.stderr || '').trim(),
    timedOut ? `origin_integrity_timeout:${runtime.originIntegrityTimeoutMs}` : '',
    out.error ? cleanText((out.error as any).message || out.error, 260) : ''
  ].filter(Boolean).join('\n');
  const payload = parseJson(out.stdout);
  const ok = Number(out.status || 1) === 0 && !!(payload && payload.ok === true);
  const reason = ok
    ? null
    : cleanText(
      (payload && payload.error)
      || (payload && payload.reason)
      || stderr
      || 'origin_integrity_check_failed',
      260
    ) || 'origin_integrity_check_failed';

  const receipt = withReceipt({
    ok,
    type: 'protheusd_origin_integrity_check',
    ts: nowIso(),
    trigger: cleanText(trigger, 80) || 'unknown',
    source: command.source,
    cmd: cleanText(command.cmd, 260),
    args: Array.isArray(command.args) ? command.args : [],
    timeout_ms: runtime.originIntegrityTimeoutMs,
    status: Number.isFinite(Number(out.status)) ? Number(out.status) : (timedOut ? 124 : 1),
    reason,
    payload: payload && typeof payload === 'object' ? payload : null,
    stderr: stderr || null
  });
  const latestPath = path.join(runtime.stateRoot, 'origin_integrity', 'latest.json');
  const receiptsPath = path.join(runtime.stateRoot, 'origin_integrity', 'receipts.jsonl');
  writeJson(latestPath, receipt);
  appendJsonl(receiptsPath, receipt);
  return receipt;
}

function isOriginIntegrityTimeoutReason(reason: unknown) {
  const text = String(reason == null ? '' : reason).toLowerCase();
  if (!text) return false;
  return text.includes('origin_integrity_timeout:')
    || text.includes('spawn_timeout:')
    || text.includes('etimedout');
}

function shouldAllowDegradedOriginStartup(runtime: any, receipt: any) {
  return runtime.originIntegrityAllowTimeoutDegradedStart === true
    && isOriginIntegrityTimeoutReason(receipt && receipt.reason);
}

function buildOriginIntegrityState(receipt: any, trigger: string, extras: any = {}) {
  return {
    ok: receipt && receipt.ok === true,
    ts: cleanText(receipt && receipt.ts || '', 64) || nowIso(),
    trigger: cleanText(trigger, 80) || 'unknown',
    source: cleanText(receipt && receipt.source || '', 80) || null,
    status: Number.isFinite(Number(receipt && receipt.status)) ? Number(receipt.status) : 1,
    reason: cleanText(receipt && receipt.reason || '', 260) || 'origin_integrity_check_failed',
    receipt_hash: cleanText(receipt && receipt.receipt_hash || '', 96) || null,
    safety_plane_state_hash: cleanText(
      receipt && receipt.payload && receipt.payload.state_binding
        ? receipt.payload.state_binding.safety_plane_state_hash
        : '',
      128
    ) || null,
    pending: extras.pending === true,
    next_retry_at: cleanText(extras.next_retry_at || '', 64) || null,
    last_success_ts: cleanText(extras.last_success_ts || '', 64) || null
  };
}

function scheduleOriginIntegrityRetry(runtime: any) {
  return new Date(Date.now() + runtime.originIntegrityRetryMs).toISOString();
}

function maybeRetryOriginIntegrity(runtime: any, state: any, trigger: string) {
  const origin = state && state.origin_integrity && typeof state.origin_integrity === 'object'
    ? state.origin_integrity
    : null;
  if (!origin || origin.pending !== true) return state;
  const retryAtMs = origin.next_retry_at ? Date.parse(String(origin.next_retry_at)) : 0;
  if (Number.isFinite(retryAtMs) && retryAtMs > Date.now()) return state;

  const receipt = runOriginIntegrityCheck(runtime, trigger);
  if (receipt && receipt.ok === true) {
    state.origin_integrity = buildOriginIntegrityState(receipt, trigger, {
      pending: false,
      next_retry_at: null,
      last_success_ts: cleanText(receipt.ts || '', 64) || nowIso()
    });
    if (String(state.last_error || '').startsWith('origin_integrity_degraded:')) {
      state.last_error = null;
    }
    return state;
  }

  state.origin_integrity = buildOriginIntegrityState(receipt, trigger, {
    pending: true,
    next_retry_at: scheduleOriginIntegrityRetry(runtime),
    last_success_ts: origin && origin.last_success_ts ? origin.last_success_ts : null
  });
  state.last_error = cleanText(
    `origin_integrity_degraded:${receipt && receipt.reason ? receipt.reason : 'check_failed'}`,
    260
  ) || state.last_error;
  return state;
}

async function runHeartbeat(runtime: any, trigger: string) {
  const date = nowIso().slice(0, 10);
  const args = ['run', 'daily', date];
  const maxEyes = toInt(process.env.PROTHEUS_AMBIENT_MAX_EYES, 0, 0, 500);
  if (maxEyes > 0) args.push(`--max-eyes=${maxEyes}`);
  const primarySpine = await runSpineCommand(args, {
    cwdHint: runtime.root,
    runContext: 'heartbeat',
    timeoutMs: runtime.spineRunTimeoutMs
  });
  let spine = primarySpine;
  let spineFallbackApplied = false;
  if (!spine || spine.ok !== true) {
    const fallback = await runSpineCommand(
      ['status', '--mode=daily', `--date=${date}`],
      {
        cwdHint: runtime.root,
        runContext: 'heartbeat',
        timeoutMs: runtime.spineStatusTimeoutMs
      }
    );
    if (fallback && fallback.ok === true) {
      spineFallbackApplied = true;
      spine = {
        ...fallback,
        payload: {
          ...(fallback.payload && typeof fallback.payload === 'object' ? fallback.payload : {}),
          type: 'spine_status_heartbeat_fallback',
          heartbeat_fallback: true,
          primary_failure_reason: cleanText(
            primarySpine && primarySpine.payload && primarySpine.payload.reason
              ? primarySpine.payload.reason
              : primarySpine && primarySpine.stderr
                ? primarySpine.stderr
                : 'spine_run_daily_failed',
            240
          )
        }
      };
    }
  }

  const stateBefore = loadDaemonState(runtime);
  const backoffUntilMs = stateBefore.cockpit_backoff_until ? Date.parse(String(stateBefore.cockpit_backoff_until)) : 0;
  const cockpitBackoffActive = Number.isFinite(backoffUntilMs) && backoffUntilMs > Date.now();
  const cockpit = cockpitBackoffActive
    ? {
        status: 0,
        stdout: '',
        stderr: '',
        payload: {
          ok: true,
          skipped: true,
          reason: cleanText(`cooldown_until:${stateBefore.cockpit_backoff_until}`, 120)
        }
      }
    : runNode(
      path.join(runtime.root, 'systems', 'ops', 'cockpit_harness.js'),
      [
        'once',
        `--consumer=${runtime.consumerId}`,
        `--limit=${runtime.batchLimit}`,
        `--inbox-dir=${runtime.cockpitInboxDir}`
      ],
      {
        cwd: runtime.root,
        timeoutMs: runtime.cockpitOnceTimeoutMs,
        env: {
          COCKPIT_CONDUIT_PROBE_TIMEOUT_MS: String(runtime.cockpitConduitTimeoutMs),
          PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS: String(runtime.cockpitConduitTimeoutMs),
          PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS: String(Math.max(runtime.cockpitConduitTimeoutMs + 1000, 5000))
        }
      }
    );
  const conversationBackoffUntilMs = stateBefore.conversation_eye_backoff_until
    ? Date.parse(String(stateBefore.conversation_eye_backoff_until))
    : 0;
  const conversationBackoffActive = Number.isFinite(conversationBackoffUntilMs) && conversationBackoffUntilMs > Date.now();
  const conversationEye = runtime.conversationEyeEnabled
    ? (
      conversationBackoffActive
        ? {
            status: 0,
            stdout: '',
            stderr: '',
            payload: {
              ok: true,
              skipped: true,
              reason: cleanText(`cooldown_until:${stateBefore.conversation_eye_backoff_until}`, 120)
            }
          }
        : runNode(
          path.join(runtime.root, 'habits', 'scripts', 'external_eyes.js'),
          ['run', '--eye=conversation_eye', '--max-eyes=1'],
          {
            cwd: runtime.root,
            timeoutMs: runtime.conversationEyeTimeoutMs,
            env: {
              EYES_PARALLEL_ENABLED: '0',
              EYES_MAX_PARALLEL: '1',
              EYES_COLLECT_RETRY_MAX_ATTEMPTS: '1',
              CONVERSATION_EYE_MAX_ITEMS: '3',
              CONVERSATION_EYE_MAX_ROWS: '24',
              CONVERSATION_EYE_MAX_WORK_MS: '7000'
            }
          }
        )
    )
    : {
        status: 0,
        stdout: '',
        stderr: '',
        payload: { ok: true, skipped: true, reason: 'conversation_eye_disabled' }
      };
  const runtimeRetention = runtime.runtimeRetentionHookEnabled
    ? runNode(
      path.join(runtime.root, 'systems', 'ops', 'runtime_retention_prune.js'),
      ['run', '--apply=1', `--policy=${runtime.runtimeRetentionPolicyPath}`],
      {
        cwd: runtime.root,
        timeoutMs: 15000
      }
    )
    : {
        status: 0,
        stdout: '',
        stderr: '',
        payload: { ok: true, skipped: true, reason: 'runtime_retention_hook_disabled' }
      };

  const state = loadDaemonState(runtime);
  state.run_seq = Number(state.run_seq || 0) + 1;
  state.last_heartbeat_at = nowIso();
  state.next_heartbeat_at = new Date(Date.now() + runtime.heartbeatMs).toISOString();
  state.last_heartbeat_code = spine && spine.ok ? 0 : 1;
  state.cockpit_backoff_until = cockpitBackoffActive ? stateBefore.cockpit_backoff_until : null;
  state.conversation_eye_backoff_until = conversationBackoffActive ? stateBefore.conversation_eye_backoff_until : null;
  const bridgeReason = bridgeReasonFromSpineResult(spine);
  if (bridgeReason) {
    markBridgeDegraded(state, runtime, bridgeReason, `heartbeat:${trigger}`);
  } else if (spine && spine.ok === true) {
    clearBridgeDegraded(state, `heartbeat:${trigger}`);
  }
  if (!spine || spine.ok !== true) {
    state.last_error = cleanText(
      spine && spine.payload && spine.payload.reason
        ? spine.payload.reason
        : spine && spine.stderr
          ? spine.stderr
          : 'spine_heartbeat_failed',
      260
    );
    state.last_cockpit_error = null;
    state.last_conversation_eye_error = null;
  } else if (cockpit.status !== 0) {
    state.last_error = null;
    state.last_cockpit_error = cleanText(cockpit.stderr || 'cockpit_ingest_failed', 260);
    if (shouldBackoffCockpit(cockpit.stderr)) {
      state.cockpit_backoff_until = new Date(Date.now() + runtime.cockpitCooldownMs).toISOString();
    }
    state.last_conversation_eye_error = null;
  } else if (conversationEye.status !== 0) {
    state.last_error = null;
    state.last_cockpit_error = null;
    state.last_conversation_eye_error = cleanText(conversationEye.stderr || 'conversation_eye_failed', 260);
    if (shouldBackoffCockpit(conversationEye.stderr)) {
      state.conversation_eye_backoff_until = new Date(Date.now() + runtime.conversationEyeCooldownMs).toISOString();
    }
  } else if (runtimeRetention.status !== 0) {
    state.last_error = cleanText(runtimeRetention.stderr || 'runtime_retention_failed', 260);
    state.last_cockpit_error = null;
    state.last_conversation_eye_error = null;
  } else {
    state.last_error = null;
    state.last_cockpit_error = null;
    state.last_conversation_eye_error = null;
  }
  state.resource_snapshot = collectResourceSnapshot(runtime.memoryPressureRatio);
  state.identity_hydration = buildIdentityHydrationSnapshot(runtime);
  writeJson(runtime.identityHydrationStatePath, state.identity_hydration);
  state.resident_memory = await buildResidentMemorySnapshot(runtime);
  writeJson(runtime.residentMemoryStatePath, state.resident_memory);
  persistDaemonState(runtime, state);

  const receipt = withReceipt({
    ok: state.last_heartbeat_code === 0,
    shadow_only: false,
    type: 'protheus_job_runner_tick',
    ts: nowIso(),
    trigger: cleanText(trigger, 80) || 'heartbeat',
    processed: 1,
    spine: {
      ok: spine && spine.ok === true,
      status: Number.isFinite(Number(spine && spine.status)) ? Number(spine.status) : 1,
      type: spine && spine.payload && spine.payload.type ? spine.payload.type : 'spine_run',
      heartbeat_fallback: spineFallbackApplied,
      primary_status: Number.isFinite(Number(primarySpine && primarySpine.status))
        ? Number(primarySpine.status)
        : null
    },
    cockpit: {
      ok: cockpit.status === 0,
      status: cockpit.status,
      type: cockpit.payload && cockpit.payload.type ? cockpit.payload.type : 'cockpit_context_envelope',
      skipped: !!(cockpit.payload && cockpit.payload.skipped)
    },
    conversation_eye: {
      enabled: runtime.conversationEyeEnabled === true,
      ok: conversationEye.status === 0,
      status: conversationEye.status,
      type: conversationEye.payload && conversationEye.payload.type ? conversationEye.payload.type : 'external_eyes_run',
      skipped: !!(conversationEye.payload && conversationEye.payload.skipped)
    },
    runtime_retention: {
      enabled: runtime.runtimeRetentionHookEnabled === true,
      ok: runtimeRetention.status === 0,
      status: runtimeRetention.status,
      type: runtimeRetention.payload && runtimeRetention.payload.type ? runtimeRetention.payload.type : 'runtime_retention_prune',
      skipped: !!(runtimeRetention.payload && runtimeRetention.payload.skipped)
    },
    run_seq: state.run_seq,
    next_heartbeat_at: state.next_heartbeat_at,
    bridge_health: normalizedBridgeHealth(state.bridge_health),
    resource: state.resource_snapshot,
    identity_hydration: state.identity_hydration,
    resident_memory: state.resident_memory
  });
  emitLatest(runtime, receipt);
  return receipt;
}

async function runBridgeProbe(runtime: any, trigger: string) {
  const date = nowIso().slice(0, 10);
  const probe = await runSpineCommand(
    ['status', '--mode=daily', `--date=${date}`],
    {
      cwdHint: runtime.root,
      runContext: 'bridge_probe',
      timeoutMs: runtime.spineStatusTimeoutMs
    }
  );
  const reason = cleanText(
    bridgeReasonFromSpineResult(probe)
      || (probe && probe.payload && probe.payload.reason ? probe.payload.reason : '')
      || (probe && probe.stderr ? probe.stderr : '')
      || 'conduit_bridge_probe_failed',
    260
  ) || 'conduit_bridge_probe_failed';
  return {
    ok: probe && probe.ok === true,
    status: Number.isFinite(Number(probe && probe.status)) ? Number(probe.status) : 1,
    reason,
    trigger: cleanText(trigger, 80) || 'probe',
    probe
  };
}

async function runAmbientLoop(argv: string[]) {
  const runtime = resolveRuntime(argv);
  let state = loadDaemonState(runtime);
  const pid = process.pid;

  const originIntegrity = runOriginIntegrityCheck(runtime, 'ambient_startup');
  const allowDegradedOriginStart = shouldAllowDegradedOriginStartup(runtime, originIntegrity);
  if (originIntegrity.ok !== true && runtime.originIntegrityRequirePass === true && !allowDegradedOriginStart) {
    state.running = false;
    state.mode = 'stopped';
    state.pid = null;
    state.last_error = cleanText(`origin_integrity_failed:${originIntegrity.reason || 'check_failed'}`, 260);
    state.origin_integrity = buildOriginIntegrityState(originIntegrity, 'ambient_startup', {
      pending: false,
      next_retry_at: null,
      last_success_ts: null
    });
    persistDaemonState(runtime, state);
    emitLatest(runtime, withReceipt({
      ok: false,
      shadow_only: false,
      type: 'protheus_daemon_control',
      ts: nowIso(),
      command: '__ambient-loop-startup__',
      blocked_by: 'origin_integrity_check_failed',
      origin_integrity: originIntegrity
    }));
    process.exit(1);
    return;
  }

  state.running = true;
  state.mode = 'ambient';
  state.pid = pid;
  if (!state.started_at) state.started_at = nowIso();
  state.updated_at = nowIso();
  state.heartbeat_hours = runtime.mechPolicy.heartbeatHours;
  state.next_heartbeat_at = nowIso();
  state.origin_integrity = buildOriginIntegrityState(originIntegrity, 'ambient_startup', {
    pending: originIntegrity.ok !== true,
    next_retry_at: originIntegrity.ok === true ? null : scheduleOriginIntegrityRetry(runtime),
    last_success_ts: originIntegrity.ok === true
      ? (cleanText(originIntegrity.ts || '', 64) || nowIso())
      : null
  });
  if (originIntegrity.ok !== true) {
    state.last_error = cleanText(
      `origin_integrity_degraded:${originIntegrity.reason || 'check_failed'}`,
      260
    ) || state.last_error;
  }
  state.identity_hydration = buildIdentityHydrationSnapshot(runtime);
  writeJson(runtime.identityHydrationStatePath, state.identity_hydration);
  state.resident_memory = await buildResidentMemorySnapshot(runtime);
  writeJson(runtime.residentMemoryStatePath, state.resident_memory);
  const startupGate = readConduitRuntimeGate(runtime.root);
  const startupGateReason = bridgeReasonFromRuntimeGate(startupGate);
  if (startupGateReason) {
    markBridgeDegraded(state, runtime, startupGateReason, 'startup_runtime_gate');
  }
  persistDaemonState(runtime, state);

  let shuttingDown = false;
  let heartbeatInFlight = false;
  let watchProc: any = null;

  const watcherRestartDelayMs = (restarts: number) => {
    const gate = readConduitRuntimeGate(runtime.root);
    if (gate && gate.gate_active === true) {
      const remaining = Number(gate.remaining_ms || 0);
      return Math.max(5000, Math.min(5 * 60 * 1000, Number.isFinite(remaining) ? remaining : 60000));
    }
    const safeRestarts = Math.max(0, Number(restarts || 0));
    return Math.min(5 * 60 * 1000, Math.max(1000, 1000 * Math.pow(2, Math.min(8, safeRestarts))));
  };

  const launchWatcher = () => {
    const script = path.join(runtime.root, 'systems', 'ops', 'cockpit_harness.js');
    const args = [
      script,
      'watch',
      `--consumer=${runtime.consumerId}`,
      `--limit=${runtime.batchLimit}`,
      '--once=1',
      `--inbox-dir=${runtime.cockpitInboxDir}`
    ];
    const child = spawn(process.execPath, args, {
      cwd: runtime.root,
      detached: false,
      stdio: 'ignore',
      env: {
        ...process.env,
        COCKPIT_CONSUMER_ID: runtime.consumerId,
        COCKPIT_INBOX_DIR: runtime.cockpitInboxDir,
        COCKPIT_CONDUIT_PROBE_TIMEOUT_MS: String(runtime.cockpitConduitTimeoutMs),
        PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS: String(runtime.cockpitConduitTimeoutMs),
        PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS: String(Math.max(runtime.cockpitConduitTimeoutMs + 1000, 5000))
      }
    });
    const next = loadDaemonState(runtime);
    next.cockpit_watch = {
      ...(next.cockpit_watch || {}),
      pid: Number.isFinite(Number(child.pid)) ? Number(child.pid) : null,
      started_at: nowIso(),
      restarts: Number(next.cockpit_watch && next.cockpit_watch.restarts || 0)
    };
    persistDaemonState(runtime, next);
    child.on('exit', (code: number) => {
      const row = loadDaemonState(runtime);
      row.cockpit_watch = {
        ...(row.cockpit_watch || {}),
        pid: null,
        last_exit_at: nowIso(),
        last_exit_code: Number.isFinite(Number(code)) ? Number(code) : null,
        restarts: Number(row.cockpit_watch && row.cockpit_watch.restarts || 0) + (shuttingDown ? 0 : 1)
      };
      persistDaemonState(runtime, row);
      if (!shuttingDown) {
        const restarts = Number(row.cockpit_watch && row.cockpit_watch.restarts || 0);
        const delayMs = watcherRestartDelayMs(restarts);
        setTimeout(() => {
          if (!shuttingDown) {
            watchProc = launchWatcher();
          }
        }, delayMs);
      }
    });
    return child;
  };

  const shutdown = (reason: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    if (watchProc && Number.isFinite(Number(watchProc.pid))) {
      try { process.kill(Number(watchProc.pid), 'SIGTERM'); } catch {}
    }
    const row = loadDaemonState(runtime);
    row.running = false;
    row.mode = 'stopped';
    row.last_error = reason ? cleanText(reason, 200) : row.last_error;
    persistDaemonState(runtime, row);
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('signal_sigterm'));
  process.on('SIGINT', () => shutdown('signal_sigint'));

  watchProc = launchWatcher();

  const maybeHeartbeat = async (trigger: string) => {
    if (heartbeatInFlight || shuttingDown) return;
    let row = loadDaemonState(runtime);
    row = maybeRetryOriginIntegrity(runtime, row, `ambient_${trigger}`);
    persistDaemonState(runtime, row);
    const gate = readConduitRuntimeGate(runtime.root);
    const gateReason = bridgeReasonFromRuntimeGate(gate);
    if (gateReason) {
      const previous = normalizedBridgeHealth(row.bridge_health);
      const previousProbeMs = previous.next_probe_at ? Date.parse(String(previous.next_probe_at)) : 0;
      if (
        previous.degraded === true
        && previous.reason === gateReason
        && Number.isFinite(previousProbeMs)
        && previousProbeMs > Date.now()
      ) {
        return;
      }
      markBridgeDegraded(row, runtime, gateReason, `runtime_gate:${trigger}`);
      const persisted = persistDaemonState(runtime, row);
      if (
        previous.degraded !== true
        || previous.reason !== persisted.bridge_health.reason
        || previous.next_probe_at !== persisted.bridge_health.next_probe_at
      ) {
        emitLatest(runtime, withReceipt({
          ok: false,
          shadow_only: false,
          type: 'protheus_bridge_health',
          ts: nowIso(),
          trigger: cleanText(trigger, 80) || 'interval',
          action: 'runtime_gate_active',
          bridge_health: normalizedBridgeHealth(persisted.bridge_health),
          conduit_runtime_gate: gate
        }));
      }
      return;
    }

    const bridgeHealth = normalizedBridgeHealth(row.bridge_health);
    if (bridgeHealth.degraded === true) {
      const degradedReason = cleanText(bridgeHealth.reason || '', 260);
      const degradedFromRuntimeGate = !!bridgeReasonMarker(degradedReason);
      const gateCleared = degradedFromRuntimeGate && !(gate && gate.gate_active === true);
      if (!gateCleared && !bridgeProbeDue(row)) return;
      heartbeatInFlight = true;
      try {
        const probe = await runBridgeProbe(runtime, trigger);
        row = loadDaemonState(runtime);
        if (!probe.ok) {
          markBridgeDegraded(row, runtime, probe.reason, `bridge_probe:${trigger}`);
          const persisted = persistDaemonState(runtime, row);
          emitLatest(runtime, withReceipt({
            ok: false,
            shadow_only: false,
            type: 'protheus_bridge_probe',
            ts: nowIso(),
            trigger: cleanText(trigger, 80) || 'interval',
            bridge_probe: {
              ok: false,
              status: probe.status,
              reason: cleanText(probe.reason, 260) || 'conduit_bridge_probe_failed'
            },
            bridge_health: normalizedBridgeHealth(persisted.bridge_health)
          }));
          return;
        }

        clearBridgeDegraded(row, `bridge_probe:${trigger}`);
        row.next_heartbeat_at = nowIso();
        const persisted = persistDaemonState(runtime, row);
        emitLatest(runtime, withReceipt({
          ok: true,
          shadow_only: false,
          type: 'protheus_bridge_probe',
          ts: nowIso(),
          trigger: cleanText(trigger, 80) || 'interval',
          bridge_probe: {
            ok: true,
            status: probe.status
          },
          bridge_health: normalizedBridgeHealth(persisted.bridge_health)
        }));
      } finally {
        heartbeatInFlight = false;
      }
      row = loadDaemonState(runtime);
    }

    const nextDueMs = row.next_heartbeat_at ? Date.parse(String(row.next_heartbeat_at)) : Date.now();
    if (Number.isFinite(nextDueMs) && Date.now() < nextDueMs) return;
    heartbeatInFlight = true;
    try {
      await runHeartbeat(runtime, trigger);
    } finally {
      heartbeatInFlight = false;
    }
  };

  await maybeHeartbeat('startup');
  setInterval(() => {
    if (shuttingDown) return;
    const row = loadDaemonState(runtime);
    row.running = true;
    row.mode = 'ambient';
    row.pid = pid;
    persistDaemonState(runtime, row);
    maybeHeartbeat('interval').catch(() => {});
  }, runtime.pollMs);
}

function runLegacy(command: string, extraArgs: string[], opts: { exitOnFinish?: boolean } = {}) {
  const script = path.join(__dirname, 'protheus_control_plane.js');
  const args = [script, command, ...extraArgs];
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  const status = Number.isFinite(r.status) ? Number(r.status) : 1;
  if (opts.exitOnFinish !== false) process.exit(status);
  return { ok: status === 0, status };
}

function runConduitEnabled(argv: string[]) {
  if (argv.includes('--no-conduit')) return false;
  if (argv.includes('--conduit')) return true;
  return process.env.PROTHEUS_CONDUIT_ENABLED === '1';
}

function allowLegacyFallback(argv: string[]) {
  if (argv.includes('--allow-legacy-fallback')) return true;
  return process.env.PROTHEUS_ALLOW_LEGACY_FALLBACK === '1';
}

function conduitStrict(argv: string[], command: string) {
  if (!['start', 'stop', 'status'].includes(command)) return false;
  if (allowLegacyFallback(argv)) return false;
  return String(process.env.PROTHEUS_CONDUIT_STRICT || '0').trim() === '1';
}

function stripControlFlags(argv: string[]) {
  return argv.filter((arg) => (
    arg !== '--conduit'
    && arg !== '--no-conduit'
    && arg !== '--allow-legacy-fallback'
    && arg !== '--autostart'
    && arg !== '--no-autostart'
    && arg !== '--cockpit'
    && arg !== '--no-cockpit'
  ));
}

function ambientAutostartEnabled(argv: string[]) {
  if (argv.includes('--no-autostart')) return false;
  if (argv.includes('--autostart')) return true;
  return String(process.env.PROTHEUS_AMBIENT_AUTOSTART || '1').trim() !== '0';
}

function parseAgentId(args: string[]) {
  const explicit = args.find((arg) => arg.startsWith('--agent='));
  if (explicit) return String(explicit.slice('--agent='.length) || '').trim() || 'protheus-default';
  return 'protheus-default';
}

function conduitRouteTimeoutMs() {
  return toInt(process.env.PROTHEUSD_CONDUIT_ROUTE_TIMEOUT_MS, 8000, 1000, 120000);
}

type ConduitRouteResult = {
  routed: boolean;
  ok: boolean;
  error?: string;
};

async function runConduit(command: string, extraArgs: string[]): Promise<ConduitRouteResult> {
  if (!['start', 'stop', 'status'].includes(command)) {
    return { routed: false, ok: false, error: 'unsupported_command' };
  }

  // Prefer Rust/core daemon-control lane before direct conduit client wiring.
  try {
    const routed = await runOpsDomainCommand(
      'daemon-control',
      [command, ...extraArgs],
      {
        runContext: 'protheusd_route',
        timeoutMs: conduitRouteTimeoutMs(),
        stdioTimeoutMs: Math.max(1000, conduitRouteTimeoutMs())
      }
    );
    const status = Number.isFinite(routed && routed.status) ? Number(routed.status) : 1;
    if (routed && routed.payload) {
      process.stdout.write(`${JSON.stringify(routed.payload)}\n`);
    }
    if (status === 0) {
      return { routed: true, ok: true };
    }
  } catch {
    // Fall through to legacy direct conduit route for compatibility.
  }

  let ConduitClient: any;
  try {
    ({ ConduitClient } = require('../conduit/conduit-client'));
  } catch {
    ({ ConduitClient } = require('../conduit/conduit-client.ts'));
  }
  const daemonCommand = process.env.CONDUIT_DAEMON_CMD || 'cargo';
  const daemonArgs = process.env.CONDUIT_DAEMON_ARGS
    ? process.env.CONDUIT_DAEMON_ARGS.split(' ').filter(Boolean)
    : ['run', '--quiet', '-p', 'conduit', '--bin', 'conduit_daemon'];

  const client = ConduitClient.overStdio(daemonCommand, daemonArgs, process.cwd());
  try {
    const requestId = `protheusd-${Date.now()}`;
    const message =
      command === 'start'
        ? { type: 'start_agent', agent_id: parseAgentId(extraArgs) }
        : command === 'stop'
          ? { type: 'stop_agent', agent_id: parseAgentId(extraArgs) }
          : { type: 'get_system_status' };
    const timeoutMs = conduitRouteTimeoutMs();
    const response = await Promise.race([
      client.send(message as any, requestId),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`conduit_route_timeout:${timeoutMs}`)), timeoutMs);
      })
    ]);
    process.stdout.write(`${JSON.stringify(response)}\n`);
    return { routed: true, ok: response.validation.ok };
  } catch (error: any) {
    return {
      routed: false,
      ok: false,
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    await client.close();
  }
}

function statusReceipt(runtime: any, state: any) {
  const running = isPidAlive(state.pid);
  const originIntegrity = state && state.origin_integrity && typeof state.origin_integrity === 'object'
    ? state.origin_integrity
    : null;
  const resourceSnapshot = state && state.resource_snapshot && typeof state.resource_snapshot === 'object'
    ? state.resource_snapshot
    : collectResourceSnapshot(runtime.memoryPressureRatio);
  const daemon = {
    running,
    mode: running ? 'ambient' : 'stopped',
    pid: running ? state.pid : null,
    started_at: state.started_at || null,
    updated_at: state.updated_at || null,
    run_seq: Number(state.run_seq || 0),
    heartbeat_hours: runtime.mechPolicy.heartbeatHours,
    last_heartbeat_at: state.last_heartbeat_at || null,
    next_heartbeat_at: state.next_heartbeat_at || null,
    last_heartbeat_code: Number.isFinite(Number(state.last_heartbeat_code))
      ? Number(state.last_heartbeat_code)
      : null,
    last_error: cleanText(state.last_error || '', 260) || null,
    last_cockpit_error: cleanText(state.last_cockpit_error || '', 260) || null,
    last_conversation_eye_error: cleanText(state.last_conversation_eye_error || '', 260) || null,
    cockpit_backoff_until: cleanText(state.cockpit_backoff_until || '', 64) || null,
    conversation_eye_backoff_until: cleanText(state.conversation_eye_backoff_until || '', 64) || null,
    cockpit_watch: state.cockpit_watch || null,
    origin_integrity: originIntegrity
  };
  const mechLatest = readJson(runtime.mechPolicy.statusPath, null);
  const attentionLatest = readJson(runtime.mechPolicy.attentionLatestPath, null);
  const personaLatest = readJson(runtime.mechPolicy.personaLatestPath, null);
  const dopamineLatest = readJson(runtime.mechPolicy.dopamineLatestPath, null);
  const cockpitLatest = readJson(runtime.cockpitLatestPath, null);
  const cockpitState = readJson(runtime.cockpitStatePath, null);
  const conversationEyeIndex = readJson(runtime.conversationEyeIndexPath, null);
  const identityHydration = state && state.identity_hydration && typeof state.identity_hydration === 'object'
    ? state.identity_hydration
    : readJson(runtime.identityHydrationStatePath, null);
  const residentMemory = state && state.resident_memory && typeof state.resident_memory === 'object'
    ? state.resident_memory
    : readJson(runtime.residentMemoryStatePath, null);
  const conduitRuntimeGate = readConduitRuntimeGate(runtime.root);
  const heartbeatHealthy = daemon.last_heartbeat_code === 0;
  const ambientConfigured = !!(mechLatest && mechLatest.active === true);
  const bridgeHealth = normalizedBridgeHealth(state.bridge_health);
  const originPending = !!(originIntegrity && originIntegrity.pending === true);
  const ambientHealthy = ambientConfigured && running && heartbeatHealthy && bridgeHealth.degraded !== true && !originPending;
  const degradedReason = bridgeHealth.degraded === true
    ? (bridgeHealth.reason || 'bridge_degraded')
    : conduitRuntimeGate.gate_active === true
    ? 'conduit_runtime_gate_active'
    : originPending
    ? 'origin_integrity_pending'
    : !ambientConfigured
    ? 'ambient_policy_inactive'
    : !running
      ? 'daemon_stopped'
      : !heartbeatHealthy
        ? (daemon.last_error ? 'heartbeat_failed' : 'heartbeat_missing')
        : null;

  return withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheus_control_plane_status',
    ts: nowIso(),
    updated: state.updated_at || nowIso(),
    daemon,
    ambient_mode: {
      active: ambientHealthy,
      configured: ambientConfigured,
      healthy: ambientHealthy,
      degraded_reason: degradedReason,
      bridge_health: bridgeHealth,
      manual_triggers_allowed: runtime.mechPolicy.manualTriggersAllowed,
      heartbeat_hours: runtime.mechPolicy.heartbeatHours
    },
    conduit_runtime_gate: conduitRuntimeGate,
    origin_integrity: originIntegrity,
    cockpit: {
      available: !!cockpitLatest,
      path: runtime.cockpitLatestPath,
      sequence: cockpitLatest && Number(cockpitLatest.sequence || 0),
      consumer_id: cockpitLatest && cockpitLatest.consumer_id || (cockpitState && cockpitState.consumer_id) || null,
      last_ingest_ts: cockpitLatest && cockpitLatest.ts || (cockpitState && cockpitState.last_ingest_ts) || null,
      batch_count: cockpitLatest && cockpitLatest.attention ? Number(cockpitLatest.attention.batch_count || 0) : 0
    },
    conversation_eye: {
      enabled: runtime.conversationEyeEnabled === true,
      path: runtime.conversationEyeIndexPath,
      available: !!conversationEyeIndex,
      updated_ts: conversationEyeIndex && cleanText(conversationEyeIndex.updated_ts || '', 64) || null,
      emitted_nodes: conversationEyeIndex && conversationEyeIndex.emitted_node_ids
        ? Object.keys(conversationEyeIndex.emitted_node_ids).length
        : 0
    },
    identity_hydration: identityHydration && typeof identityHydration === 'object'
      ? {
          enabled: identityHydration.enabled !== false,
          startup_token_budget: Number(identityHydration.startup_token_budget || 0),
          estimated_tokens_loaded: Number(identityHydration.estimated_tokens_loaded || 0),
          loaded_count: Array.isArray(identityHydration.files_loaded) ? identityHydration.files_loaded.length : 0,
          deferred_count: Array.isArray(identityHydration.files_deferred) ? identityHydration.files_deferred.length : 0,
          ts: cleanText(identityHydration.ts || '', 64) || null
        }
      : null,
    resident_memory: residentMemory && typeof residentMemory === 'object'
      ? {
          rust_authoritative: residentMemory.rust_authoritative === true,
          memory_ambient_ok: residentMemory.health && residentMemory.health.memory_ambient_ok === true,
          sqlite_path: cleanText(residentMemory.sqlite_path || '', 260) || null,
          conversation_nodes: residentMemory.hotset ? Number(residentMemory.hotset.conversation_nodes || 0) : 0,
          ts: cleanText(residentMemory.ts || '', 64) || null
        }
      : null,
    resource: resourceSnapshot,
    attention: attentionLatest && typeof attentionLatest === 'object'
      ? {
          queue_depth: Number(attentionLatest.queue_depth || 0),
          last_action: cleanText(attentionLatest.last_action || '', 80) || null,
          ts: cleanText(attentionLatest.ts || '', 64) || null
        }
      : null,
    persona: personaLatest && typeof personaLatest === 'object'
      ? {
          ts: cleanText(personaLatest.ts || '', 64) || null,
          type: cleanText(personaLatest.type || '', 80) || null
        }
      : null,
    dopamine: dopamineLatest && typeof dopamineLatest === 'object'
      ? {
          ts: cleanText(dopamineLatest.ts || '', 64) || null,
          type: cleanText(dopamineLatest.type || '', 80) || null
        }
      : null
  });
}

function startDaemon(runtime: any, argv: string[], opts: { exitOnFinish?: boolean } = {}) {
  const exitOnFinish = opts.exitOnFinish !== false;
  const state = loadDaemonState(runtime);
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'start', argv, requestId);

  if (isPidAlive(state.pid)) {
    const out = withReceipt({
      ok: true,
      shadow_only: false,
      type: 'protheus_daemon_control',
      ts: nowIso(),
      command: 'start',
      request_id: requestId,
      running: true,
      mode: 'ambient',
      already_running: true,
      pid: state.pid
    });
    emitLatest(runtime, out);
    if (exitOnFinish) {
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(0);
    }
    return out;
  }

  const originIntegrity = runOriginIntegrityCheck(runtime, 'start');
  const allowDegradedOriginStart = shouldAllowDegradedOriginStartup(runtime, originIntegrity);
  if (originIntegrity.ok !== true && runtime.originIntegrityRequirePass === true && !allowDegradedOriginStart) {
    const next = loadDaemonState(runtime);
    next.running = false;
    next.mode = 'stopped';
    next.pid = null;
    next.request_seq = Number(next.request_seq || 0) + 1;
    next.last_error = cleanText(`origin_integrity_failed:${originIntegrity.reason || 'check_failed'}`, 260);
    next.origin_integrity = buildOriginIntegrityState(originIntegrity, 'start', {
      pending: false,
      next_retry_at: null,
      last_success_ts: null
    });
    persistDaemonState(runtime, next);
    const out = withReceipt({
      ok: false,
      shadow_only: false,
      type: 'protheus_daemon_control',
      ts: nowIso(),
      command: 'start',
      request_id: requestId,
      running: false,
      mode: 'stopped',
      blocked_by: 'origin_integrity_check_failed',
      origin_integrity: originIntegrity
    });
    emitLatest(runtime, out);
    if (exitOnFinish) {
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(1);
    }
    return out;
  }

  const script = path.join(__dirname, 'protheusd.js');
  const childArgs = [script, INTERNAL_AMBIENT_LOOP, `--policy=${runtime.policyPath}`, `--inbox-dir=${runtime.cockpitInboxDir}`, `--consumer=${runtime.consumerId}`, `--limit=${runtime.batchLimit}`];
  const child = spawn(process.execPath, childArgs, {
    cwd: runtime.root,
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      MECH_SUIT_MODE_POLICY_PATH: runtime.mechPolicyPath
    }
  });
  child.unref();

  const next = loadDaemonState(runtime);
  next.running = true;
  next.mode = 'ambient';
  next.pid = Number.isFinite(Number(child.pid)) ? Number(child.pid) : null;
  next.started_at = nowIso();
  next.request_seq = Number(next.request_seq || 0) + 1;
  next.heartbeat_hours = runtime.mechPolicy.heartbeatHours;
  next.next_heartbeat_at = nowIso();
  next.origin_integrity = buildOriginIntegrityState(originIntegrity, 'start', {
    pending: originIntegrity.ok !== true,
    next_retry_at: originIntegrity.ok === true ? null : scheduleOriginIntegrityRetry(runtime),
    last_success_ts: originIntegrity.ok === true
      ? (cleanText(originIntegrity.ts || '', 64) || nowIso())
      : null
  });
  if (originIntegrity.ok !== true) {
    next.last_error = cleanText(
      `origin_integrity_degraded:${originIntegrity.reason || 'check_failed'}`,
      260
    ) || next.last_error;
  }
  persistDaemonState(runtime, next);

  const out = withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheus_daemon_control',
    ts: nowIso(),
    command: 'start',
    request_id: requestId,
    running: true,
    mode: 'ambient',
    pid: next.pid,
    degraded_start: originIntegrity.ok !== true,
    origin_integrity_pending: next.origin_integrity && next.origin_integrity.pending === true
  });
  emitLatest(runtime, out);
  if (exitOnFinish) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  return out;
}

function stopDaemon(runtime: any, argv: string[], opts: { exitOnFinish?: boolean } = {}) {
  const exitOnFinish = opts.exitOnFinish !== false;
  const state = loadDaemonState(runtime);
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'stop', argv, requestId);

  let stoppedPid = null;
  if (isPidAlive(state.pid)) {
    stoppedPid = Number(state.pid);
    try { process.kill(stoppedPid, 'SIGTERM'); } catch {}
  }

  const next = loadDaemonState(runtime);
  next.running = false;
  next.mode = 'stopped';
  next.pid = null;
  next.request_seq = Number(next.request_seq || 0) + 1;
  next.updated_at = nowIso();
  next.next_heartbeat_at = null;
  persistDaemonState(runtime, next);

  const out = withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheus_daemon_control',
    ts: nowIso(),
    command: 'stop',
    request_id: requestId,
    running: false,
    mode: 'stopped',
    stopped_pid: stoppedPid
  });
  emitLatest(runtime, out);
  if (exitOnFinish) {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(0);
  }
  return out;
}

async function runTick(runtime: any, argv: string[]) {
  const state = loadDaemonState(runtime);
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'tick', argv, requestId);
  const out = await runHeartbeat(runtime, 'manual_tick');
  const enriched = withReceipt({
    ...out,
    request_id: requestId
  });
  emitLatest(runtime, enriched);
  process.stdout.write(`${JSON.stringify(enriched)}\n`);
  process.exit(enriched.ok ? 0 : 1);
}

function runAttach(runtime: any, argv: string[]) {
  let state = loadDaemonState(runtime);
  const attached = isPidAlive(state.pid);
  if (!attached && runtime.mechPolicy.enabled === true && ambientAutostartEnabled(argv)) {
    startDaemon(runtime, argv, { exitOnFinish: false });
    state = loadDaemonState(runtime);
  }
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'attach', argv, requestId);
  const status = statusReceipt(runtime, state);
  const out = withReceipt({
    ok: status && status.daemon && status.daemon.running === true,
    shadow_only: false,
    type: 'protheus_daemon_attach',
    ts: nowIso(),
    request_id: requestId,
    attach: {
      attached: status && status.daemon && status.daemon.running === true,
      mode: status && status.daemon ? status.daemon.mode : 'stopped',
      pid: status && status.daemon ? status.daemon.pid : null,
      subscribe_hint: `node client/runtime/systems/ops/protheusd.js subscribe --consumer=${runtime.consumerId} --limit=${runtime.batchLimit}`,
      conduit_only: true
    },
    status
  });
  emitLatest(runtime, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(out.ok ? 0 : 1);
}

function drainAttentionLocalCompat(runtime: any, consumer: string, limit: number) {
  const queuePath = runtime && runtime.mechPolicy ? runtime.mechPolicy.attentionQueuePath : null;
  const cursorRoot = runtime && runtime.mechPolicy ? runtime.mechPolicy.attentionCursorRoot : null;
  if (!queuePath || !cursorRoot) {
    return {
      ok: false,
      events: [],
      queueDepth: 0,
      cursorAfter: 0,
      cursorBefore: 0
    };
  }
  const consumerSafe = cleanText(consumer, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._:@-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || 'default';
  const cursorPath = path.join(cursorRoot, `${consumerSafe}.json`);
  const cursor = readJson(cursorPath, null);
  const allEvents = readJsonl(queuePath, 200000).filter((row) => row && typeof row === 'object');
  const total = allEvents.length;
  const start = Math.max(0, Math.min(total, Number(cursor && cursor.cursor_after || 0) || 0));
  const batchLimit = Math.max(1, Math.min(2048, Number(limit || 0) || 1));
  const events = allEvents.slice(start, Math.min(total, start + batchLimit));
  const cursorAfter = start + events.length;
  writeJson(cursorPath, {
    consumer: consumerSafe,
    cursor_before: start,
    cursor_after: cursorAfter,
    queue_size: total,
    ts: nowIso()
  });
  return {
    ok: true,
    events,
    queueDepth: Math.max(0, total - cursorAfter),
    cursorAfter,
    cursorBefore: start
  };
}

function fileSig(filePath: string) {
  try {
    const stat = fs.statSync(filePath);
    const mtime = Number.isFinite(Number(stat.mtimeMs)) ? Number(stat.mtimeMs) : 0;
    return `${stat.size}:${Math.floor(mtime)}`;
  } catch {
    return 'missing:0';
  }
}

function attentionWatchTargets(runtime: any) {
  const out = new Set<string>();
  const queuePath = runtime && runtime.mechPolicy ? cleanText(runtime.mechPolicy.attentionQueuePath, 500) : '';
  const latestPath = runtime && runtime.mechPolicy ? cleanText(runtime.mechPolicy.attentionLatestPath, 500) : '';
  if (queuePath) out.add(queuePath);
  if (latestPath) out.add(latestPath);
  return Array.from(out.values());
}

async function waitForAttentionPush(runtime: any, timeoutMs: number) {
  const targetMs = toInt(timeoutMs, 0, 0, 300000);
  const startedMs = Date.now();
  if (targetMs <= 0) {
    return {
      triggered: false,
      reason: 'push_wait_disabled',
      elapsed_ms: 0
    };
  }

  const targets = attentionWatchTargets(runtime);
  const baseline = new Map<string, string>();
  for (const target of targets) {
    baseline.set(target, fileSig(target));
  }

  return new Promise((resolve) => {
    let settled = false;
    const watchers: Array<{ close: () => void }> = [];
    const cleanup = () => {
      while (watchers.length > 0) {
        const watcher = watchers.pop();
        try {
          watcher && watcher.close();
        } catch {}
      }
    };
    const finish = (triggered: boolean, reason: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        triggered,
        reason,
        elapsed_ms: Math.max(0, Date.now() - startedMs)
      });
    };
    const hasMutation = () => targets.some((target) => fileSig(target) !== baseline.get(target));
    const detect = () => {
      if (hasMutation()) finish(true, 'attention_mutation');
    };
    const timer = setTimeout(() => finish(false, 'push_timeout'), targetMs);
    watchers.push({ close: () => clearTimeout(timer) });

    const watchedDirs = new Set<string>();
    for (const target of targets) {
      const directDir = fs.existsSync(target) && fs.statSync(target).isDirectory()
        ? target
        : path.dirname(target);
      if (!directDir || watchedDirs.has(directDir)) continue;
      watchedDirs.add(directDir);
      try {
        const watcher = fs.watch(directDir, { persistent: false }, () => detect());
        watchers.push(watcher);
      } catch {}
    }

    // Fallback poll in case fs.watch is unavailable or event delivery is flaky.
    const pollTimer = setInterval(() => detect(), Math.max(100, Math.min(500, Math.floor(targetMs / 10) || 100)));
    watchers.push({ close: () => clearInterval(pollTimer) });
    detect();
  });
}

async function runSubscribe(runtime: any, argv: string[]) {
  let state = loadDaemonState(runtime);
  if (!isPidAlive(state.pid) && runtime.mechPolicy.enabled === true && ambientAutostartEnabled(argv)) {
    startDaemon(runtime, argv, { exitOnFinish: false });
    state = loadDaemonState(runtime);
  }
  if (!isPidAlive(state.pid)) {
    const fail = withReceipt({
      ok: false,
      shadow_only: false,
      type: 'protheus_daemon_subscribe_error',
      ts: nowIso(),
      reason: 'daemon_not_running'
    });
    emitLatest(runtime, fail);
    process.stdout.write(`${JSON.stringify(fail)}\n`);
    process.exit(1);
    return;
  }

  const consumer = cleanText(parseFlag(argv, 'consumer') || runtime.consumerId, 80)
    .toLowerCase()
    .replace(/[^a-z0-9._:@-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '') || runtime.consumerId;
  const limit = toInt(parseFlag(argv, 'limit') || runtime.batchLimit, runtime.batchLimit, 1, 512);
  const pollMs = toInt(parseFlag(argv, 'poll-ms') || process.env.PROTHEUSD_SUBSCRIBE_POLL_MS, 1500, 250, 60000);
  const waitMs = toInt(parseFlag(argv, 'wait-ms') || process.env.PROTHEUSD_SUBSCRIBE_WAIT_MS, pollMs, 0, 300000);
  const waitChunkMs = toInt(
    parseFlag(argv, 'wait-chunk-ms') || process.env.PROTHEUSD_SUBSCRIBE_WAIT_CHUNK_MS,
    Math.min(Math.max(waitMs, 0), 5000),
    250,
    30000
  );
  const transport = cleanText(
    parseFlag(argv, 'transport')
      || process.env.PROTHEUSD_SUBSCRIBE_TRANSPORT
      || 'push',
    24
  ).toLowerCase();
  const nativePush = transport === 'push' || transport === 'native_push';
  const subscribeBridgeFloorMs = toInt(
    process.env.PROTHEUSD_SUBSCRIBE_BRIDGE_TIMEOUT_MS,
    nativePush ? 8000 : 20000,
    4000,
    5 * 60 * 1000
  );
  const subscribeStdioFloorMs = toInt(
    process.env.PROTHEUSD_SUBSCRIBE_STDIO_TIMEOUT_MS,
    nativePush ? 12000 : 25000,
    5000,
    5 * 60 * 1000
  );
  const pushHeartbeatMs = toInt(
    parseFlag(argv, 'push-heartbeat-ms') || process.env.PROTHEUSD_SUBSCRIBE_PUSH_HEARTBEAT_MS,
    Math.max(pollMs, 5000),
    500,
    300000
  );
  const once = toBool(parseFlag(argv, 'once'), false);
  const maxCycles = toInt(parseFlag(argv, 'max-cycles'), once ? 1 : 0, 0, 1000000);
  let consecutiveTimeouts = 0;
  let onceWaitAccumulatedMs = 0;

  let cycles = 0;
  const started = withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheus_daemon_subscribe_start',
    ts: nowIso(),
    consumer,
    limit,
    poll_ms: pollMs,
    wait_ms: waitMs,
    wait_chunk_ms: waitChunkMs,
    transport,
    native_push: nativePush,
    once
  });
  process.stdout.write(`${JSON.stringify(started)}\n`);

  while (true) {
    cycles += 1;
    const cycleWaitMs = nativePush ? 0 : Math.min(waitMs, waitChunkMs);
    const bridgeTimeoutMs = Math.max(
      subscribeBridgeFloorMs,
      runtime.cockpitConduitTimeoutMs,
      cycleWaitMs + 5000
    );
    const stdioTimeoutMs = Math.max(
      subscribeStdioFloorMs,
      runtime.cockpitConduitTimeoutMs + 5000,
      bridgeTimeoutMs + 3000
    );
    const drained = await runAttentionCommand(
      [
        'drain',
        `--consumer=${consumer}`,
        `--limit=${limit}`,
        '--run-context=daemon_subscribe',
        `--wait-ms=${cycleWaitMs}`
      ],
      {
        cwdHint: runtime.root,
        runContext: 'daemon_subscribe',
        timeoutMs: bridgeTimeoutMs,
        stdioTimeoutMs
      }
    );

    if (!drained || drained.ok !== true) {
      const rawReason = cleanText(
        drained && drained.payload && drained.payload.reason
          ? drained.payload.reason
          : drained && drained.stderr
            ? drained.stderr
            : 'attention_drain_failed',
        260
      ) || 'attention_drain_failed';
      if (isBridgeTimeoutReason(rawReason)) {
        consecutiveTimeouts += 1;
        const localCompat = drainAttentionLocalCompat(runtime, consumer, limit);
        if (localCompat.ok) {
          const compatEvents = Array.isArray(localCompat.events) ? localCompat.events : [];
          const compatBatch = withReceipt({
            ok: true,
            shadow_only: false,
            type: 'protheus_daemon_subscribe_batch',
            ts: nowIso(),
            consumer,
            cycle: cycles,
            batch_count: compatEvents.length,
            queue_depth: Number(localCompat.queueDepth || 0),
            cursor_after: Number(localCompat.cursorAfter || 0),
            wait_ms: cycleWaitMs,
            waited_ms: 0,
            degraded: false,
            bridge_fallback_local: true,
            bridge_fallback_reason: rawReason,
            attention: compatEvents
          });
          if (once && waitMs > cycleWaitMs && compatEvents.length === 0) {
            const waitedNow = Math.max(1, cycleWaitMs);
            onceWaitAccumulatedMs += waitedNow;
            if (onceWaitAccumulatedMs < waitMs) {
              await sleep(Math.max(250, cycleWaitMs));
              continue;
            }
          }
          process.stdout.write(`${JSON.stringify(compatBatch)}\n`);
          if (once || maxCycles > 0 && cycles >= maxCycles) {
            break;
          }
          await sleep(Math.max(250, pollMs));
          continue;
        }
        const backoffMs = Math.min(15000, Math.max(pollMs, 500 * Math.pow(2, Math.min(6, consecutiveTimeouts - 1))));
        const degraded = withReceipt({
          ok: true,
          shadow_only: false,
          type: 'protheus_daemon_subscribe_batch',
          ts: nowIso(),
          consumer,
          cycle: cycles,
          batch_count: 0,
          queue_depth: 0,
          cursor_after: null,
          degraded: true,
          degraded_reason: rawReason,
          timeout_backoff_ms: backoffMs,
          attention: []
        });
        process.stdout.write(`${JSON.stringify(degraded)}\n`);
        if (once || maxCycles > 0 && cycles >= maxCycles) {
          break;
        }
        await sleep(backoffMs);
        continue;
      }
      const err = withReceipt({
        ok: false,
        shadow_only: false,
        type: 'protheus_daemon_subscribe_error',
        ts: nowIso(),
        consumer,
        cycle: cycles,
        reason: rawReason
      });
      process.stdout.write(`${JSON.stringify(err)}\n`);
      if (once || maxCycles > 0 && cycles >= maxCycles) {
        process.exit(1);
        return;
      }
      await sleep(pollMs);
      continue;
    }

    const payload = drained && drained.payload && typeof drained.payload === 'object' ? drained.payload : {};
    const events = Array.isArray(payload.events) ? payload.events : [];
    consecutiveTimeouts = 0;
    let pushWaitedMs = 0;
    let pushWaitReason = '';
    if (nativePush && events.length === 0) {
      const waitTargetMs = once
        ? Math.max(0, waitMs - onceWaitAccumulatedMs)
        : Math.max(pushHeartbeatMs, 0);
      if (waitTargetMs > 0) {
        const pushWait = await waitForAttentionPush(runtime, waitTargetMs);
        pushWaitedMs = Math.max(0, Number(pushWait && pushWait.elapsed_ms || 0));
        pushWaitReason = cleanText(pushWait && pushWait.reason, 80);
        if (once) {
          onceWaitAccumulatedMs += pushWaitedMs;
          if (pushWait && pushWait.triggered === true && (waitMs === 0 || onceWaitAccumulatedMs < waitMs)) {
            continue;
          }
          if (onceWaitAccumulatedMs < waitMs) {
            continue;
          }
        } else if (pushWait && pushWait.triggered === true) {
          continue;
        }
      }
    }
    const batch = withReceipt({
      ok: true,
      shadow_only: false,
      type: 'protheus_daemon_subscribe_batch',
      ts: nowIso(),
      consumer,
      cycle: cycles,
      batch_count: events.length,
      queue_depth: Number(payload.queue_depth || 0),
      cursor_after: Number(payload.cursor_after || 0),
      wait_ms: Number(payload.wait_ms || cycleWaitMs),
      waited_ms: Number(payload.waited_ms || 0) + pushWaitedMs,
      transport,
      native_push: nativePush,
      push_wait_reason: pushWaitReason || null,
      attention: events.map((row: any) => (row && typeof row === 'object' ? row : null)).filter(Boolean)
    });

    if (once && waitMs > cycleWaitMs && events.length === 0) {
      const waitedNow = Math.max(1, Number(payload.waited_ms || cycleWaitMs) + pushWaitedMs);
      onceWaitAccumulatedMs += waitedNow;
      if (onceWaitAccumulatedMs < waitMs) {
        continue;
      }
    }

    process.stdout.write(`${JSON.stringify(batch)}\n`);

    if (once || maxCycles > 0 && cycles >= maxCycles) {
      break;
    }
    await sleep(Math.max(250, pollMs));
  }

  const done = withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheus_daemon_subscribe_done',
    ts: nowIso(),
    consumer,
    cycles
  });
  process.stdout.write(`${JSON.stringify(done)}\n`);
  process.exit(0);
}

function runStatus(runtime: any, argv: string[]) {
  let state = loadDaemonState(runtime);
  if (!isPidAlive(state.pid) && runtime.mechPolicy.enabled === true && ambientAutostartEnabled(argv)) {
    startDaemon(runtime, argv, { exitOnFinish: false });
    state = loadDaemonState(runtime);
  }
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'status', argv, requestId);
  const out = statusReceipt(runtime, state);
  emitLatest(runtime, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(0);
}

function diagnosticsReceipt(runtime: any, state: any) {
  const base = statusReceipt(runtime, state);
  const bridgeHealth = normalizedBridgeHealth(state && state.bridge_health);
  const commandHistory = parseJsonLineRecords(runtime.commandsPath, 20).map((row: any) => ({
    ts: cleanText(row.ts || '', 64) || null,
    request_id: cleanText(row.request_id || '', 40) || null,
    command: cleanText(row.command || '', 32) || null,
    status: cleanText(row.status || '', 24) || null
  }));
  const receiptHistory = parseJsonLineRecords(runtime.receiptsPath, 20).map((row: any) => ({
    ts: cleanText(row.ts || '', 64) || null,
    type: cleanText(row.type || '', 64) || null,
    ok: row && row.ok === true,
    receipt_hash: cleanText(row.receipt_hash || '', 64) || null
  }));
  const gate = readConduitRuntimeGate(runtime.root);
  const degradedClass = bridgeHealth.degraded === true
    ? 'bridge_degraded'
    : gate && gate.gate_active === true
      ? 'runtime_gate_active'
      : (base.ambient_mode && base.ambient_mode.active === true ? 'healthy' : 'ambient_degraded');
  return withReceipt({
    ok: true,
    shadow_only: false,
    type: 'protheusd_diagnostics',
    ts: nowIso(),
    status: base,
    degraded_class: degradedClass,
    bridge_health: bridgeHealth,
    conduit_runtime_gate: gate,
    resource: collectResourceSnapshot(runtime.memoryPressureRatio),
    recent: {
      commands: commandHistory,
      receipts: receiptHistory
    }
  });
}

function renderDiagnosticsHuman(diag: any) {
  const status = diag && diag.status ? diag.status : {};
  const daemon = status && status.daemon ? status.daemon : {};
  const origin = daemon && daemon.origin_integrity ? daemon.origin_integrity : {};
  const ambient = status && status.ambient_mode ? status.ambient_mode : {};
  const bridge = diag && diag.bridge_health ? diag.bridge_health : {};
  const gate = diag && diag.conduit_runtime_gate ? diag.conduit_runtime_gate : {};
  const resource = diag && diag.resource ? diag.resource : {};
  const lines: string[] = [];
  lines.push('== protheusd diagnostics ==');
  lines.push(`ts: ${cleanText(diag && diag.ts, 64) || nowIso()}`);
  lines.push(`degraded_class: ${cleanText(diag && diag.degraded_class, 64) || 'unknown'}`);
  lines.push(`daemon: running=${daemon.running === true ? 'yes' : 'no'} pid=${daemon.pid || 'null'} run_seq=${Number(daemon.run_seq || 0)}`);
  lines.push(`ambient: active=${ambient.active === true ? 'yes' : 'no'} configured=${ambient.configured === true ? 'yes' : 'no'} healthy=${ambient.healthy === true ? 'yes' : 'no'} reason=${cleanText(ambient.degraded_reason, 160) || 'none'}`);
  lines.push(`origin_integrity: ok=${origin.ok === true ? 'yes' : 'no'} source=${cleanText(origin.source, 80) || 'none'} reason=${cleanText(origin.reason, 160) || 'none'} ts=${cleanText(origin.ts, 64) || 'none'}`);
  lines.push(`bridge: degraded=${bridge.degraded === true ? 'yes' : 'no'} reason=${cleanText(bridge.reason, 160) || 'none'} failures=${Number(bridge.consecutive_failures || 0)} next_probe_at=${cleanText(bridge.next_probe_at, 64) || 'none'}`);
  lines.push(`gate: active=${gate.gate_active === true ? 'yes' : 'no'} remaining_ms=${Number(gate.remaining_ms || 0)} last_error=${cleanText(gate.last_error, 160) || 'none'}`);
  lines.push(`resource: rss_mb=${Number(resource.process_rss_mb || 0)} heap_used_mb=${Number(resource.process_heap_used_mb || 0)} system_used_ratio=${Number(resource.system_used_ratio || 0)}`);
  const commands = diag && diag.recent && Array.isArray(diag.recent.commands) ? diag.recent.commands : [];
  if (commands.length) {
    lines.push('recent_commands:');
    for (const row of commands.slice(-5)) {
      lines.push(`- ${cleanText(row.ts, 64) || 'n/a'} ${cleanText(row.command, 32) || 'unknown'} req=${cleanText(row.request_id, 40) || 'n/a'} status=${cleanText(row.status, 24) || 'n/a'}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

function runDiagnostics(runtime: any, argv: string[]) {
  let state = loadDaemonState(runtime);
  if (!isPidAlive(state.pid) && runtime.mechPolicy.enabled === true && ambientAutostartEnabled(argv)) {
    startDaemon(runtime, argv, { exitOnFinish: false });
    state = loadDaemonState(runtime);
  }
  const requestId = `req_${String(Number(state.request_seq || 0) + 1).padStart(6, '0')}`;
  recordCommand(runtime, 'diagnostics', argv, requestId);
  const out = diagnosticsReceipt(runtime, state);
  emitLatest(runtime, out);
  const format = cleanText(parseFlag(argv, 'format') || 'json', 20).toLowerCase();
  if (format === 'human' || format === 'text') {
    process.stdout.write(renderDiagnosticsHuman(out));
  } else {
    process.stdout.write(`${JSON.stringify(out)}\n`);
  }
  process.exit(0);
}

async function main() {
  const argv = process.argv.slice(2);
  const hasExplicitCommand = !!(argv[0] && !String(argv[0]).startsWith('--'));
  const cmd = String(
    hasExplicitCommand ? argv[0] : (process.env.PROTHEUSD_DEFAULT_COMMAND || 'attach')
  ).trim();
  const rest = stripControlFlags(hasExplicitCommand ? argv.slice(1) : argv);
  const strictConduit = conduitStrict(argv, cmd);

  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === INTERNAL_AMBIENT_LOOP) {
    await runAmbientLoop(rest);
    return;
  }

  if ((runConduitEnabled(argv) || strictConduit) && ['start', 'stop', 'status'].includes(cmd)) {
    const routed = await runConduit(cmd, rest);
    if (routed.routed) {
      process.exit(routed.ok ? 0 : 1);
      return;
    }
    if (strictConduit) {
      process.stderr.write(`conduit_required_strict:${routed.error || 'route_failed'}\n`);
      process.exit(1);
      return;
    }
    if (!allowLegacyFallback(argv)) {
      process.stderr.write(`conduit_required:${routed.error || 'route_failed'}\n`);
      process.exit(1);
      return;
    }
    process.stderr.write(`conduit_fallback_to_local:${routed.error || 'route_failed'}\n`);
  }

  const runtime = resolveRuntime(rest);

  if (cmd === 'start') {
    startDaemon(runtime, argv);
    return;
  }
  if (cmd === 'stop') {
    stopDaemon(runtime, argv);
    return;
  }
  if (cmd === 'restart') {
    stopDaemon(runtime, argv, { exitOnFinish: false });
    const out = startDaemon(runtime, argv, { exitOnFinish: false });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(out && out.ok === true ? 0 : 1);
    return;
  }
  if (cmd === 'status') {
    runStatus(runtime, argv);
    return;
  }
  if (cmd === 'attach') {
    runAttach(runtime, argv);
    return;
  }
  if (cmd === 'subscribe') {
    await runSubscribe(runtime, argv);
    return;
  }
  if (cmd === 'diagnostics') {
    runDiagnostics(runtime, argv);
    return;
  }
  if (cmd === 'tick') {
    await runTick(runtime, argv);
    return;
  }

  runLegacy(cmd, rest);
}

main().catch((error) => {
  process.stderr.write(`protheusd_error:${error && error.message ? error.message : String(error)}\n`);
  process.exit(1);
});
