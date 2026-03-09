#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops::spine (authoritative)
// Lightweight heartbeat trigger path that avoids TS bootstrap overhead.
const { runSpineCommand } = require('../../lib/spine_conduit_bridge');

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

function normalizeMode(raw) {
  const token = String(raw || '').trim().toLowerCase();
  if (token === 'eyes') return 'eyes';
  return 'daily';
}

function normalizeDate(raw) {
  const token = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;
  return new Date().toISOString().slice(0, 10);
}

function buildSpineArgs(argv) {
  const parsed = parseArgs(argv);
  const command = String(parsed._[0] || 'run').trim().toLowerCase();
  if (command === 'status') {
    const mode = normalizeMode(parsed.mode || parsed._[1] || 'daily');
    const date = normalizeDate(parsed.date || parsed._[2] || null);
    return ['status', `--mode=${mode}`, `--date=${date}`];
  }
  const mode = normalizeMode(parsed.mode || parsed._[1] || 'daily');
  const date = normalizeDate(parsed.date || parsed._[2] || null);
  const out = ['run', mode, date];
  if (parsed['max-eyes'] != null) {
    out.push(`--max-eyes=${String(parsed['max-eyes'])}`);
  }
  return out;
}

if (require.main === module) {
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
  process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS =
    process.env.PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS || '8000';
  runSpineCommand(buildSpineArgs(process.argv.slice(2)), {
    runContext: 'heartbeat_trigger',
    stdioTimeoutMs: Number(process.env.PROTHEUS_HEARTBEAT_STDIO_TIMEOUT_MS || 25000)
  }).then((out) => {
    if (out && out.payload) process.stdout.write(`${JSON.stringify(out.payload)}\n`);
    if (out && out.stderr) process.stderr.write(out.stderr.endsWith('\n') ? out.stderr : `${out.stderr}\n`);
    process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
  }).catch((error) => {
    const payload = {
      ok: false,
      type: 'heartbeat_trigger_wrapper_error',
      error: String(error && error.message ? error.message : error)
    };
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exit(1);
  });
}

module.exports = {
  run: (args = [], opts = {}) =>
    runSpineCommand(buildSpineArgs(args), {
      runContext: 'heartbeat_trigger',
      ...opts
    })
};
