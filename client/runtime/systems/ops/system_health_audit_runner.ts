#!/usr/bin/env node
'use strict';

// Thin client wrapper. Core authority remains in protheus-ops domains.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const POLICY_PATH = path.join(
  ROOT,
  'client',
  'runtime',
  'config',
  'system_health_audit_runner_policy.json'
);
const OPS_WRAPPER = path.join(
  ROOT,
  'client',
  'runtime',
  'systems',
  'ops',
  'run_protheus_ops.js'
);

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
  const defaults = {
    enabled: true,
    latest_path: 'local/state/ops/system_health_audit/latest.json',
    receipts_path: 'local/state/ops/system_health_audit/receipts.jsonl',
  };
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

function writeArtifacts(policy, payload) {
  const latest = path.join(ROOT, policy.latest_path);
  const receipts = path.join(ROOT, policy.receipts_path);
  fs.mkdirSync(path.dirname(latest), { recursive: true });
  fs.mkdirSync(path.dirname(receipts), { recursive: true });
  fs.writeFileSync(latest, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.appendFileSync(receipts, `${JSON.stringify(payload)}\n`, 'utf8');
}

function buildHealthSnapshot(strict) {
  const checks = [
    {
      id: 'control_plane',
      run: runOpsCapture(['protheus-control-plane', 'status', `--strict=${strict ? 1 : 0}`]),
    },
    {
      id: 'alpha_readiness',
      run: runOpsCapture(['alpha-readiness', 'status']),
    },
    {
      id: 'swarm_runtime',
      run: runOpsCapture(['swarm-runtime', 'status']),
    },
    {
      id: 'supply_chain_provenance',
      run: runOpsCapture(['supply-chain-provenance-v2', 'status']),
    },
  ].map((row) => ({
    id: row.id,
    ok: row.run.status === 0 && (!row.run.payload || row.run.payload.ok !== false),
    status_code: row.run.status,
    payload_type: row.run.payload && row.run.payload.type ? row.run.payload.type : null,
    stderr_tail: row.run.stderr.slice(-300),
  }));

  const failed = checks.filter((row) => !row.ok).map((row) => row.id);
  return {
    ok: failed.length === 0,
    type: 'system_health_audit_runner',
    generated_at: new Date().toISOString(),
    strict,
    checks,
    failed,
  };
}

function main(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const policy = readPolicy();

  if (!policy.enabled) {
    const out = {
      ok: false,
      type: 'system_health_audit_runner',
      generated_at: new Date().toISOString(),
      error: 'lane_disabled_by_policy',
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return 1;
  }

  if (parsed.command === 'status') {
    const latest = path.join(ROOT, policy.latest_path);
    if (!fs.existsSync(latest)) {
      const out = {
        ok: false,
        type: 'system_health_audit_runner_status',
        generated_at: new Date().toISOString(),
        error: 'missing_latest_health_audit',
      };
      process.stdout.write(`${JSON.stringify(out)}\n`);
      return 1;
    }
    process.stdout.write(`${fs.readFileSync(latest, 'utf8').trim()}\n`);
    return 0;
  }

  const out = buildHealthSnapshot(parsed.strict);
  writeArtifacts(policy, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return out.ok ? 0 : 2;
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = { main, buildHealthSnapshot };
