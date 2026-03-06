#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { loadPolicy: loadKeyLifecyclePolicy } = require('./key_lifecycle_governor.js');

type AnyObj = Record<string, any>;

const ROOT = process.env.DELEGATED_AUTHORITY_ROOT
  ? path.resolve(process.env.DELEGATED_AUTHORITY_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.DELEGATED_AUTHORITY_POLICY_PATH
  ? path.resolve(process.env.DELEGATED_AUTHORITY_POLICY_PATH)
  : path.join(ROOT, 'config', 'delegated_authority_policy.json');

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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function parseCsvSet(v: unknown, maxLen = 80) {
  const raw = cleanText(v || '', 4000);
  if (!raw) return [];
  return Array.from(new Set(raw.split(',').map((row) => normalizeToken(row, maxLen)).filter(Boolean)));
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/delegated_authority_branching.js issue --delegate-id=<id> --roles=r1,r2 --scopes=s1,s2 [--ttl-hours=72] --approved-by=<id> --approval-note="<text>" [--apply=1|0]');
  console.log('  node systems/security/delegated_authority_branching.js evaluate --branch-id=<id>|--branch-token=<token> --scope=<scope> [--role=<role>]');
  console.log('  node systems/security/delegated_authority_branching.js revoke --branch-id=<id> --revoked-by=<id> --reason="<text>" [--apply=1|0]');
  console.log('  node systems/security/delegated_authority_branching.js handoff-contract --branch-id=<id>');
  console.log('  node systems/security/delegated_authority_branching.js status');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown) {
  const token = cleanText(raw || '', 500);
  if (!token) return ROOT;
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function hmacHex(value: unknown, secret: string) {
  return crypto.createHmac('sha256', String(secret || '')).update(stableStringify(value), 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    schema_id: 'delegated_authority_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    signing_key_env: 'DELEGATED_AUTHORITY_SIGNING_KEY',
    signing_key_min_length: 24,
    default_ttl_hours: 72,
    max_ttl_hours: 24 * 30,
    min_approval_note_chars: 12,
    required_key_class: 'signing',
    required_constitution_guard_enabled: true,
    constitution_denied_scopes: [
      'constitution_mutation',
      'identity_rewrite',
      'directive_root_override',
      'policy_root_bypass',
      'soul_token_override'
    ],
    paths: {
      key_lifecycle_policy: 'config/key_lifecycle_policy.json',
      constitution_guardian_policy: 'config/constitution_guardian_policy.json',
      index_path: 'state/security/delegated_authority/index.json',
      latest_path: 'state/security/delegated_authority/latest.json',
      receipts_path: 'state/security/delegated_authority/receipts.jsonl'
    },
    handoff_contract: {
      v4_contract_id: 'v4_succession_branch_handoff',
      minimum_fields: ['branch_id', 'delegate_id', 'roles', 'scopes', 'expires_at', 'revoked_at']
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const pathsRaw = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const handoffRaw = raw.handoff_contract && typeof raw.handoff_contract === 'object' ? raw.handoff_contract : {};
  const deniedScopesRaw = Array.isArray(raw.constitution_denied_scopes)
    ? raw.constitution_denied_scopes
    : base.constitution_denied_scopes;
  return {
    schema_id: 'delegated_authority_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    signing_key_env: cleanText(raw.signing_key_env || base.signing_key_env, 80) || base.signing_key_env,
    signing_key_min_length: clampInt(raw.signing_key_min_length, 8, 4096, base.signing_key_min_length),
    default_ttl_hours: clampInt(raw.default_ttl_hours, 1, 24 * 365, base.default_ttl_hours),
    max_ttl_hours: clampInt(raw.max_ttl_hours, 1, 24 * 3650, base.max_ttl_hours),
    min_approval_note_chars: clampInt(raw.min_approval_note_chars, 4, 200, base.min_approval_note_chars),
    required_key_class: normalizeToken(raw.required_key_class || base.required_key_class, 40) || base.required_key_class,
    required_constitution_guard_enabled: raw.required_constitution_guard_enabled !== false,
    constitution_denied_scopes: Array.from(new Set(deniedScopesRaw.map((row: unknown) => normalizeToken(row, 120)).filter(Boolean))),
    paths: {
      key_lifecycle_policy: resolvePath(pathsRaw.key_lifecycle_policy || base.paths.key_lifecycle_policy),
      constitution_guardian_policy: resolvePath(pathsRaw.constitution_guardian_policy || base.paths.constitution_guardian_policy),
      index_path: resolvePath(pathsRaw.index_path || base.paths.index_path),
      latest_path: resolvePath(pathsRaw.latest_path || base.paths.latest_path),
      receipts_path: resolvePath(pathsRaw.receipts_path || base.paths.receipts_path)
    },
    handoff_contract: {
      v4_contract_id: normalizeToken(handoffRaw.v4_contract_id || base.handoff_contract.v4_contract_id, 80) || base.handoff_contract.v4_contract_id,
      minimum_fields: Array.isArray(handoffRaw.minimum_fields)
        ? handoffRaw.minimum_fields.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : base.handoff_contract.minimum_fields.slice(0)
    },
    policy_path: path.resolve(policyPath)
  };
}

function resolveSigningKey(policy: AnyObj) {
  const envName = cleanText(policy.signing_key_env || '', 80) || 'DELEGATED_AUTHORITY_SIGNING_KEY';
  const key = String(process.env[envName] || '');
  if (key.length < Number(policy.signing_key_min_length || 24)) {
    return {
      ok: false,
      env_name: envName,
      error: 'delegated_authority_signing_key_missing_or_short'
    };
  }
  return {
    ok: true,
    env_name: envName,
    key
  };
}

function initIndex() {
  return {
    schema_id: 'delegated_authority_index',
    schema_version: '1.0',
    created_at: nowIso(),
    updated_at: nowIso(),
    branches: []
  };
}

function loadIndex(policy: AnyObj) {
  const raw = readJson(policy.paths.index_path, null);
  if (!raw || typeof raw !== 'object') return initIndex();
  return {
    schema_id: 'delegated_authority_index',
    schema_version: '1.0',
    created_at: cleanText(raw.created_at || nowIso(), 40) || nowIso(),
    updated_at: cleanText(raw.updated_at || nowIso(), 40) || nowIso(),
    branches: Array.isArray(raw.branches) ? raw.branches : []
  };
}

function saveIndex(policy: AnyObj, index: AnyObj) {
  writeJsonAtomic(policy.paths.index_path, {
    ...index,
    updated_at: nowIso()
  });
}

function emitReceipt(policy: AnyObj, row: AnyObj) {
  appendJsonl(policy.paths.receipts_path, {
    ts: nowIso(),
    ...row
  });
}

function loadKeyState(policy: AnyObj) {
  const keyPolicy = loadKeyLifecyclePolicy(policy.paths.key_lifecycle_policy);
  const raw = readJson(keyPolicy.state_path, {});
  const keys = raw && raw.keys && typeof raw.keys === 'object' ? raw.keys : {};
  return {
    key_policy_path: keyPolicy.policy_path,
    required_class: policy.required_key_class,
    active_required_class_keys: Object.values(keys).filter((row: AnyObj) => {
      const keyClass = normalizeToken(row && row.key_class || '', 80);
      const status = normalizeToken(row && row.status || '', 40);
      return keyClass === policy.required_key_class && status === 'active';
    }).length
  };
}

function loadConstitutionState(policy: AnyObj) {
  const guardian = readJson(policy.paths.constitution_guardian_policy, {});
  const enabled = guardian.enabled !== false;
  return {
    policy_path: rel(policy.paths.constitution_guardian_policy),
    enabled
  };
}

function signBranch(policy: AnyObj, branch: AnyObj) {
  const signing = resolveSigningKey(policy);
  if (!signing.ok) return { ok: false, reason: signing.error, env_name: signing.env_name };
  return {
    ok: true,
    env_name: signing.env_name,
    signature: hmacHex({
      branch_id: branch.branch_id,
      delegate_id: branch.delegate_id,
      roles: branch.roles,
      scopes: branch.scopes,
      issued_at: branch.issued_at,
      expires_at: branch.expires_at
    }, signing.key)
  };
}

function createBranchRecord(policy: AnyObj, args: AnyObj) {
  const delegateId = normalizeToken(args['delegate-id'] || args.delegate_id || '', 120);
  const roles = parseCsvSet(args.roles || '', 80);
  const scopes = parseCsvSet(args.scopes || '', 120);
  const issuedBy = normalizeToken(args['approved-by'] || args.approved_by || '', 120);
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 500);
  const ttlHours = clampInt(args['ttl-hours'] || args.ttl_hours, 1, policy.max_ttl_hours, policy.default_ttl_hours);

  const failures = [];
  if (!delegateId) failures.push('delegate_id_required');
  if (!roles.length) failures.push('roles_required');
  if (!scopes.length) failures.push('scopes_required');
  if (!issuedBy) failures.push('approved_by_required');
  if (approvalNote.length < policy.min_approval_note_chars) failures.push('approval_note_too_short');

  const deniedScopeHit = scopes.filter((scope: string) => policy.constitution_denied_scopes.includes(scope));
  if (deniedScopeHit.length) failures.push('constitution_denied_scope_requested');

  const keyState = loadKeyState(policy);
  if (keyState.active_required_class_keys < 1) failures.push('required_key_class_missing');

  const constitutionState = loadConstitutionState(policy);
  if (policy.required_constitution_guard_enabled && constitutionState.enabled !== true) {
    failures.push('constitution_guard_not_enabled');
  }

  if (failures.length) {
    return {
      ok: false,
      failures,
      key_state: keyState,
      constitution: constitutionState
    };
  }

  const branchId = normalizeToken(args['branch-id'] || args.branch_id || '', 120)
    || `soul_branch_${crypto.createHash('sha256').update(`${delegateId}|${nowIso()}|${Math.random()}`).digest('hex').slice(0, 12)}`;

  const issuedAt = nowIso();
  const expiresMs = Date.parse(issuedAt) + (ttlHours * 60 * 60 * 1000);
  const expiresAt = new Date(expiresMs).toISOString();

  const branch = {
    schema_id: 'delegated_authority_branch',
    schema_version: '1.0',
    branch_id: branchId,
    delegate_id: delegateId,
    roles,
    scopes,
    issued_at: issuedAt,
    issued_by: issuedBy,
    approval_note: approvalNote,
    ttl_hours: ttlHours,
    expires_at: expiresAt,
    revoked_at: null,
    revoked_by: null,
    revoked_reason: null,
    status: 'active',
    compatibility: {
      v4_handoff_contract: policy.handoff_contract.v4_contract_id,
      minimum_fields: policy.handoff_contract.minimum_fields
    },
    gates: {
      constitution_guard_enabled: constitutionState.enabled === true,
      denied_scopes_enforced: true,
      required_key_class: policy.required_key_class,
      active_required_class_keys: keyState.active_required_class_keys
    }
  };

  const signed = signBranch(policy, branch);
  if (!signed.ok) {
    return {
      ok: false,
      failures: [signed.reason || 'signing_failed'],
      key_state: keyState,
      constitution: constitutionState
    };
  }

  branch.signature = {
    algo: 'hmac-sha256',
    key_env: signed.env_name,
    value: signed.signature
  };

  return {
    ok: true,
    branch,
    key_state: keyState,
    constitution: constitutionState
  };
}

function findBranch(index: AnyObj, branchIdRaw: unknown) {
  const branchId = normalizeToken(branchIdRaw || '', 120);
  if (!branchId) return null;
  return index.branches.find((row: AnyObj) => normalizeToken(row && row.branch_id || '', 120) === branchId) || null;
}

function assertBranchSignature(policy: AnyObj, branch: AnyObj) {
  const signing = resolveSigningKey(policy);
  if (!signing.ok) {
    return { ok: false, reason: signing.error };
  }
  const expected = hmacHex({
    branch_id: branch.branch_id,
    delegate_id: branch.delegate_id,
    roles: branch.roles,
    scopes: branch.scopes,
    issued_at: branch.issued_at,
    expires_at: branch.expires_at
  }, signing.key);
  return {
    ok: String(branch.signature && branch.signature.value || '') === expected,
    expected,
    actual: String(branch.signature && branch.signature.value || '')
  };
}

function decodeBranchToken(raw: unknown) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const decoded = Buffer.from(text, 'base64').toString('utf8');
    const parsed = JSON.parse(decoded);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function encodeBranchToken(payload: AnyObj) {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function branchTokenPayload(branch: AnyObj) {
  return {
    branch_id: branch.branch_id,
    delegate_id: branch.delegate_id,
    roles: branch.roles,
    scopes: branch.scopes,
    issued_at: branch.issued_at,
    expires_at: branch.expires_at,
    signature: branch.signature && branch.signature.value || null
  };
}

function cmdIssue(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'delegated_authority_issue', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const apply = toBool(args.apply, true);
  const index = loadIndex(policy);
  const created = createBranchRecord(policy, args);
  if (!created.ok) {
    const out = {
      ok: false,
      type: 'delegated_authority_issue',
      failures: created.failures,
      key_state: created.key_state,
      constitution: created.constitution
    };
    emitReceipt(policy, out);
    writeJsonAtomic(policy.paths.latest_path, out);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }

  const branch = created.branch;
  if (findBranch(index, branch.branch_id)) {
    const out = {
      ok: false,
      type: 'delegated_authority_issue',
      error: 'branch_id_exists',
      branch_id: branch.branch_id
    };
    emitReceipt(policy, out);
    writeJsonAtomic(policy.paths.latest_path, out);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }

  if (apply && policy.shadow_only !== true) {
    index.branches.push(branch);
    if (index.branches.length > 10000) index.branches = index.branches.slice(index.branches.length - 10000);
    saveIndex(policy, index);
  }

  const token = encodeBranchToken(branchTokenPayload(branch));
  const out = {
    ok: true,
    type: 'delegated_authority_issue',
    branch_id: branch.branch_id,
    delegate_id: branch.delegate_id,
    roles: branch.roles,
    scopes: branch.scopes,
    expires_at: branch.expires_at,
    branch_token: token,
    apply,
    shadow_only: policy.shadow_only === true,
    policy_path: rel(policy.policy_path)
  };
  emitReceipt(policy, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function evaluateAgainstBranch(policy: AnyObj, branch: AnyObj, scope: string, role: string | null) {
  const now = Date.now();
  const expiresMs = parseIsoMs(branch.expires_at);
  const revoked = !!cleanText(branch.revoked_at || '', 40);
  const active = !revoked && branch.status === 'active' && expiresMs != null && now < expiresMs;
  const signature = assertBranchSignature(policy, branch);
  const scopeAllowed = branch.scopes.includes(scope) && !policy.constitution_denied_scopes.includes(scope);
  const roleAllowed = role ? branch.roles.includes(role) : true;

  const reasons = [];
  if (!active) reasons.push('branch_inactive');
  if (!signature.ok) reasons.push('signature_invalid');
  if (!scopeAllowed) reasons.push('scope_not_allowed');
  if (!roleAllowed) reasons.push('role_not_allowed');

  return {
    ok: reasons.length === 0,
    active,
    signature_ok: signature.ok,
    scope_allowed: scopeAllowed,
    role_allowed: roleAllowed,
    reasons
  };
}

function cmdEvaluate(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const scope = normalizeToken(args.scope || '', 120);
  const role = normalizeToken(args.role || '', 80) || null;
  if (!scope) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'delegated_authority_evaluate', error: 'scope_required' })}\n`);
    process.exit(1);
  }

  const index = loadIndex(policy);
  let branch: AnyObj | null = null;
  if (cleanText(args['branch-id'] || args.branch_id || '', 120)) {
    branch = findBranch(index, args['branch-id'] || args.branch_id);
  }
  if (!branch && cleanText(args['branch-token'] || args.branch_token || '', 8000)) {
    const decoded = decodeBranchToken(args['branch-token'] || args.branch_token);
    const branchId = decoded && decoded.branch_id ? decoded.branch_id : null;
    branch = branchId ? findBranch(index, branchId) : null;
  }
  if (!branch) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'delegated_authority_evaluate', error: 'branch_not_found' })}\n`);
    process.exit(1);
  }

  const evaluation = evaluateAgainstBranch(policy, branch, scope, role);
  const out = {
    ok: evaluation.ok,
    type: 'delegated_authority_evaluate',
    branch_id: branch.branch_id,
    delegate_id: branch.delegate_id,
    scope,
    role,
    evaluation,
    policy_path: rel(policy.policy_path)
  };
  emitReceipt(policy, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (!out.ok) process.exit(1);
}

function cmdRevoke(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const apply = toBool(args.apply, true);
  const revokedBy = normalizeToken(args['revoked-by'] || args.revoked_by || '', 120);
  const reason = cleanText(args.reason || '', 500);
  const branchId = normalizeToken(args['branch-id'] || args.branch_id || '', 120);

  if (!branchId || !revokedBy || reason.length < policy.min_approval_note_chars) {
    const out = {
      ok: false,
      type: 'delegated_authority_revoke',
      error: 'branch_id_revoked_by_reason_required',
      min_reason_chars: policy.min_approval_note_chars
    };
    emitReceipt(policy, out);
    writeJsonAtomic(policy.paths.latest_path, out);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }

  const index = loadIndex(policy);
  const branch = findBranch(index, branchId);
  if (!branch) {
    const out = {
      ok: false,
      type: 'delegated_authority_revoke',
      error: 'branch_not_found',
      branch_id: branchId
    };
    emitReceipt(policy, out);
    writeJsonAtomic(policy.paths.latest_path, out);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }

  if (apply && policy.shadow_only !== true) {
    branch.revoked_at = nowIso();
    branch.revoked_by = revokedBy;
    branch.revoked_reason = reason;
    branch.status = 'revoked';
    saveIndex(policy, index);
  }

  const out = {
    ok: true,
    type: 'delegated_authority_revoke',
    branch_id: branchId,
    revoked_by: revokedBy,
    reason,
    apply,
    shadow_only: policy.shadow_only === true,
    policy_path: rel(policy.policy_path)
  };
  emitReceipt(policy, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdHandoffContract(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const index = loadIndex(policy);
  const branch = findBranch(index, args['branch-id'] || args.branch_id || '');
  if (!branch) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'delegated_authority_handoff_contract', error: 'branch_not_found' })}\n`);
    process.exit(1);
  }

  const contract = {
    schema_id: 'delegated_authority_handoff_contract',
    schema_version: '1.0',
    contract_id: policy.handoff_contract.v4_contract_id,
    branch_id: branch.branch_id,
    delegate_id: branch.delegate_id,
    roles: branch.roles,
    scopes: branch.scopes,
    issued_at: branch.issued_at,
    expires_at: branch.expires_at,
    revoked_at: branch.revoked_at || null,
    minimum_fields: policy.handoff_contract.minimum_fields,
    compatible_with: 'V4-006'
  };

  const out = {
    ok: true,
    type: 'delegated_authority_handoff_contract',
    contract
  };
  emitReceipt(policy, out);
  writeJsonAtomic(policy.paths.latest_path, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const index = loadIndex(policy);
  const now = Date.now();
  const rows = Array.isArray(index.branches) ? index.branches : [];
  const activeCount = rows.filter((row: AnyObj) => {
    const exp = parseIsoMs(row.expires_at);
    return normalizeToken(row.status || '', 40) === 'active' && !row.revoked_at && exp != null && now < exp;
  }).length;
  const revokedCount = rows.filter((row: AnyObj) => !!row.revoked_at || normalizeToken(row.status || '', 40) === 'revoked').length;
  const keyState = loadKeyState(policy);
  const constitutionState = loadConstitutionState(policy);

  const out = {
    ok: true,
    type: 'delegated_authority_status',
    ts: nowIso(),
    policy: {
      path: rel(policy.policy_path),
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true,
      required_key_class: policy.required_key_class,
      denied_scope_count: policy.constitution_denied_scopes.length
    },
    counts: {
      total_branches: rows.length,
      active_branches: activeCount,
      revoked_branches: revokedCount
    },
    gates: {
      key_state: keyState,
      constitution_guard: constitutionState
    },
    paths: {
      index_path: rel(policy.paths.index_path),
      receipts_path: rel(policy.paths.receipts_path)
    }
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 80);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'issue') return cmdIssue(args);
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'revoke') return cmdRevoke(args);
  if (cmd === 'handoff-contract') return cmdHandoffContract(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  cmdIssue,
  cmdEvaluate,
  cmdRevoke,
  cmdHandoffContract,
  cmdStatus
};
