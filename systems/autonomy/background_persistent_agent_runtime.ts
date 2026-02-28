#!/usr/bin/env node
'use strict';
export {};

/**
 * background_persistent_agent_runtime.js
 *
 * V3-ASSIM-014:
 * Lightweight always-on runtime primitive that evaluates low-cost trigger signals
 * and emits bounded activation intents for background work.
 *
 * Commands:
 *   node systems/autonomy/background_persistent_agent_runtime.js enqueue --signal-json="{...}" [--policy=<path>]
 *   node systems/autonomy/background_persistent_agent_runtime.js tick [--context-json="{...}"] [--source=<id>] [--apply=1|0] [--force=1|0] [--policy=<path>]
 *   node systems/autonomy/background_persistent_agent_runtime.js status [--policy=<path>]
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.BACKGROUND_PERSISTENT_RUNTIME_ROOT
  ? path.resolve(process.env.BACKGROUND_PERSISTENT_RUNTIME_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.BACKGROUND_PERSISTENT_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.BACKGROUND_PERSISTENT_RUNTIME_POLICY_PATH)
  : path.join(ROOT, 'config', 'background_persistent_agent_runtime_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
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
    const raw = String(tok || '');
    if (!raw.startsWith('--')) {
      out._.push(raw);
      continue;
    }
    const idx = raw.indexOf('=');
    if (idx < 0) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

function parseJsonArg(raw: unknown, fallback: AnyObj = {}) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return fallback;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
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

function writeJsonl(filePath: string, rows: AnyObj[]) {
  ensureDir(path.dirname(filePath));
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(v: unknown, fallbackRel: string) {
  const txt = cleanText(v || fallbackRel, 400);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function defaultPolicy() {
  return {
    schema_id: 'background_persistent_agent_runtime_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: true,
    consume_queue_on_tick: true,
    limits: {
      min_tick_interval_sec: 120,
      max_signals_per_tick: 64,
      max_activations_per_tick: 6
    },
    trigger_thresholds: {
      queue_backlog_min: 4,
      error_rate_min: 0.18,
      stale_age_min_sec: 1800
    },
    trigger_task_map: {
      queue_backlog: ['anticipation', 'value_weaving'],
      error_pressure: ['self_improvement', 'security_vigilance'],
      stale_runtime: ['dream_consolidation']
    },
    state: {
      state_path: 'state/autonomy/background_persistent_runtime/state.json',
      queue_path: 'state/autonomy/background_persistent_runtime/queue.jsonl',
      latest_path: 'state/autonomy/background_persistent_runtime/latest.json',
      receipts_path: 'state/autonomy/background_persistent_runtime/receipts.jsonl'
    }
  };
}

function normalizeTaskMap(src: AnyObj, fallback: AnyObj) {
  const inMap = src && typeof src === 'object' ? src : {};
  const out: AnyObj = {};
  const keys = Array.from(new Set([
    ...Object.keys(fallback || {}),
    ...Object.keys(inMap || {})
  ]));
  for (const key of keys) {
    const list = Array.isArray(inMap[key]) ? inMap[key] : Array.isArray(fallback[key]) ? fallback[key] : [];
    out[key] = Array.from(new Set(
      list
        .map((row: unknown) => normalizeToken(row, 80))
        .filter(Boolean)
    ));
  }
  return out;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const limits = raw.limits && typeof raw.limits === 'object' ? raw.limits : {};
  const thresholds = raw.trigger_thresholds && typeof raw.trigger_thresholds === 'object'
    ? raw.trigger_thresholds
    : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    schema_id: base.schema_id,
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    consume_queue_on_tick: toBool(raw.consume_queue_on_tick, base.consume_queue_on_tick),
    limits: {
      min_tick_interval_sec: clampInt(
        limits.min_tick_interval_sec,
        0,
        24 * 60 * 60,
        base.limits.min_tick_interval_sec
      ),
      max_signals_per_tick: clampInt(
        limits.max_signals_per_tick,
        1,
        10000,
        base.limits.max_signals_per_tick
      ),
      max_activations_per_tick: clampInt(
        limits.max_activations_per_tick,
        1,
        1024,
        base.limits.max_activations_per_tick
      )
    },
    trigger_thresholds: {
      queue_backlog_min: clampInt(
        thresholds.queue_backlog_min,
        0,
        100000,
        base.trigger_thresholds.queue_backlog_min
      ),
      error_rate_min: clampNumber(
        thresholds.error_rate_min,
        0,
        1,
        base.trigger_thresholds.error_rate_min
      ),
      stale_age_min_sec: clampInt(
        thresholds.stale_age_min_sec,
        0,
        365 * 24 * 60 * 60,
        base.trigger_thresholds.stale_age_min_sec
      )
    },
    trigger_task_map: normalizeTaskMap(raw.trigger_task_map, base.trigger_task_map),
    state: {
      state_path: resolvePath(state.state_path, base.state.state_path),
      queue_path: resolvePath(state.queue_path, base.state.queue_path),
      latest_path: resolvePath(state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'background_persistent_runtime_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_tick_ts: null,
    tick_count: 0,
    trigger_counts: {},
    activation_counts: {}
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') return defaultState();
  const base = defaultState();
  return {
    ...base,
    ...src,
    trigger_counts: src.trigger_counts && typeof src.trigger_counts === 'object' ? src.trigger_counts : {},
    activation_counts: src.activation_counts && typeof src.activation_counts === 'object' ? src.activation_counts : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'background_persistent_runtime_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_tick_ts: state.last_tick_ts || null,
    tick_count: clampInt(state.tick_count, 0, 1_000_000_000, 0),
    trigger_counts: state.trigger_counts && typeof state.trigger_counts === 'object' ? state.trigger_counts : {},
    activation_counts: state.activation_counts && typeof state.activation_counts === 'object' ? state.activation_counts : {}
  });
}

function normalizeSignal(signalRaw: AnyObj = {}, sourceFallback = '') {
  return {
    ts: cleanText(signalRaw.ts || nowIso(), 48) || nowIso(),
    source: normalizeToken(signalRaw.source || sourceFallback || 'unknown', 120) || 'unknown',
    queue_backlog: clampInt(signalRaw.queue_backlog, 0, 10_000_000, 0),
    error_rate: clampNumber(signalRaw.error_rate, 0, 1, 0),
    stale_age_sec: clampInt(signalRaw.stale_age_sec, 0, 365 * 24 * 60 * 60, 0)
  };
}

function aggregateSignals(signals: AnyObj[]) {
  let queueBacklog = 0;
  let errorRate = 0;
  let staleAgeSec = 0;
  for (const signal of signals) {
    queueBacklog = Math.max(queueBacklog, clampInt(signal.queue_backlog, 0, 10_000_000, 0));
    errorRate = Math.max(errorRate, clampNumber(signal.error_rate, 0, 1, 0));
    staleAgeSec = Math.max(staleAgeSec, clampInt(signal.stale_age_sec, 0, 365 * 24 * 60 * 60, 0));
  }
  return {
    queue_backlog: queueBacklog,
    error_rate: Number(errorRate.toFixed(6)),
    stale_age_sec: staleAgeSec
  };
}

function evaluateTriggers(policy: AnyObj, aggregate: AnyObj) {
  const out: string[] = [];
  if (Number(aggregate.queue_backlog || 0) >= Number(policy.trigger_thresholds.queue_backlog_min || 0)) {
    out.push('queue_backlog');
  }
  if (Number(aggregate.error_rate || 0) >= Number(policy.trigger_thresholds.error_rate_min || 1)) {
    out.push('error_pressure');
  }
  if (Number(aggregate.stale_age_sec || 0) >= Number(policy.trigger_thresholds.stale_age_min_sec || 0)) {
    out.push('stale_runtime');
  }
  return out;
}

function buildActivations(policy: AnyObj, triggers: string[]) {
  const rows: AnyObj[] = [];
  const seen = new Set<string>();
  for (const trigger of triggers) {
    const taskList = Array.isArray(policy.trigger_task_map[trigger]) ? policy.trigger_task_map[trigger] : [];
    for (const taskIdRaw of taskList) {
      const taskId = normalizeToken(taskIdRaw, 80);
      if (!taskId || seen.has(taskId)) continue;
      seen.add(taskId);
      rows.push({
        task_id: taskId,
        trigger,
        priority: trigger === 'error_pressure' ? 'high' : 'normal'
      });
      if (rows.length >= Number(policy.limits.max_activations_per_tick || 6)) return rows;
    }
  }
  return rows;
}

function updateCounters(map: AnyObj, keys: string[]) {
  for (const key of keys) {
    const token = normalizeToken(key, 120);
    if (!token) continue;
    map[token] = clampInt(map[token], 0, 1_000_000_000, 0) + 1;
  }
}

function commandEnqueue(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'background_persistent_runtime_enqueue',
      error: 'policy_disabled'
    };
  }
  const signalRaw = parseJsonArg(args['signal-json'] || args.signal_json, {});
  const source = normalizeToken(args.source || signalRaw.source || 'manual_enqueue', 120) || 'manual_enqueue';
  const signal = normalizeSignal(signalRaw, source);
  const row = {
    ts: nowIso(),
    type: 'background_signal',
    signal
  };
  appendJsonl(policy.state.queue_path, row);
  appendJsonl(policy.state.receipts_path, {
    ts: row.ts,
    type: 'background_persistent_runtime_enqueue',
    signal
  });
  return {
    ok: true,
    type: 'background_persistent_runtime_enqueue',
    signal,
    queue_path: rel(policy.state.queue_path),
    policy_path: rel(policy.policy_path)
  };
}

function commandTick(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  if (policy.enabled !== true) {
    return {
      ok: false,
      type: 'background_persistent_runtime_tick',
      error: 'policy_disabled'
    };
  }
  const applyRequested = toBool(args.apply, false);
  const apply = applyRequested === true && policy.shadow_only !== true;
  const force = toBool(args.force, false);
  const source = normalizeToken(args.source || 'tick', 120) || 'tick';
  const state = loadState(policy);
  const nowTs = nowIso();
  const nowMs = Date.parse(nowTs);
  const lastTickMs = Date.parse(String(state.last_tick_ts || ''));
  const minTickSec = Number(policy.limits.min_tick_interval_sec || 0);
  if (!force && Number.isFinite(lastTickMs) && minTickSec > 0) {
    const elapsedSec = Math.max(0, (nowMs - lastTickMs) / 1000);
    if (elapsedSec < minTickSec) {
      const out = {
        ok: true,
        type: 'background_persistent_runtime_tick',
        ts: nowTs,
        skipped: true,
        reason: 'min_tick_interval',
        elapsed_sec: Number(elapsedSec.toFixed(3)),
        min_tick_interval_sec: minTickSec,
        shadow_only: policy.shadow_only === true,
        apply_requested: applyRequested,
        apply,
        source,
        queue_path: rel(policy.state.queue_path),
        policy_path: rel(policy.policy_path)
      };
      writeJsonAtomic(policy.state.latest_path, out);
      appendJsonl(policy.state.receipts_path, out);
      return out;
    }
  }

  const queuedSignals = readJsonl(policy.state.queue_path)
    .slice(0, Number(policy.limits.max_signals_per_tick || 64))
    .map((row) => normalizeSignal(row.signal || {}, row.signal && row.signal.source || 'queued_signal'));
  const contextRaw = parseJsonArg(args['context-json'] || args.context_json, {});
  const contextSignal = normalizeSignal(contextRaw, source);
  const signals = contextRaw && Object.keys(contextRaw).length > 0
    ? [...queuedSignals, contextSignal]
    : queuedSignals.slice(0);
  if (!signals.length) {
    signals.push(contextSignal);
  }

  const aggregate = aggregateSignals(signals);
  const triggers = evaluateTriggers(policy, aggregate);
  const activations = buildActivations(policy, triggers);
  updateCounters(state.trigger_counts, triggers);
  updateCounters(state.activation_counts, activations.map((row) => row.task_id));
  state.tick_count = clampInt(state.tick_count, 0, 1_000_000_000, 0) + 1;
  state.last_tick_ts = nowTs;
  saveState(policy, state);
  if (policy.consume_queue_on_tick === true) {
    writeJsonl(policy.state.queue_path, []);
  }

  const out = {
    ok: true,
    type: 'background_persistent_runtime_tick',
    ts: nowTs,
    source,
    shadow_only: policy.shadow_only === true,
    apply_requested: applyRequested,
    apply,
    signal_count: signals.length,
    aggregate,
    triggers,
    activation_count: activations.length,
    activations,
    queue_consumed: policy.consume_queue_on_tick === true,
    queue_path: rel(policy.state.queue_path),
    state_path: rel(policy.state.state_path),
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.state.latest_path, out);
  appendJsonl(policy.state.receipts_path, out);
  return out;
}

function commandStatus(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const state = loadState(policy);
  const latest = readJson(policy.state.latest_path, null);
  const queued = readJsonl(policy.state.queue_path);
  return {
    ok: true,
    type: 'background_persistent_runtime_status',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    enabled: policy.enabled === true,
    queue_depth: queued.length,
    tick_count: clampInt(state.tick_count, 0, 1_000_000_000, 0),
    last_tick_ts: state.last_tick_ts || null,
    trigger_counts: state.trigger_counts,
    activation_counts: state.activation_counts,
    latest: latest && typeof latest === 'object'
      ? {
          ts: latest.ts || null,
          trigger_count: Array.isArray(latest.triggers) ? latest.triggers.length : 0,
          activation_count: Number(latest.activation_count || 0)
        }
      : null,
    queue_path: rel(policy.state.queue_path),
    state_path: rel(policy.state.state_path),
    latest_path: rel(policy.state.latest_path),
    receipts_path: rel(policy.state.receipts_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/background_persistent_agent_runtime.js enqueue --signal-json="{...}" [--source=<id>] [--policy=<path>]');
  console.log('  node systems/autonomy/background_persistent_agent_runtime.js tick [--context-json="{...}"] [--source=<id>] [--apply=1|0] [--force=1|0] [--policy=<path>]');
  console.log('  node systems/autonomy/background_persistent_agent_runtime.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  let out: AnyObj;
  if (cmd === 'enqueue') out = commandEnqueue(args);
  else if (cmd === 'tick' || cmd === 'run') out = commandTick(args);
  else if (cmd === 'status' || cmd === 'latest') out = commandStatus(args);
  else {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'background_persistent_runtime',
      error: `unknown_command:${cmd}`
    })}\n`);
    process.exit(1);
    return;
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exit(1);
}

if (require.main === module) main();

module.exports = {
  commandEnqueue,
  commandTick,
  commandStatus,
  loadPolicy
};

