#!/usr/bin/env node
// @ts-nocheck
'use strict';
export {};

// Layer ownership: core/layer1/memory_runtime + core/layer0/ops::memory-ambient (authoritative)
// TypeScript compatibility shim only.

const path = require('path');
const { spawnSync } = require('child_process');
const { runMemoryAmbientCommand } = require('../../lib/spine_conduit_bridge');

function cleanText(v, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx > 2) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = String(argv[i + 1] || '');
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
      continue;
    }
    out[key] = '1';
  }
  return out;
}

function parseBool(v, fallback = false) {
  const raw = String(v == null ? '' : v).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function toAmbientArgs(argv = []) {
  const parsed = parseArgs(argv);
  const cmd = String(parsed._[0] || 'run').trim().toLowerCase();
  const action = cmd === 'status' ? 'status' : 'run';
  const extra = argv.filter((token) => String(token).startsWith('--'));
  return ['run', 'dream-sequencer', `--action=${action}`, ...extra];
}

function payloadLooksValid(payload) {
  if (!payload || typeof payload !== 'object') return false;
  const t = String(payload.type || '');
  return t === 'dream_sequencer' || t === 'dream_sequencer_status';
}

function parsePayloadFromText(rawText = '') {
  const raw = String(rawText || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // keep scanning
    }
  }
  return null;
}

async function run(args = [], opts = {}) {
  const mapped = toAmbientArgs(args);
  const out = await runMemoryAmbientCommand(mapped, {
    runContext: 'dream_sequencer_wrapper',
    skipRuntimeGate: true,
    timeoutMs: Number(process.env.PROTHEUS_DREAM_SEQUENCER_TIMEOUT_MS || 60000),
    stdioTimeoutMs: Number(process.env.PROTHEUS_DREAM_SEQUENCER_STDIO_TIMEOUT_MS || 15000),
    ...opts
  });

  if (out && out.ok === true && payloadLooksValid(out.payload) && out.payload.ok !== false) {
    return out;
  }

  const payload = out && out.payload && typeof out.payload === 'object'
    ? out.payload
    : {
      ok: false,
      type: 'dream_sequencer',
      reason: 'core_lane_unavailable'
    };

  return {
    ok: false,
    status: Number.isFinite(Number(out && out.status)) ? Number(out.status) : 1,
    payload,
    stderr: String((out && out.stderr) || ''),
    stdout: String((out && out.stdout) || ''),
    routed_via: String((out && out.routed_via) || 'conduit')
  };
}

function invokeSelf(args = []) {
  const out = spawnSync(process.execPath, [path.join(__dirname, 'dream_sequencer.js'), ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: process.env
  });
  const payload = parsePayloadFromText(out.stdout || '');
  const status = Number.isFinite(Number(out.status)) ? Number(out.status) : 1;
  return {
    ok: status === 0 && payload && payload.ok !== false,
    status,
    payload,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

function runDreamSequencer(opts = {}) {
  const args = ['run', `--apply=${parseBool(opts && opts.apply, true) ? '1' : '0'}`];
  if (opts && opts.reason != null) args.push(`--reason=${String(opts.reason)}`);
  if (opts && opts.topTagCount != null) args.push(`--top-tags=${Number(opts.topTagCount) || 12}`);
  const out = invokeSelf(args);
  return out.payload || { ok: false, type: 'dream_sequencer', reason: 'self_invoke_failed' };
}

function statusDreamSequencer() {
  const out = invokeSelf(['status']);
  return out.payload || { ok: false, type: 'dream_sequencer_status', reason: 'self_invoke_failed' };
}

if (require.main === module) {
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
  process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
  run(process.argv.slice(2))
    .then((out) => {
      if (out && out.payload) {
        process.stdout.write(`${JSON.stringify(out.payload, null, 2)}\n`);
      }
      if (out && out.stderr) {
        process.stderr.write(String(out.stderr));
        if (!String(out.stderr).endsWith('\n')) process.stderr.write('\n');
      }
      process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
    })
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify({ ok: false, type: 'dream_sequencer_wrapper_error', reason: cleanText(error && error.message ? error.message : error, 220) }, null, 2)}\n`
      );
      process.exit(1);
    });
}

module.exports = {
  run,
  runDreamSequencer,
  statusDreamSequencer
};
