#!/usr/bin/env node
'use strict';

/**
 * slo_runbook_check.js
 *
 * Ensures health SLO checks are covered by explicit runbook mappings.
 *
 * Usage:
 *   node systems/autonomy/slo_runbook_check.js run [YYYY-MM-DD]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SLO_RUNBOOK_POLICY_PATH
  ? path.resolve(process.env.SLO_RUNBOOK_POLICY_PATH)
  : path.join(ROOT, 'config', 'autonomy_slo_runbook_map.json');
const HEALTH_SCRIPT = process.env.SLO_RUNBOOK_HEALTH_SCRIPT
  ? path.resolve(process.env.SLO_RUNBOOK_HEALTH_SCRIPT)
  : path.join(ROOT, 'systems', 'autonomy', 'health_status.js');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/slo_runbook_check.js run [YYYY-MM-DD]');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function runHealth(dateStr) {
  const r = spawnSync(process.execPath, [HEALTH_SCRIPT, dateStr, '--write=0', '--alerts=0'], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env }
  });
  const stdout = String(r.stdout || '').trim();
  let payload = null;
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      const lines = stdout.split('\n').map((x) => x.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        const line = lines[i];
        if (!line.startsWith('{') || !line.endsWith('}')) continue;
        try {
          payload = JSON.parse(line);
          break;
        } catch {}
      }
    }
  }
  return {
    ok: r.status === 0 && !!payload && payload.ok === true,
    code: Number(r.status == null ? 1 : r.status),
    payload,
    stderr: String(r.stderr || '').trim()
  };
}

function cmdRun(dateStr) {
  const policy = readJson(POLICY_PATH, {});
  const runbookRel = policy && policy.runbook && policy.runbook.path
    ? String(policy.runbook.path)
    : 'docs/OPERATOR_RUNBOOK.md';
  const runbookPath = path.join(ROOT, runbookRel);
  const runbookBody = fs.existsSync(runbookPath) ? fs.readFileSync(runbookPath, 'utf8') : '';
  const required = Array.isArray(policy.required_checks)
    ? policy.required_checks.map((x) => String(x || '').trim()).filter(Boolean)
    : [];
  const mappings = policy && policy.mappings && typeof policy.mappings === 'object'
    ? policy.mappings
    : {};

  const health = runHealth(dateStr);
  const checks = health.payload && health.payload.slo && health.payload.slo.checks && typeof health.payload.slo.checks === 'object'
    ? Object.keys(health.payload.slo.checks).sort()
    : [];
  const missingChecks = [];
  const missingMappings = [];
  const missingSections = [];

  for (const id of required) {
    const map = mappings[id];
    if (!map || typeof map !== 'object') {
      if (!checks.includes(id)) missingChecks.push(id);
      missingMappings.push(id);
      continue;
    }
    const aliases = [];
    if (Array.isArray(map.health_checks)) {
      for (const v of map.health_checks) aliases.push(String(v || '').trim());
    } else if (map.health_check) {
      aliases.push(String(map.health_check).trim());
    }
    const present = checks.includes(id) || aliases.some((name) => name && checks.includes(name));
    if (!present) missingChecks.push(id);
    const section = String(map.section || '').trim();
    if (!section || !runbookBody.includes(section)) missingSections.push(id);
  }

  const ok = health.ok === true
    && missingChecks.length === 0
    && missingMappings.length === 0
    && missingSections.length === 0;
  const out = {
    ok,
    ts: nowIso(),
    type: 'slo_runbook_check',
    date: dateStr,
    runbook_path: runbookRel,
    checks_seen: checks,
    required_checks: required,
    missing_checks: missingChecks,
    missing_mappings: missingMappings,
    missing_runbook_sections: missingSections,
    health_ok: health.ok === true,
    health_error: health.ok ? null : (health.stderr || `health_status_exit_${health.code}`)
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  if (!ok) process.exitCode = 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'run') {
    return cmdRun(dateArgOrToday(args._[1]));
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'slo_runbook_check_failed')
    }) + '\n');
    process.exit(1);
  }
}
