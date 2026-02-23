#!/usr/bin/env node
'use strict';

/**
 * policy_rootd.js
 *
 * Out-of-process policy root for high-tier autonomy mutations.
 * Deterministic authorize/status interface for callers like strategy_mode/governor.
 *
 * Usage:
 *   node systems/security/policy_rootd.js authorize --scope=<scope> [--target=<target>] [--lease-token=<token>] [--approval-note=<note>] [--source=<source>]
 *   node systems/security/policy_rootd.js status
 *   node systems/security/policy_rootd.js --help
 */

const fs = require('fs');
const path = require('path');
const { verifyLease } = require('../../lib/capability_lease.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const POLICY_AUDIT_PATH = process.env.POLICY_ROOT_AUDIT_PATH
  ? path.resolve(process.env.POLICY_ROOT_AUDIT_PATH)
  : path.join(REPO_ROOT, 'state', 'security', 'policy_root_decisions.jsonl');
const POLICY_VERSION = '1.0';
const POLICY_REQUIRE_LEASE_SCOPES = String(
  process.env.POLICY_ROOT_REQUIRE_LEASE_SCOPES
    || 'strategy_mode_escalation,strategy_profile_mutation,strategy_profile_gc_apply,strategy_profile_risk_escalation,autonomy_self_change_apply'
)
  .split(',')
  .map((s) => String(s || '').trim())
  .filter(Boolean);
const POLICY_REQUIRE_APPROVAL_NOTE = String(process.env.POLICY_ROOT_REQUIRE_APPROVAL_NOTE || '1') !== '0';
const POLICY_APPROVAL_NOTE_MIN_LEN = Math.max(5, Number(process.env.POLICY_ROOT_APPROVAL_NOTE_MIN_LEN || 10));

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/policy_rootd.js authorize --scope=<scope> [--target=<target>] [--lease-token=<token>] [--approval-note=<note>] [--source=<source>]');
  console.log('  node systems/security/policy_rootd.js status');
  console.log('  node systems/security/policy_rootd.js --help');
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

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function requiresLease(scope) {
  return POLICY_REQUIRE_LEASE_SCOPES.includes(String(scope || ''));
}

function authorizeDecision(args) {
  const ts = nowIso();
  const scope = normalizeText(args.scope || '', 120);
  const target = normalizeText(args.target || '', 240) || null;
  const approvalNote = normalizeText(args['approval-note'] || args.approval_note || '', 320);
  const source = normalizeText(args.source || 'unknown', 120);
  const leaseToken = normalizeText(args['lease-token'] || args.lease_token || process.env.CAPABILITY_LEASE_TOKEN || '', 8192);

  if (!scope) {
    return {
      ok: false,
      decision: 'DENY',
      reason: 'scope_required',
      ts,
      scope: null,
      target,
      source
    };
  }

  if (POLICY_REQUIRE_APPROVAL_NOTE && approvalNote.length < POLICY_APPROVAL_NOTE_MIN_LEN) {
    return {
      ok: false,
      decision: 'DENY',
      reason: 'approval_note_too_short',
      min_len: POLICY_APPROVAL_NOTE_MIN_LEN,
      ts,
      scope,
      target,
      source
    };
  }

  if (requiresLease(scope)) {
    if (!leaseToken) {
      return {
        ok: false,
        decision: 'DENY',
        reason: 'lease_token_required',
        ts,
        scope,
        target,
        source
      };
    }
    const lease = verifyLease(leaseToken, {
      scope,
      target,
      consume: true,
      consume_reason: `policy_root_authorize:${source}`
    });
    if (!lease || lease.ok !== true) {
      return {
        ok: false,
        decision: 'DENY',
        reason: lease && lease.error ? String(lease.error) : 'lease_verification_failed',
        lease: lease || null,
        ts,
        scope,
        target,
        source
      };
    }
    return {
      ok: true,
      decision: 'ALLOW',
      reason: 'lease_verified',
      lease_id: lease.lease_id || null,
      expires_at: lease.expires_at || null,
      ts,
      scope,
      target,
      source
    };
  }

  return {
    ok: true,
    decision: 'ALLOW',
    reason: 'policy_allow',
    ts,
    scope,
    target,
    source
  };
}

function writeDecisionAudit(decision) {
  appendJsonl(POLICY_AUDIT_PATH, {
    ts: nowIso(),
    type: 'policy_root_decision',
    policy_version: POLICY_VERSION,
    ...(decision && typeof decision === 'object' ? decision : {})
  });
}

function cmdStatus() {
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    policy_version: POLICY_VERSION,
    policy: {
      require_lease_scopes: POLICY_REQUIRE_LEASE_SCOPES.slice(),
      require_approval_note: POLICY_REQUIRE_APPROVAL_NOTE,
      approval_note_min_len: POLICY_APPROVAL_NOTE_MIN_LEN
    },
    audit_log: path.relative(REPO_ROOT, POLICY_AUDIT_PATH).replace(/\\/g, '/')
  }, null, 2) + '\n');
}

function cmdAuthorize(args) {
  const decision = authorizeDecision(args);
  writeDecisionAudit(decision);
  process.stdout.write(JSON.stringify({
    ...decision,
    policy_version: POLICY_VERSION
  }, null, 2) + '\n');
  if (decision.ok !== true) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0] || '', 64);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'authorize') return cmdAuthorize(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  authorizeDecision
};
