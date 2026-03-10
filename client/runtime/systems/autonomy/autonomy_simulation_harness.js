#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/autonomy + core/layer0/ops::autonomy-controller (authoritative)
const fs = require('fs');
const path = require('path');
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '25000';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '30000';

const bridge = createOpsLaneBridge(__dirname, 'autonomy_simulation_harness', 'autonomy-controller');
const ROOT = path.resolve(__dirname, '..', '..');
const PROPOSALS_DIR = process.env.AUTONOMY_SIM_PROPOSALS_DIR
  ? path.resolve(String(process.env.AUTONOMY_SIM_PROPOSALS_DIR))
  : path.join(ROOT, 'local', 'state', 'sensory', 'proposals');

function cleanText(v, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function toInt(v, fallback, lo = 1, hi = 365) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseArgs(argv) {
  const out = { _: [] };
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

function parsePayloadFromOutput(out, type = 'autonomy_simulation_harness') {
  if (out && out.payload && typeof out.payload === 'object') return out.payload;
  const lines = String(out && out.stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return {
    ok: false,
    type,
    error: 'core_lane_no_payload',
    stderr: cleanText(out && out.stderr, 220)
  };
}

function resolveDate(raw) {
  const text = cleanText(raw || '', 20);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  return new Date().toISOString().slice(0, 10);
}

function queueSnapshotForWindow(dates) {
  let total = 0;
  let pending = 0;
  let stalePending = 0;
  const nowMs = Date.now();

  for (const d of Array.isArray(dates) ? dates : []) {
    const fp = path.join(PROPOSALS_DIR, `${d}.json`);
    if (!fs.existsSync(fp)) continue;
    let rows = [];
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      rows = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.proposals) ? raw.proposals : []);
    } catch {
      rows = [];
    }
    for (const row of rows) {
      if (!row || typeof row !== 'object') continue;
      total += 1;
      const status = cleanText(row.status || row.state || 'pending', 32).toLowerCase();
      if (status === 'pending' || status === 'open') {
        pending += 1;
        const ms = Date.parse(`${d}T00:00:00.000Z`);
        const ageHours = Number.isFinite(ms) ? Math.max(0, (nowMs - ms) / 3600000) : 0;
        if (ageHours >= 72) stalePending += 1;
      }
    }
  }

  return {
    total,
    pending,
    stale_pending_72h: stalePending
  };
}

function computeSimulation(endDateStr, days, opts = {}) {
  const date = resolveDate(endDateStr);
  const dayCount = toInt(days, 14, 1, Number(process.env.AUTONOMY_SIM_MAX_DAYS || 365));
  const args = ['autonomy-simulation-harness', 'run', date, `--days=${dayCount}`, `--write=${toBool(opts.write, false) ? 1 : 0}`];
  if (opts.strict != null) args.push(`--strict=${toBool(opts.strict, false) ? 1 : 0}`);
  const out = bridge.run(args);
  return parsePayloadFromOutput(out);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/autonomy_simulation_harness.js run [YYYY-MM-DD] [--days=N] [--write=1|0] [--strict=1|0]');
  console.log('  node systems/autonomy/autonomy_simulation_harness.js status [YYYY-MM-DD] [--days=N] [--write=1|0]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'run', 40).toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  const date = args._[1] || args.date || null;
  const days = toInt(args.days, 14, 1, Number(process.env.AUTONOMY_SIM_MAX_DAYS || 365));
  const strict = toBool(args.strict, false);
  const write = toBool(args.write, true);

  if (cmd === 'run' || cmd === 'status') {
    const payload = computeSimulation(date, days, { write, strict });
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    const insufficientData = payload && payload.insufficient_data && payload.insufficient_data.active === true;
    if (strict && payload && payload.verdict === 'fail' && !insufficientData) process.exit(2);
    if (!payload || payload.ok !== true) process.exit(1);
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  computeSimulation,
  queueSnapshotForWindow
};
