#!/usr/bin/env node
'use strict';
export {};

/**
 * integrity_reseal.js
 *
 * Deterministic operator workflow for integrity policy resealing.
 *
 * Usage:
 *   node systems/security/integrity_reseal.js check [--policy=/abs/path.json] [--staged=1|0]
 *   node systems/security/integrity_reseal.js apply [--policy=/abs/path.json] [--approval-note="..."] [--force=1]
 *   node systems/security/integrity_reseal.js --help
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  verifyIntegrity,
  sealIntegrity,
  collectPresentProtectedFiles
} = require('../../lib/security_integrity');

type AnyObj = Record<string, any>;

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/integrity_reseal.js check [--policy=/abs/path.json] [--staged=1|0]');
  console.log('  node systems/security/integrity_reseal.js apply [--policy=/abs/path.json] [--approval-note="..."] [--force=1]');
  console.log('  node systems/security/integrity_reseal.js --help');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
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

function normalizeRel(p: any) {
  return String(p || '').trim().replace(/\\/g, '/');
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

function protectedPathSet(policyPath: string) {
  const policy = loadPolicy(policyPath);
  const present = collectPresentProtectedFiles(policy);
  const expected = Object.keys(policy && policy.hashes && typeof policy.hashes === 'object' ? policy.hashes : {});
  return new Set([...present, ...expected].map(normalizeRel));
}

function protectedChanges(policyPath: string, staged = true) {
  const changed = gitChangedPaths(staged);
  const prot = protectedPathSet(policyPath);
  return changed.filter((p) => prot.has(p));
}

function cmdCheck(policyPath: string, staged = true) {
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
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdApply(policyPath: string, note: string, force = false) {
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
    }
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (!out.ok) process.exit(1);
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

  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}
