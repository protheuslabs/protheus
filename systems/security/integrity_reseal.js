#!/usr/bin/env node
'use strict';

/**
 * integrity_reseal.js
 *
 * Deterministic operator workflow for integrity policy resealing.
 *
 * Usage:
 *   node systems/security/integrity_reseal.js check [--policy=/abs/path.json] [--staged=1|0]
 *   node systems/security/integrity_reseal.js apply [--policy=/abs/path.json] [--approval-note="..."] [--force=1]
 *   node systems/security/integrity_reseal.js auto [--policy=/abs/path.json] [--approval-note="..."]
 *   node systems/security/integrity_reseal.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  verifyIntegrity,
  sealIntegrity,
  collectPresentProtectedFiles,
  appendIntegrityEvent
} = require('../../lib/security_integrity');

const ROOT = path.resolve(__dirname, '..', '..');
const STARTUP_ATTESTATION_SCRIPT = process.env.INTEGRITY_RESEAL_STARTUP_ATTESTATION_SCRIPT
  ? path.resolve(String(process.env.INTEGRITY_RESEAL_STARTUP_ATTESTATION_SCRIPT))
  : path.join(ROOT, 'systems', 'security', 'startup_attestation.js');
const INTEGRITY_RESEAL_AUDIT_PATH = process.env.INTEGRITY_RESEAL_AUDIT_PATH
  ? path.resolve(String(process.env.INTEGRITY_RESEAL_AUDIT_PATH))
  : path.join(ROOT, 'state', 'security', 'integrity_reseal_audit.jsonl');
const INTEGRITY_RESEAL_AUTO_ATTEST = String(process.env.INTEGRITY_RESEAL_AUTO_ATTEST || '1') !== '0';

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/integrity_reseal.js check [--policy=/abs/path.json] [--staged=1|0]');
  console.log('  node systems/security/integrity_reseal.js apply [--policy=/abs/path.json] [--approval-note="..."] [--force=1]');
  console.log('  node systems/security/integrity_reseal.js auto [--policy=/abs/path.json] [--approval-note="..."]');
  console.log('  node systems/security/integrity_reseal.js --help');
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

function normalizeRel(p) {
  return String(p || '').trim().replace(/\\/g, '/');
}

function appendResealAudit(row) {
  try {
    fs.mkdirSync(path.dirname(INTEGRITY_RESEAL_AUDIT_PATH), { recursive: true });
    fs.appendFileSync(INTEGRITY_RESEAL_AUDIT_PATH, JSON.stringify(row) + '\n', 'utf8');
  } catch {
    // best-effort only
  }
}

function gitChangedPaths(staged = true) {
  const args = staged ? ['diff', '--name-only', '--cached'] : ['diff', '--name-only'];
  const r = spawnSync('git', args, { encoding: 'utf8' });
  if (r.status !== 0) return [];
  return String(r.stdout || '')
    .split(/\r?\n/)
    .map((v) => normalizeRel(v))
    .filter(Boolean);
}

function protectedPathSet(policyPath) {
  const policy = loadPolicy(policyPath);
  const present = collectPresentProtectedFiles(policy);
  const expected = Object.keys(policy && policy.hashes && typeof policy.hashes === 'object' ? policy.hashes : {});
  return new Set([...present, ...expected].map(normalizeRel));
}

function protectedChanges(policyPath, staged = true) {
  const changed = gitChangedPaths(staged);
  const prot = protectedPathSet(policyPath);
  return changed.filter((p) => prot.has(p));
}

function cmdCheck(policyPath, staged = true) {
  const verify = verifyIntegrity(policyPath);
  const changed = protectedChanges(policyPath, staged);
  const out = {
    ok: verify.ok === true,
    ts: new Date().toISOString(),
    type: 'integrity_reseal_check',
    policy_path: path.resolve(policyPath),
    staged,
    protected_changes: changed,
    reseal_required: verify.ok !== true,
    violation_counts: verify.violation_counts || {},
    violations: Array.isArray(verify.violations) ? verify.violations.slice(0, 12) : []
  };
  appendResealAudit({
    ts: out.ts,
    type: out.type,
    policy_path: out.policy_path,
    staged,
    ok: out.ok,
    reseal_required: out.reseal_required,
    protected_changes: changed.slice(0, 64),
    violation_counts: out.violation_counts
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

function issueStartupAttestation() {
  const r = spawnSync('node', [STARTUP_ATTESTATION_SCRIPT, 'issue'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 15000
  });
  const stdout = String(r.stdout || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0 && !!payload && payload.ok === true,
    code: r.status == null ? 1 : r.status,
    payload,
    stderr: String(r.stderr || '').trim().slice(0, 220)
  };
}

function cmdApply(policyPath, note, force = false) {
  const first = verifyIntegrity(policyPath);
  if (first.ok === true && !force) {
    const out = {
      ok: true,
      ts: new Date().toISOString(),
      type: 'integrity_reseal_apply',
      policy_path: path.resolve(policyPath),
      applied: false,
      reason: 'already_sealed'
    };
    appendResealAudit({
      ts: out.ts,
      type: out.type,
      policy_path: out.policy_path,
      applied: false,
      ok: out.ok,
      reason: out.reason,
      force
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }

  const approvalNote = String(note || process.env.INTEGRITY_RESEAL_NOTE || '').trim();
  if (approvalNote.length < 10) {
    process.stdout.write(JSON.stringify({
      ok: false,
      type: 'integrity_reseal_apply',
      error: 'approval_note_too_short',
      min_len: 10
    }) + '\n');
    process.exit(2);
  }

  const seal = sealIntegrity(policyPath, {
    approval_note: approvalNote,
    sealed_by: process.env.USER || 'unknown'
  });
  const verify = verifyIntegrity(policyPath);
  appendIntegrityEvent({
    ts: new Date().toISOString(),
    type: 'integrity_reseal_apply',
    policy_path: path.resolve(policyPath),
    force,
    approval_note: approvalNote.slice(0, 240),
    verify_ok_before: first.ok === true,
    verify_ok_after: verify.ok === true,
    violation_counts_before: first.violation_counts || {},
    violation_counts_after: verify.violation_counts || {}
  });
  const startupAttestation = (verify.ok === true && INTEGRITY_RESEAL_AUTO_ATTEST)
    ? issueStartupAttestation()
    : { ok: null, skipped: true, reason: 'auto_attest_disabled_or_verify_failed' };
  const out = {
    ok: verify.ok === true,
    ts: new Date().toISOString(),
    type: 'integrity_reseal_apply',
    policy_path: path.resolve(policyPath),
    applied: true,
    seal,
    verify: {
      ok: verify.ok === true,
      violation_counts: verify.violation_counts || {},
      violations: Array.isArray(verify.violations) ? verify.violations.slice(0, 12) : []
    },
    startup_attestation: startupAttestation
  };
  appendResealAudit({
    ts: out.ts,
    type: out.type,
    policy_path: out.policy_path,
    applied: true,
    ok: out.ok,
    force,
    approval_note: approvalNote.slice(0, 240),
    verify_ok_before: first.ok === true,
    verify_ok_after: verify.ok === true,
    violation_counts_before: first.violation_counts || {},
    violation_counts_after: verify.violation_counts || {},
    startup_attestation: {
      ok: startupAttestation && startupAttestation.ok === true,
      code: startupAttestation && startupAttestation.code != null ? Number(startupAttestation.code) : null,
      skipped: startupAttestation && startupAttestation.skipped === true
    }
  });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdAuto(policyPath, note) {
  const verify = verifyIntegrity(policyPath);
  if (verify.ok === true) {
    const out = {
      ok: true,
      ts: new Date().toISOString(),
      type: 'integrity_reseal_auto',
      policy_path: path.resolve(policyPath),
      applied: false,
      reason: 'already_sealed'
    };
    appendResealAudit(out);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  return cmdApply(policyPath, note, false);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }

  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  if (cmd === 'check' || cmd === 'status' || cmd === 'run') {
    const staged = String(args.staged == null ? '1' : args.staged).trim() !== '0';
    return cmdCheck(policyPath, staged);
  }
  if (cmd === 'apply' || cmd === 'reseal' || cmd === 'seal') {
    const force = String(args.force || '').trim() === '1';
    const note = String(args['approval-note'] || args.approval_note || '').trim();
    return cmdApply(policyPath, note, force);
  }
  if (cmd === 'auto') {
    const note = String(args['approval-note'] || args.approval_note || '').trim();
    return cmdAuto(policyPath, note);
  }

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}
