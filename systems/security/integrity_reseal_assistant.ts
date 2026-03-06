#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/integrity_reseal_assistant.js run [--apply=1|0] [--policy=<path>] [--note="..."] [--strict=1|0]');
  console.log('  node systems/security/integrity_reseal_assistant.js status [--policy=<path>]');
}

function runJson(args, strict = false) {
  const r = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8' });
  const stdout = String(r.stdout || '').trim();
  let parsed = null;
  try {
    parsed = stdout ? JSON.parse(stdout) : null;
  } catch {
    parsed = null;
  }
  const out = {
    ok: r.status === 0,
    status: Number(r.status || 0),
    stdout,
    stderr: String(r.stderr || '').trim(),
    json: parsed
  };
  if (strict && !out.ok) {
    process.stderr.write(`${out.stderr || out.stdout}\n`);
    process.exit(out.status || 1);
  }
  return out;
}

function buildAutoNote(checkJson) {
  const violations = Array.isArray(checkJson && checkJson.violations) ? checkJson.violations : [];
  const files = violations
    .map((row) => cleanText(row && row.file || '', 120))
    .filter(Boolean)
    .slice(0, 8);
  const focus = files.length ? `files=${files.join(',')}` : 'files=none';
  return `Automated integrity reseal assistant run (${focus}) at ${nowIso()}`;
}

function cmdRun(args) {
  const policyArg = cleanText(args.policy || '', 500);
  const apply = toBool(args.apply, true);
  const strict = toBool(args.strict, false);
  const baseCheck = ['systems/security/integrity_reseal.js', 'check', '--staged=0'];
  if (policyArg) baseCheck.push(`--policy=${policyArg}`);
  const checkOut = runJson(baseCheck, false);
  const checkJson = checkOut.json && typeof checkOut.json === 'object' ? checkOut.json : {};
  const resealRequired = checkJson.reseal_required === true || checkJson.ok === false;

  const payload = {
    ok: true,
    type: 'integrity_reseal_assistant',
    ts: nowIso(),
    apply,
    strict,
    policy: policyArg || null,
    reseal_required: resealRequired,
    check: checkJson,
    applied: false,
    apply_result: null
  };

  if (resealRequired && apply) {
    const note = cleanText(args.note || '', 500) || buildAutoNote(checkJson);
    const applyCmd = ['systems/security/integrity_reseal.js', 'apply', `--approval-note=${note}`];
    if (policyArg) applyCmd.push(`--policy=${policyArg}`);
    const applyOut = runJson(applyCmd, false);
    payload.applied = true;
    payload.apply_result = applyOut.json && typeof applyOut.json === 'object'
      ? applyOut.json
      : { ok: applyOut.ok, status: applyOut.status, stderr: applyOut.stderr || null };
    payload.ok = payload.apply_result && payload.apply_result.ok === true;
  }

  if (strict && payload.ok !== true) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  }
  return payload;
}

function cmdStatus(args) {
  const statusArgs = ['systems/security/integrity_reseal.js', 'check'];
  if (cleanText(args.policy || '', 500)) statusArgs.push(`--policy=${cleanText(args.policy, 500)}`);
  const out = runJson(statusArgs, false);
  const j = out.json && typeof out.json === 'object' ? out.json : null;
  if (!j) {
    return {
      ok: false,
      type: 'integrity_reseal_assistant_status',
      reason: 'check_parse_failed',
      raw_stdout: out.stdout
    };
  }
  return {
    ok: true,
    type: 'integrity_reseal_assistant_status',
    ts: nowIso(),
    reseal_required: j.reseal_required === true || j.ok === false,
    check: j
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 64);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') {
    const out = cmdRun(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (out.ok !== true) process.exit(1);
    return;
  }
  if (cmd === 'status') {
    const out = cmdStatus(args);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (out.ok !== true) process.exit(1);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  cmdRun,
  cmdStatus
};
