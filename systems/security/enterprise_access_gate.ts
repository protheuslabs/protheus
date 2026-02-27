#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.ENTERPRISE_ACCESS_POLICY_PATH
  ? path.resolve(process.env.ENTERPRISE_ACCESS_POLICY_PATH)
  : path.join(ROOT, 'config', 'enterprise_access_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseRoles(v: unknown) {
  if (Array.isArray(v)) {
    return Array.from(new Set(v.map((row) => normalizeToken(row, 80)).filter(Boolean)));
  }
  return Array.from(new Set(
    String(v == null ? '' : v)
      .split(',')
      .map((row) => normalizeToken(row, 80))
      .filter(Boolean)
  ));
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token || '').slice(2)] = true;
    else out[String(token || '').slice(2, idx)] = String(token || '').slice(idx + 1);
  }
  return out;
}

function readJson(filePath: string, fallback: AnyObj) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    default_deny: true,
    mfa: {
      min_token_length: 8
    },
    operations: {
      'learning_conduit.promote': {
        allowed_roles: ['ml_operator', 'admin'],
        require_mfa: true,
        tenant_scoped: true
      },
      'data_rights.process_apply': {
        allowed_roles: ['privacy_officer', 'admin'],
        require_mfa: true,
        tenant_scoped: true
      },
      'training_quarantine.evaluate_apply': {
        allowed_roles: ['ml_operator', 'admin'],
        require_mfa: true,
        tenant_scoped: true
      },
      'specialist_training.promote': {
        allowed_roles: ['ml_operator', 'admin'],
        require_mfa: true,
        tenant_scoped: true
      }
    }
  };
}

function normalizeRule(raw: AnyObj) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    allowed_roles: parseRoles(src.allowed_roles),
    require_mfa: src.require_mfa !== false,
    tenant_scoped: src.tenant_scoped !== false
  };
}

function normalizePolicy(raw: AnyObj) {
  const base = defaultPolicy();
  const src = raw && typeof raw === 'object' ? raw : {};
  const opsRaw = src.operations && typeof src.operations === 'object'
    ? src.operations
    : base.operations;
  const operations: AnyObj = {};
  for (const [operationId, rule] of Object.entries(opsRaw)) {
    const id = normalizeToken(operationId, 120);
    if (!id) continue;
    operations[id] = normalizeRule(rule as AnyObj);
  }
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    default_deny: src.default_deny !== false,
    mfa: {
      min_token_length: Number.isFinite(Number(src.mfa && src.mfa.min_token_length))
        ? Math.max(4, Math.min(128, Math.floor(Number(src.mfa.min_token_length))))
        : base.mfa.min_token_length
    },
    operations
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return normalizePolicy(readJson(policyPath, defaultPolicy()));
}

function buildAccessContext(args: AnyObj = {}, extra: AnyObj = {}) {
  const actorId = normalizeToken(
    args['actor-id']
    || args.actor_id
    || process.env.PROTHEUS_ACTOR_ID
    || 'unknown_actor',
    120
  ) || 'unknown_actor';
  const actorRoles = parseRoles(
    args['actor-roles']
    || args.actor_roles
    || process.env.PROTHEUS_ACTOR_ROLES
    || ''
  );
  const tenantId = normalizeToken(
    args['tenant-id']
    || args.tenant_id
    || process.env.PROTHEUS_TENANT_ID
    || '',
    80
  ) || null;
  const targetTenant = normalizeToken(
    extra.target_tenant_id
    || args['target-tenant-id']
    || args.target_tenant_id
    || process.env.PROTHEUS_TARGET_TENANT_ID
    || tenantId
    || '',
    80
  ) || null;
  const mfaToken = cleanText(
    args['mfa-token']
    || args.mfa_token
    || process.env.PROTHEUS_MFA_TOKEN
    || '',
    220
  );
  return {
    actor_id: actorId,
    actor_roles: actorRoles,
    tenant_id: tenantId,
    target_tenant_id: targetTenant,
    mfa_token: mfaToken
  };
}

function evaluateAccess(operationId: string, contextInput: AnyObj = {}, policyInput: AnyObj = null) {
  const policy = normalizePolicy(policyInput || loadPolicy());
  const operation = normalizeToken(operationId, 120);
  const context = contextInput && typeof contextInput === 'object' ? contextInput : {};
  const actorRoles = parseRoles(context.actor_roles || []);
  const rule = policy.operations && policy.operations[operation] ? policy.operations[operation] : null;
  const mfaToken = cleanText(context.mfa_token || '', 240);
  const tenantId = normalizeToken(context.tenant_id || '', 80) || null;
  const targetTenant = normalizeToken(context.target_tenant_id || '', 80) || null;

  const checks = {
    policy_enabled: policy.enabled === true,
    operation_known: rule != null,
    role_allowed: false,
    mfa_ok: false,
    tenant_match: false
  };
  const reasons: string[] = [];

  if (!checks.policy_enabled) {
    return {
      allow: true,
      operation,
      policy_version: policy.version,
      actor_id: normalizeToken(context.actor_id || 'unknown_actor', 120) || 'unknown_actor',
      checks,
      reasons: []
    };
  }

  if (!checks.operation_known) {
    if (policy.default_deny === true) reasons.push('unknown_operation_default_deny');
  } else {
    const allowRoles = Array.isArray(rule.allowed_roles) ? rule.allowed_roles : [];
    checks.role_allowed = allowRoles.includes('*') || actorRoles.some((role: string) => allowRoles.includes(role));
    if (!checks.role_allowed) reasons.push('role_not_allowed');

    checks.mfa_ok = rule.require_mfa !== true || (
      mfaToken.length >= Number(policy.mfa.min_token_length || 8)
      && !['none', 'null', 'disabled'].includes(mfaToken.toLowerCase())
    );
    if (!checks.mfa_ok) reasons.push('mfa_required');

    checks.tenant_match = rule.tenant_scoped !== true || (
      !!tenantId
      && !!targetTenant
      && tenantId === targetTenant
    );
    if (!checks.tenant_match) reasons.push('tenant_boundary_violation');
  }

  const allow = reasons.length === 0;
  return {
    allow,
    operation,
    policy_version: policy.version,
    actor_id: normalizeToken(context.actor_id || 'unknown_actor', 120) || 'unknown_actor',
    actor_roles: actorRoles,
    tenant_id: tenantId,
    target_tenant_id: targetTenant,
    checks,
    reasons
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/enterprise_access_gate.js check --operation=<id> --actor-id=<id> --actor-roles=role_a,role_b --mfa-token=<otp> --tenant-id=<tenant> [--target-tenant-id=<tenant>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'check') {
    usage();
    process.exit(2);
  }
  const operation = normalizeToken(args.operation || '', 120);
  if (!operation) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'enterprise_access_check', error: 'operation_required' })}\n`);
    process.exit(1);
  }
  const out = evaluateAccess(operation, buildAccessContext(args));
  process.stdout.write(`${JSON.stringify({
    ok: out.allow === true,
    type: 'enterprise_access_check',
    ts: nowIso(),
    operation: out.operation,
    allow: out.allow === true,
    reasons: out.reasons || [],
    checks: out.checks || {},
    actor_id: out.actor_id,
    policy_version: out.policy_version
  })}\n`);
  if (out.allow !== true) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  defaultPolicy,
  loadPolicy,
  buildAccessContext,
  evaluateAccess
};
