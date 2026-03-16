#!/usr/bin/env node
'use strict';

// Thin bridge orchestrating readiness lanes in core/layer0/ops.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const POLICY_PATH = path.join(
  ROOT,
  'client',
  'runtime',
  'config',
  'readiness_bridge_pack_policy.json'
);
const OPS_WRAPPER = path.join(
  ROOT,
  'client',
  'runtime',
  'systems',
  'ops',
  'run_protheus_ops.js'
);
const LATEST_PATH = path.join(ROOT, 'local', 'state', 'ops', 'readiness_bridge_pack', 'latest.json');
const RECEIPTS_PATH = path.join(ROOT, 'local', 'state', 'ops', 'readiness_bridge_pack', 'receipts.jsonl');

function parseArgs(argv) {
  const out = { command: String(argv[0] || 'run').toLowerCase(), strict: true };
  for (const token of argv.slice(1)) {
    if (token.startsWith('--strict=')) {
      const raw = token.slice('--strict='.length).trim().toLowerCase();
      out.strict = ['1', 'true', 'yes', 'on'].includes(raw);
    }
  }
  return out;
}

function readPolicy() {
  const defaults = { enabled: true, strict_default: true };
  try {
    const parsed = JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'));
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

function parseLastJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {}

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    const candidate = raw.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  const lines = raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!(line.startsWith('{') && line.endsWith('}'))) continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function runOpsCapture(args) {
  const run = spawnSync(process.execPath, [OPS_WRAPPER].concat(args), {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const status = Number.isFinite(Number(run.status)) ? Number(run.status) : 1;
  const stdout = String(run.stdout || '');
  const stderr = String(run.stderr || '');
  return {
    status,
    stdout,
    stderr,
    payload: parseLastJson(stdout),
  };
}

function writeArtifacts(payload) {
  fs.mkdirSync(path.dirname(LATEST_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(RECEIPTS_PATH), { recursive: true });
  fs.writeFileSync(LATEST_PATH, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.appendFileSync(RECEIPTS_PATH, `${JSON.stringify(payload)}\n`, 'utf8');
}

function runPack(strict) {
  const checks = [
    {
      id: 'alpha_readiness',
      run: runOpsCapture(['alpha-readiness', 'run', `--strict=${strict ? 1 : 0}`, '--run-gates=1']),
    },
    {
      id: 'f100_readiness',
      run: runOpsCapture(['f100-readiness-program', 'run-all', `--strict=${strict ? 1 : 0}`, '--apply=0']),
    },
    {
      id: 'control_plane_status',
      run: runOpsCapture(['protheus-control-plane', 'status', `--strict=${strict ? 1 : 0}`]),
    },
  ].map((row) => ({
    id: row.id,
    ok: row.run.status === 0 && (!row.run.payload || row.run.payload.ok !== false),
    status_code: row.run.status,
    payload_type: row.run.payload && row.run.payload.type ? row.run.payload.type : null,
    stderr_tail: row.run.stderr.slice(-320),
  }));

  const failed = checks.filter((row) => !row.ok).map((row) => row.id);
  return {
    ok: failed.length === 0,
    type: 'readiness_bridge_pack',
    generated_at: new Date().toISOString(),
    strict,
    checks,
    failed,
  };
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const policy = readPolicy();
  const strict = parsed.strict && policy.strict_default !== false;

  if (!policy.enabled) {
    const out = {
      ok: false,
      type: 'readiness_bridge_pack',
      generated_at: new Date().toISOString(),
      error: 'lane_disabled_by_policy',
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 1;
  }

  if (parsed.command === 'status') {
    if (!fs.existsSync(LATEST_PATH)) {
      const out = {
        ok: false,
        type: 'readiness_bridge_pack_status',
        generated_at: new Date().toISOString(),
        error: 'missing_latest_readiness_bridge_pack',
      };
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return 1;
    }
    process.stdout.write(`${fs.readFileSync(LATEST_PATH, 'utf8').trim()}\n`);
    return 0;
  }

  const out = runPack(strict);
  writeArtifacts(out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return out.ok ? 0 : 2;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, runPack };
