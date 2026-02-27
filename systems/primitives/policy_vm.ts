#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PRIMITIVE_POLICY_VM_PATH
  ? path.resolve(process.env.PRIMITIVE_POLICY_VM_PATH)
  : path.join(ROOT, 'config', 'primitive_policy_vm.json');

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

function readJson(filePath: string, fallback: AnyObj) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
  } catch {
    // Best effort.
  }
}

function asTokenSet(src: unknown, maxLen = 120) {
  const rows = Array.isArray(src) ? src : [];
  const out = new Set<string>();
  for (const row of rows) {
    const token = normalizeToken(row, maxLen);
    if (token) out.add(token);
  }
  return out;
}

function loadPrimitivePolicyVm() {
  const base = {
    schema_id: 'primitive_policy_vm',
    schema_version: '1.0',
    mode: 'advisory',
    deny_effects: [],
    shadow_only_effects: [],
    allow_opcode_overrides: [],
    block_opcode_overrides: [],
    emit_audit: true,
    audit_path: 'state/runtime/policy_vm/decisions.jsonl'
  };
  const raw = readJson(DEFAULT_POLICY_PATH, base);
  const mode = normalizeToken(raw.mode || base.mode, 24);
  return {
    schema_id: 'primitive_policy_vm',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    mode: mode === 'enforce' ? 'enforce' : 'advisory',
    deny_effects: Array.from(asTokenSet(raw.deny_effects, 80)),
    shadow_only_effects: Array.from(asTokenSet(raw.shadow_only_effects, 80)),
    allow_opcode_overrides: Array.from(asTokenSet(raw.allow_opcode_overrides, 80)).map((v) => v.toUpperCase()),
    block_opcode_overrides: Array.from(asTokenSet(raw.block_opcode_overrides, 80)).map((v) => v.toUpperCase()),
    emit_audit: raw.emit_audit !== false,
    audit_path: cleanText(raw.audit_path || base.audit_path, 260) || base.audit_path,
    policy_path: path.resolve(DEFAULT_POLICY_PATH)
  };
}

function evaluatePrimitivePolicy(primitive: AnyObj, context: AnyObj = {}, opts: AnyObj = {}) {
  const policy = loadPrimitivePolicyVm();
  const effect = normalizeToken(primitive && primitive.effect ? primitive.effect : 'unknown', 80);
  const opcode = cleanText(primitive && primitive.opcode ? primitive.opcode : '', 80).toUpperCase() || 'UNKNOWN';
  const dryRun = opts.dry_run === true || context.dry_run === true;
  const advisoryReasons = [];
  const denyReasons = [];

  const blockedOpcode = policy.block_opcode_overrides.includes(opcode);
  const explicitlyAllowedOpcode = policy.allow_opcode_overrides.includes(opcode);
  if (blockedOpcode && !explicitlyAllowedOpcode) {
    denyReasons.push('opcode_blocked');
  }
  if (policy.deny_effects.includes(effect)) {
    denyReasons.push('effect_blocked');
  }
  if (!dryRun && policy.shadow_only_effects.includes(effect)) {
    denyReasons.push('effect_shadow_only');
  }

  let decision = 'allow';
  let ok = true;
  if (denyReasons.length) {
    if (policy.mode === 'enforce') {
      decision = denyReasons.includes('effect_shadow_only') ? 'shadow_only' : 'deny';
      ok = false;
    } else {
      decision = 'advisory';
      advisoryReasons.push(...denyReasons);
      denyReasons.length = 0;
      ok = true;
    }
  }

  const out = {
    ok,
    decision,
    mode: policy.mode,
    effect,
    opcode,
    deny_reasons: denyReasons,
    advisory_reasons: advisoryReasons,
    schema_version: policy.schema_version,
    policy_path: path.relative(ROOT, policy.policy_path) || policy.policy_path
  };

  if (policy.emit_audit) {
    const auditPath = path.isAbsolute(policy.audit_path)
      ? policy.audit_path
      : path.join(ROOT, policy.audit_path);
    appendJsonl(auditPath, {
      ts: nowIso(),
      type: 'primitive_policy_vm_decision',
      decision: out.decision,
      ok: out.ok,
      mode: out.mode,
      effect: out.effect,
      opcode: out.opcode,
      workflow_id: cleanText(context.workflow_id || '', 120) || null,
      run_id: cleanText(context.run_id || '', 120) || null,
      objective_id: cleanText(context.objective_id || '', 120) || null,
      dry_run: dryRun,
      deny_reasons: out.deny_reasons,
      advisory_reasons: out.advisory_reasons
    });
  }

  return out;
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPrimitivePolicyVm,
  evaluatePrimitivePolicy
};
