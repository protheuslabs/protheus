#!/usr/bin/env node
'use strict';
export {};

/**
 * deep_symbiosis_understanding_layer.js
 *
 * V3-SYM-001:
 * Private style/anticipation layer that learns interaction preferences and predicts
 * preferred delivery format for proactive/autonomous outcomes.
 *
 * Commands:
 *   node systems/symbiosis/deep_symbiosis_understanding_layer.js ingest --signal-json="{...}"
 *   node systems/symbiosis/deep_symbiosis_understanding_layer.js predict [--intent=<id>] [--context-json="{...}"]
 *   node systems/symbiosis/deep_symbiosis_understanding_layer.js status
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DEEP_SYMBIOSIS_UNDERSTANDING_POLICY_PATH
  ? path.resolve(process.env.DEEP_SYMBIOSIS_UNDERSTANDING_POLICY_PATH)
  : path.join(ROOT, 'config', 'deep_symbiosis_understanding_layer_policy.json');

type AnyObj = Record<string, any>;

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

function parseJsonArg(raw: unknown, fallback: any = {}) {
  const txt = String(raw == null ? '' : raw).trim();
  if (!txt) return fallback;
  try {
    const parsed = JSON.parse(txt);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    anticipation_horizon_hours: 24,
    preferred_channels: ['obsidian', 'holo', 'chat'],
    style_defaults: {
      directness: 0.9,
      brevity: 0.85,
      proactive_delta: 0.7
    },
    state: {
      state_path: 'state/symbiosis/deep_understanding/state.json',
      latest_path: 'state/symbiosis/deep_understanding/latest.json',
      receipts_path: 'state/symbiosis/deep_understanding/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const styles = raw.style_defaults && typeof raw.style_defaults === 'object' ? raw.style_defaults : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    anticipation_horizon_hours: clampInt(raw.anticipation_horizon_hours, 1, 24 * 14, base.anticipation_horizon_hours),
    preferred_channels: Array.from(new Set(
      (Array.isArray(raw.preferred_channels) ? raw.preferred_channels : base.preferred_channels)
        .map((row: unknown) => normalizeToken(row, 40))
        .filter(Boolean)
    )),
    style_defaults: {
      directness: clampNumber(styles.directness, 0, 1, base.style_defaults.directness),
      brevity: clampNumber(styles.brevity, 0, 1, base.style_defaults.brevity),
      proactive_delta: clampNumber(styles.proactive_delta, 0, 1, base.style_defaults.proactive_delta)
    },
    state: {
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState(policy: AnyObj) {
  return {
    schema_id: 'deep_symbiosis_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    samples: 0,
    style: {
      directness: policy.style_defaults.directness,
      brevity: policy.style_defaults.brevity,
      proactive_delta: policy.style_defaults.proactive_delta
    },
    channel_counts: Object.fromEntries((policy.preferred_channels || []).map((id: string) => [id, 0])),
    intent_counts: {}
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') return defaultState(policy);
  const base = defaultState(policy);
  return {
    ...base,
    ...src,
    samples: clampInt(src.samples, 0, 1_000_000_000, 0),
    style: {
      directness: clampNumber(src.style && src.style.directness, 0, 1, base.style.directness),
      brevity: clampNumber(src.style && src.style.brevity, 0, 1, base.style.brevity),
      proactive_delta: clampNumber(src.style && src.style.proactive_delta, 0, 1, base.style.proactive_delta)
    },
    channel_counts: src.channel_counts && typeof src.channel_counts === 'object' ? src.channel_counts : base.channel_counts,
    intent_counts: src.intent_counts && typeof src.intent_counts === 'object' ? src.intent_counts : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'deep_symbiosis_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    samples: clampInt(state.samples, 0, 1_000_000_000, 0),
    style: {
      directness: clampNumber(state.style && state.style.directness, 0, 1, policy.style_defaults.directness),
      brevity: clampNumber(state.style && state.style.brevity, 0, 1, policy.style_defaults.brevity),
      proactive_delta: clampNumber(state.style && state.style.proactive_delta, 0, 1, policy.style_defaults.proactive_delta)
    },
    channel_counts: state.channel_counts && typeof state.channel_counts === 'object' ? state.channel_counts : {},
    intent_counts: state.intent_counts && typeof state.intent_counts === 'object' ? state.intent_counts : {}
  });
}

function persistLatest(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.state.latest_path, row);
  appendJsonl(policy.state.receipts_path, row);
}

function ingest(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const signal = parseJsonArg(args['signal-json'] || args.signal_json, {});
  const channel = normalizeToken(signal.channel || signal.surface || 'chat', 40) || 'chat';
  const intent = normalizeToken(signal.intent || signal.kind || 'general', 80) || 'general';
  const directness = clampNumber(signal.directness, 0, 1, state.style.directness);
  const brevity = clampNumber(signal.brevity, 0, 1, state.style.brevity);
  const proactiveDelta = clampNumber(signal.proactive_delta, 0, 1, state.style.proactive_delta);
  const alpha = state.samples < 5 ? 0.35 : 0.12;

  state.samples = clampInt(Number(state.samples || 0) + 1, 0, 1_000_000_000, 0);
  state.style.directness = Number(((state.style.directness * (1 - alpha)) + (directness * alpha)).toFixed(6));
  state.style.brevity = Number(((state.style.brevity * (1 - alpha)) + (brevity * alpha)).toFixed(6));
  state.style.proactive_delta = Number(((state.style.proactive_delta * (1 - alpha)) + (proactiveDelta * alpha)).toFixed(6));
  state.channel_counts[channel] = clampInt(Number(state.channel_counts[channel] || 0) + 1, 0, 1_000_000_000, 0);
  state.intent_counts[intent] = clampInt(Number(state.intent_counts[intent] || 0) + 1, 0, 1_000_000_000, 0);
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'deep_symbiosis_ingest',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    signal: {
      channel,
      intent
    },
    style: state.style,
    samples: state.samples
  };
  persistLatest(policy, out);
  return out;
}

function predict(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const intent = normalizeToken(args.intent || 'general', 80) || 'general';
  const context = parseJsonArg(args['context-json'] || args.context_json, {});
  const priority = normalizeToken(context.priority || context.urgency || 'normal', 40) || 'normal';
  const topChannel = Object.entries(state.channel_counts || {})
    .sort((a: any, b: any) => Number(b[1] || 0) - Number(a[1] || 0))[0]?.[0]
    || policy.preferred_channels[0]
    || 'chat';

  const anticipatedNeeds = [] as string[];
  if (intent.includes('outreach')) anticipatedNeeds.push('batch_outcome_summary', 'high_quality_reply_drafting');
  if (priority === 'high' || priority === 'urgent') anticipatedNeeds.push('concise_risk_summary');
  if (!anticipatedNeeds.length) anticipatedNeeds.push('next_best_action', 'short_receipt');

  const out = {
    ok: true,
    type: 'deep_symbiosis_predict',
    ts: nowIso(),
    shadow_only: policy.shadow_only === true,
    intent,
    preferred_output: {
      channel: topChannel,
      directness: state.style.directness,
      brevity: state.style.brevity,
      proactive_delta: state.style.proactive_delta
    },
    anticipated_needs: Array.from(new Set(anticipatedNeeds)).slice(0, 6)
  };
  persistLatest(policy, out);
  return out;
}

function status(policy: AnyObj) {
  const state = loadState(policy);
  const latest = readJson(policy.state.latest_path, null);
  return {
    ok: true,
    type: 'deep_symbiosis_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      anticipation_horizon_hours: policy.anticipation_horizon_hours
    },
    state,
    latest: latest && typeof latest === 'object'
      ? {
        type: cleanText(latest.type || '', 80) || null,
        ts: cleanText(latest.ts || '', 60) || null
      }
      : null,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state.state_path),
      latest_path: rel(policy.state.latest_path),
      receipts_path: rel(policy.state.receipts_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/symbiosis/deep_symbiosis_understanding_layer.js ingest --signal-json="{...}"');
  console.log('  node systems/symbiosis/deep_symbiosis_understanding_layer.js predict [--intent=<id>] [--context-json="{...}"]');
  console.log('  node systems/symbiosis/deep_symbiosis_understanding_layer.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  let out: AnyObj;
  if (!policy.enabled) {
    out = { ok: false, type: 'deep_symbiosis_understanding', ts: nowIso(), error: 'policy_disabled' };
  } else if (cmd === 'ingest') {
    out = ingest(policy, args);
  } else if (cmd === 'predict') {
    out = predict(policy, args);
  } else if (cmd === 'status') {
    out = status(policy);
  } else if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  } else {
    out = { ok: false, type: 'deep_symbiosis_understanding', ts: nowIso(), error: `unknown_command:${cmd}` };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  ingest,
  predict,
  status
};
