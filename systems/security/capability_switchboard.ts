#!/usr/bin/env node
'use strict';

/**
 * capability_switchboard.js
 *
 * Security-locked global capability switchboard.
 *
 * Usage:
 *   node systems/security/capability_switchboard.js status
 *   node systems/security/capability_switchboard.js evaluate --switch=<id>
 *   node systems/security/capability_switchboard.js set --switch=<id> --state=on|off --approver-id=<id> --approval-note="..." --second-approver-id=<id> --second-approval-note="..." [--lease-token=<token>]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CAPABILITY_SWITCHBOARD_POLICY_PATH
  ? path.resolve(process.env.CAPABILITY_SWITCHBOARD_POLICY_PATH)
  : path.join(ROOT, 'config', 'capability_switchboard_policy.json');
const STATE_PATH = process.env.CAPABILITY_SWITCHBOARD_STATE_PATH
  ? path.resolve(process.env.CAPABILITY_SWITCHBOARD_STATE_PATH)
  : path.join(ROOT, 'state', 'security', 'capability_switchboard_state.json');
const AUDIT_PATH = process.env.CAPABILITY_SWITCHBOARD_AUDIT_PATH
  ? path.resolve(process.env.CAPABILITY_SWITCHBOARD_AUDIT_PATH)
  : path.join(ROOT, 'state', 'security', 'capability_switchboard_audit.jsonl');
const POLICY_ROOT_SCRIPT = process.env.CAPABILITY_SWITCHBOARD_POLICY_ROOT_SCRIPT
  ? path.resolve(process.env.CAPABILITY_SWITCHBOARD_POLICY_ROOT_SCRIPT)
  : path.join(ROOT, 'systems', 'security', 'policy_rootd.js');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/capability_switchboard.js status');
  console.log('  node systems/security/capability_switchboard.js evaluate --switch=<id>');
  console.log('  node systems/security/capability_switchboard.js set --switch=<id> --state=on|off --approver-id=<id> --approval-note="..." --second-approver-id=<id> --second-approval-note="..." [--lease-token=<token>]');
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

function normalizeText(v, maxLen = 240) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
}

function normalizeSwitchId(v) {
  return normalizeText(v, 120)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBoolState(v) {
  const s = normalizeText(v, 24).toLowerCase();
  if (['1', 'true', 'on', 'enable', 'enabled', 'yes'].includes(s)) return true;
  if (['0', 'false', 'off', 'disable', 'disabled', 'no'].includes(s)) return false;
  return null;
}

function ensureDir(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    require_dual_control: true,
    dual_control_min_note_len: 12,
    policy_root: {
      required: true,
      scope: 'capability_switchboard_toggle'
    },
    switches: {
      autonomy: {
        default_enabled: true,
        security_locked: false,
        require_policy_root: true,
        description: 'Core autonomy execution lane'
      },
      reflex: {
        default_enabled: true,
        security_locked: false,
        require_policy_root: true,
        description: 'Reflex execution lane'
      },
      dreams: {
        default_enabled: true,
        security_locked: false,
        require_policy_root: true,
        description: 'Dream/idle synthesis lane'
      },
      sensory_depth: {
        default_enabled: true,
        security_locked: false,
        require_policy_root: true,
        description: 'Deep sensory collection lane'
      },
      routing_modes: {
        default_enabled: true,
        security_locked: false,
        require_policy_root: true,
        description: 'Model/router adaptive modes'
      },
      external_actuation: {
        default_enabled: true,
        security_locked: false,
        require_policy_root: true,
        description: 'Outbound actuation lane'
      },
      security: {
        default_enabled: true,
        security_locked: true,
        require_policy_root: true,
        description: 'Security subsystem controls (non-deactivatable)'
      },
      integrity: {
        default_enabled: true,
        security_locked: true,
        require_policy_root: true,
        description: 'Integrity kernel controls (non-deactivatable)'
      }
    }
  };
}

function normalizeSwitchRecord(id, raw, fallbackDefault = true) {
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    id,
    default_enabled: src.default_enabled !== false ? true : false,
    security_locked: src.security_locked === true,
    require_policy_root: src.require_policy_root !== false,
    description: normalizeText(src.description || '', 180) || null,
    source_scope: normalizeText(src.source_scope || '', 120) || null,
    fallback_default: fallbackDefault
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const switches = {};
  const rawSwitches = src && src.switches && typeof src.switches === 'object' ? src.switches : {};
  const mergedSwitches = {
    ...base.switches,
    ...rawSwitches
  };
  for (const [rawId, row] of Object.entries(mergedSwitches)) {
    const id = normalizeSwitchId(rawId);
    if (!id) continue;
    switches[id] = normalizeSwitchRecord(id, row, true);
  }
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    require_dual_control: src.require_dual_control !== false,
    dual_control_min_note_len: Math.max(8, Number(src.dual_control_min_note_len || base.dual_control_min_note_len || 12)),
    policy_root: {
      required: !(src.policy_root && src.policy_root.required === false),
      scope: normalizeText(src.policy_root && src.policy_root.scope || base.policy_root.scope, 120) || 'capability_switchboard_toggle'
    },
    switches
  };
}

function loadState(statePath = STATE_PATH) {
  const src = readJson(statePath, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'capability_switchboard_state',
      schema_version: '1.0',
      updated_at: null,
      switches: {}
    };
  }
  return {
    schema_id: 'capability_switchboard_state',
    schema_version: '1.0',
    updated_at: normalizeText(src.updated_at || '', 64) || null,
    switches: src.switches && typeof src.switches === 'object' ? src.switches : {}
  };
}

function saveState(state, statePath = STATE_PATH) {
  writeJsonAtomic(statePath, {
    schema_id: 'capability_switchboard_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    switches: state && state.switches && typeof state.switches === 'object' ? state.switches : {}
  });
}

function effectiveSwitches(policy, state) {
  const out = {};
  for (const [id, row] of Object.entries(policy.switches || {})) {
    const override = state && state.switches && state.switches[id] && typeof state.switches[id] === 'object'
      ? state.switches[id]
      : null;
    const enabled = override && typeof override.enabled === 'boolean'
      ? override.enabled
      : row.default_enabled !== false;
    out[id] = {
      id,
      enabled,
      default_enabled: row.default_enabled !== false,
      security_locked: row.security_locked === true,
      require_policy_root: row.require_policy_root !== false,
      description: row.description || null,
      updated_at: override && override.updated_at ? String(override.updated_at) : null,
      updated_by: override && override.updated_by ? String(override.updated_by) : null,
      reason: override && override.reason ? String(override.reason) : null
    };
  }
  return out;
}

function runPolicyRootAuthorize({ scope, target, approvalNote, leaseToken, source }) {
  const args = [
    POLICY_ROOT_SCRIPT,
    'authorize',
    `--scope=${normalizeText(scope || '', 120)}`,
    `--target=${normalizeText(target || '', 120)}`,
    `--approval-note=${normalizeText(approvalNote || '', 320)}`,
    `--source=${normalizeText(source || 'capability_switchboard', 120)}`
  ];
  if (leaseToken) args.push(`--lease-token=${normalizeText(leaseToken, 8192)}`);
  const r = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
  let payload = null;
  if (stdout) {
    try { payload = JSON.parse(stdout); } catch {}
  }
  return {
    ok: r.status === 0 && payload && payload.ok === true && payload.decision === 'ALLOW',
    code: Number(r.status || 0),
    payload,
    stdout,
    stderr
  };
}

function validateDualControl(policy, args) {
  if (policy.require_dual_control !== true) {
    return { ok: true, dual_control: { required: false } };
  }
  const approverId = normalizeText(args['approver-id'] || args.approver_id || '', 120);
  const secondApproverId = normalizeText(args['second-approver-id'] || args.second_approver_id || '', 120);
  const approvalNote = normalizeText(args['approval-note'] || args.approval_note || '', 360);
  const secondApprovalNote = normalizeText(args['second-approval-note'] || args.second_approval_note || '', 360);
  const minLen = Number(policy.dual_control_min_note_len || 12);

  if (!approverId) return { ok: false, error: 'approver_id_required' };
  if (!secondApproverId) return { ok: false, error: 'second_approver_id_required' };
  if (approverId === secondApproverId) return { ok: false, error: 'dual_control_approvers_must_differ' };
  if (approvalNote.length < minLen) return { ok: false, error: 'approval_note_too_short', min_len: minLen };
  if (secondApprovalNote.length < minLen) return { ok: false, error: 'second_approval_note_too_short', min_len: minLen };

  return {
    ok: true,
    dual_control: {
      required: true,
      approver_id: approverId,
      second_approver_id: secondApproverId,
      approval_note: approvalNote,
      second_approval_note: secondApprovalNote
    }
  };
}

function cmdStatus(policyPath = POLICY_PATH, statePath = STATE_PATH) {
  const policy = loadPolicy(policyPath);
  const state = loadState(statePath);
  const effective = effectiveSwitches(policy, state);
  const disabled = Object.values(effective).filter((row) => row.enabled !== true).map((row) => row.id);
  const out = {
    ok: true,
    type: 'capability_switchboard_status',
    ts: nowIso(),
    policy_path: path.relative(ROOT, policyPath),
    state_path: path.relative(ROOT, statePath),
    policy_version: policy.version,
    require_dual_control: policy.require_dual_control === true,
    policy_root_required: policy.policy_root.required === true,
    disabled,
    switches: Object.values(effective)
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function cmdEvaluate(args, policyPath = POLICY_PATH, statePath = STATE_PATH) {
  const switchId = normalizeSwitchId(args.switch);
  if (!switchId) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'switch_required' }) + '\n');
    process.exit(2);
  }
  const policy = loadPolicy(policyPath);
  const state = loadState(statePath);
  const effective = effectiveSwitches(policy, state);
  const row = effective[switchId];
  if (!row) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'unknown_switch', switch: switchId }) + '\n');
    process.exit(2);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'capability_switchboard_evaluate',
    ts: nowIso(),
    switch: switchId,
    enabled: row.enabled === true,
    security_locked: row.security_locked === true
  }, null, 2) + '\n');
}

function cmdSet(args, opts = {}) {
  const policyPath = opts.policyPath || POLICY_PATH;
  const statePath = opts.statePath || STATE_PATH;
  const auditPath = opts.auditPath || AUDIT_PATH;
  const switchId = normalizeSwitchId(args.switch);
  const desired = toBoolState(args.state);
  const actor = normalizeText(args.actor || process.env.USER || 'unknown', 120);
  const reason = normalizeText(args.reason || '', 240) || null;

  if (!switchId) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'switch_required' }) + '\n');
    process.exit(2);
  }
  if (desired == null) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'state_required_on_or_off' }) + '\n');
    process.exit(2);
  }

  const policy = loadPolicy(policyPath);
  const state = loadState(statePath);
  const effective = effectiveSwitches(policy, state);
  const row = effective[switchId];
  if (!row) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'unknown_switch', switch: switchId }) + '\n');
    process.exit(2);
  }
  if (row.security_locked === true && desired === false) {
    const out = {
      ok: false,
      type: 'capability_switchboard_set',
      ts: nowIso(),
      switch: switchId,
      previous_enabled: row.enabled === true,
      requested_enabled: desired,
      reason: 'security_locked_non_deactivatable'
    };
    appendJsonl(auditPath, out);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  }

  const dual = validateDualControl(policy, args);
  if (!dual.ok) {
    const out = {
      ok: false,
      type: 'capability_switchboard_set',
      ts: nowIso(),
      switch: switchId,
      previous_enabled: row.enabled === true,
      requested_enabled: desired,
      reason: dual.error,
      min_len: dual.min_len || null
    };
    appendJsonl(auditPath, out);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(1);
  }

  let policyRoot = {
    required: policy.policy_root.required === true && row.require_policy_root === true,
    ok: true,
    payload: null,
    reason: null
  };
  if (policyRoot.required) {
    const pr = runPolicyRootAuthorize({
      scope: policy.policy_root.scope || 'capability_switchboard_toggle',
      target: switchId,
      approvalNote: dual.dual_control && dual.dual_control.approval_note,
      leaseToken: args['lease-token'] || args.lease_token || process.env.CAPABILITY_LEASE_TOKEN || '',
      source: 'capability_switchboard'
    });
    if (!pr.ok) {
      policyRoot = {
        required: true,
        ok: false,
        payload: pr.payload,
        reason: pr.stderr || pr.stdout || `policy_root_exit_${pr.code}`
      };
      const out = {
        ok: false,
        type: 'capability_switchboard_set',
        ts: nowIso(),
        switch: switchId,
        previous_enabled: row.enabled === true,
        requested_enabled: desired,
        reason: 'policy_root_denied',
        policy_root: policyRoot
      };
      appendJsonl(auditPath, out);
      process.stdout.write(JSON.stringify(out, null, 2) + '\n');
      process.exit(1);
    }
    policyRoot = {
      required: true,
      ok: true,
      payload: pr.payload || null,
      reason: null
    };
  }

  const prev = row.enabled === true;
  const updatedAt = nowIso();
  state.switches[switchId] = {
    enabled: desired,
    updated_at: updatedAt,
    updated_by: actor,
    reason,
    dual_control: dual.dual_control,
    policy_root: policyRoot
  };
  saveState(state, statePath);

  const out = {
    ok: true,
    type: 'capability_switchboard_set',
    ts: updatedAt,
    switch: switchId,
    previous_enabled: prev,
    enabled: desired,
    changed: prev !== desired,
    actor,
    reason,
    dual_control: {
      required: dual.dual_control.required === true,
      approver_id: dual.dual_control.approver_id,
      second_approver_id: dual.dual_control.second_approver_id
    },
    policy_root: {
      required: policyRoot.required,
      ok: policyRoot.ok,
      lease_id: policyRoot.payload && policyRoot.payload.lease_id ? policyRoot.payload.lease_id : null
    },
    state_path: path.relative(ROOT, statePath)
  };
  appendJsonl(auditPath, out);
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd === 'status') return cmdStatus();
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'set') return cmdSet(args);

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadState,
  effectiveSwitches,
  validateDualControl,
  runPolicyRootAuthorize
};
export {};
