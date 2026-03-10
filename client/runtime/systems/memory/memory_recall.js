#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/memory_runtime + core/layer0/ops::memory-ambient (authoritative)
// Client wrapper routes memory recall commands through conduit-backed Rust lanes.
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const { runMemoryAmbientCommand } = require('../../lib/spine_conduit_bridge');
const LEGACY_ENTRY = path.join(__dirname, 'legacy', 'memory_recall_legacy.js');
const DEFAULT_BURN_THRESHOLD_TOKENS = Number(process.env.PROTHEUS_MEMORY_BURN_THRESHOLD_TOKENS || 200);

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
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

function toAmbientArgs(argv) {
  const parsed = parseArgs(argv);
  const cmd = String(parsed._[0] || 'query').trim().toLowerCase();

  if (cmd === 'status') {
    return ['status'];
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    return ['run', 'help'];
  }
  if (cmd === 'probe') {
    return ['run', 'probe'];
  }
  if (cmd === 'build-index') {
    return ['run', 'build-index'];
  }
  if (cmd === 'verify-envelope') {
    return ['run', 'verify-envelope'];
  }
  if (cmd === 'clear-cache') {
    // Core runtime does not expose clear-cache as a first-class command.
    // Keep behavior stable as a safe no-op success receipt.
    return null;
  }
  if (cmd === 'get') {
    const out = ['run', 'get-node'];
    if (parsed['node-id']) out.push(`--node-id=${String(parsed['node-id'])}`);
    if (parsed['node_id']) out.push(`--node-id=${String(parsed['node_id'])}`);
    if (parsed.uid) out.push(`--uid=${String(parsed.uid)}`);
    if (parsed.file) out.push(`--file=${String(parsed.file)}`);
    if (parsed['cache-path']) out.push(`--cache-path=${String(parsed['cache-path'])}`);
    if (parsed['cache-max-bytes']) out.push(`--cache-max-bytes=${String(parsed['cache-max-bytes'])}`);
    return out;
  }

  // Default command: query
  const out = ['run', 'query-index'];
  if (parsed.q != null) out.push(`--q=${String(parsed.q)}`);
  if (parsed.top != null) out.push(`--top=${String(parsed.top)}`);
  if (parsed.tags != null) out.push(`--tags=${String(parsed.tags)}`);
  if (parsed['score-mode'] != null) out.push(`--score-mode=${String(parsed['score-mode'])}`);
  if (parsed['cache-path'] != null) out.push(`--cache-path=${String(parsed['cache-path'])}`);
  if (parsed['cache-max-bytes'] != null) out.push(`--cache-max-bytes=${String(parsed['cache-max-bytes'])}`);

  const expand = String(parsed.expand || '').trim().toLowerCase();
  if (parsed['expand-lines'] != null) {
    out.push(`--expand-lines=${String(parsed['expand-lines'])}`);
  } else if (expand === 'always' || expand === 'auto') {
    out.push(`--expand-lines=${String(parsed['excerpt-lines'] || parsed.excerpt_lines || 6)}`);
  } else if (expand === 'none') {
    out.push('--expand-lines=0');
  }

  return out;
}

function noOpClearCacheReceipt() {
  return {
    ok: true,
    type: 'memory_recall_clear_cache_noop',
    lane: 'memory_ambient',
    reason: 'core_lane_has_no_clear_cache_command',
    compatibility_only: true
  };
}

function parseJsonPayload(rawText) {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (!lines[i].startsWith('{')) continue;
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function runLegacy(args = []) {
  const proc = spawnSync(process.execPath, [LEGACY_ENTRY, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env
  });
  const status = Number.isFinite(Number(proc.status)) ? Number(proc.status) : 1;
  const stdout = String(proc.stdout || '');
  const stderr = String(proc.stderr || '');
  const payload = parseJsonPayload(stdout);
  return {
    ok: status === 0 && payload && payload.ok !== false,
    status,
    payload,
    stdout,
    stderr
  };
}

function estimateTokens(value) {
  const text = String(value == null ? '' : value);
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}

function telemetryPath() {
  const override = String(process.env.PROTHEUS_MEMORY_BURN_TELEMETRY_PATH || '').trim();
  if (override) return path.resolve(override);
  return path.join(__dirname, '..', '..', 'local', 'state', 'ops', 'token_burn', 'memory_recall.jsonl');
}

function appendTelemetry(entry) {
  const target = telemetryPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
}

function buildTokenTelemetry(args, out) {
  const parsed = parseArgs(args || []);
  const command = String(parsed._[0] || 'query').trim().toLowerCase();
  const queryText = command === 'query' ? String(parsed.q || '') : '';
  const queryTokensEst = estimateTokens(queryText);
  const responsePayload = out && out.payload && typeof out.payload === 'object' ? out.payload : {};
  let responseSurface = '';
  if (Array.isArray(responsePayload.hits)) {
    responseSurface = responsePayload.hits
      .slice(0, 3)
      .map((hit) => {
        if (!hit || typeof hit !== 'object') return '';
        const tags = Array.isArray(hit.tags) ? hit.tags.join(',') : '';
        return `${String(hit.node_id || '')}|${String(hit.uid || '')}|${String(hit.summary || '')}|${tags}`;
      })
      .filter(Boolean)
      .join('\n');
  } else if (responsePayload && typeof responsePayload === 'object') {
    responseSurface = [
      String(responsePayload.node_id || ''),
      String(responsePayload.uid || ''),
      String(responsePayload.summary || ''),
      Array.isArray(responsePayload.tags) ? responsePayload.tags.join(',') : ''
    ].filter(Boolean).join('|');
  }
  const responseTokensEst = estimateTokens(responseSurface || JSON.stringify(responsePayload));
  const totalTokensEst = queryTokensEst + responseTokensEst;
  const threshold = Number.isFinite(DEFAULT_BURN_THRESHOLD_TOKENS)
    ? Math.max(1, Number(DEFAULT_BURN_THRESHOLD_TOKENS))
    : 200;
  const overThreshold = totalTokensEst > threshold;
  const lane = responsePayload.routed_via || (out && out.ok === true ? 'conduit' : 'legacy_fallback');
  const telemetry = {
    ts: new Date().toISOString(),
    type: 'memory_recall_token_telemetry',
    command,
    lane,
    query_tokens_est: queryTokensEst,
    response_tokens_est: responseTokensEst,
    total_tokens_est: totalTokensEst,
    threshold_tokens: threshold,
    over_threshold: overThreshold,
    threshold_reason: overThreshold ? 'query_or_response_estimate_above_threshold' : null,
    estimation_basis: responseSurface ? 'compact_hit_surface' : 'payload_fallback'
  };
  return telemetry;
}

function attachTelemetry(args, out) {
  try {
    const telemetry = buildTokenTelemetry(args, out);
    appendTelemetry(telemetry);
    if (out && out.payload && typeof out.payload === 'object') {
      out.payload.token_telemetry = telemetry;
    }
  } catch {}
  return out;
}

function isBridgeSuccess(out) {
  if (!out || out.ok !== true || !out.payload || typeof out.payload !== 'object') return false;
  if (out.payload.ok === false) return false;
  if (out.payload.gate_active === true) return false;
  const reason = String(out.payload.reason || '').toLowerCase();
  if (reason.startsWith('conduit_')) return false;
  return true;
}

async function run(args = [], opts = {}) {
  const ambientArgs = toAmbientArgs(args);
  if (!ambientArgs) {
    return runLegacy(args);
  }
  try {
    const out = await runMemoryAmbientCommand(ambientArgs, {
      runContext: 'memory_recall_wrapper',
      skipRuntimeGate: true,
      stdioTimeoutMs: Number(process.env.PROTHEUS_MEMORY_STDIO_TIMEOUT_MS || 25000),
      ...opts
    });
    if (isBridgeSuccess(out)) {
      return attachTelemetry(args, out);
    }
    return attachTelemetry(args, runLegacy(args));
  } catch {
    return attachTelemetry(args, runLegacy(args));
  }
}

if (require.main === module) {
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
  process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS =
    process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS || '8000';
  run(process.argv.slice(2))
    .then((out) => {
      const status = Number.isFinite(out && out.status) ? Number(out.status) : 0;
      if (out && out.payload) {
        process.stdout.write(`${JSON.stringify(out.payload)}\n`);
      } else {
        process.stdout.write(`${JSON.stringify(noOpClearCacheReceipt())}\n`);
      }
      if (out && out.stderr) {
        process.stderr.write(out.stderr.endsWith('\n') ? out.stderr : `${out.stderr}\n`);
      }
      process.exit(status);
    })
    .catch((error) => {
      const payload = {
        ok: false,
        type: 'memory_recall_wrapper_error',
        error: String(error && error.message ? error.message : error)
      };
      process.stdout.write(`${JSON.stringify(payload)}\n`);
      process.exit(1);
    });
}

module.exports = {
  run
};
