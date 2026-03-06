#!/usr/bin/env node
'use strict';

/**
 * environment_promotion_gate.js
 *
 * Multi-team / multi-environment release governance gate.
 *
 * Usage:
 *   node systems/ops/environment_promotion_gate.js promote --from=dev --to=stage --owner=<team> --artifact=<id> --checks=a,b,c --approval-note="..." [--approver-id=<id>] [--second-approver-id=<id>] [--second-approval-note="..."]
 *   node systems/ops/environment_promotion_gate.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.ENV_PROMOTION_POLICY_PATH
  ? path.resolve(process.env.ENV_PROMOTION_POLICY_PATH)
  : path.join(ROOT, 'config', 'environment_promotion_policy.json');
const LOG_PATH = process.env.ENV_PROMOTION_LOG_PATH
  ? path.resolve(process.env.ENV_PROMOTION_LOG_PATH)
  : path.join(ROOT, 'state', 'ops', 'environment_promotions.jsonl');
const STATE_PATH = process.env.ENV_PROMOTION_STATE_PATH
  ? path.resolve(process.env.ENV_PROMOTION_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'environment_promotion_state.json');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/environment_promotion_gate.js promote --from=dev --to=stage --owner=<team> --artifact=<id> --checks=a,b,c --approval-note="..." [--approver-id=<id>] [--second-approver-id=<id>] [--second-approval-note="..."]');
  console.log('  node systems/ops/environment_promotion_gate.js status');
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

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = normalizeText(v, 24).toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function normalizeToken(v, maxLen = 80) {
  return normalizeText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath, value) {
  ensureDir(filePath);
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function relPath(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function parseCsvTokens(v) {
  return String(v || '')
    .split(',')
    .map((x) => normalizeToken(x, 120))
    .filter(Boolean);
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: true,
    environment_order: ['dev', 'stage', 'prod'],
    ownership: {
      dev: ['platform'],
      stage: ['platform', 'qa'],
      prod: ['platform', 'security']
    },
    dual_control_envs: ['prod'],
    min_approval_note_len: 12,
    required_checks_by_env: {
      stage: ['contract_check', 'schema_contract_check'],
      prod: ['contract_check', 'integrity_kernel_check', 'schema_contract_check', 'ci_suite']
    }
  };
}

function normalizeOwnershipMap(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [env, teams] of Object.entries(src)) {
    const envKey = normalizeToken(env, 64);
    if (!envKey) continue;
    out[envKey] = Array.from(new Set((Array.isArray(teams) ? teams : [])
      .map((t) => normalizeToken(t, 120))
      .filter(Boolean)));
  }
  return out;
}

function normalizeChecksMap(raw) {
  const out = {};
  const src = raw && typeof raw === 'object' ? raw : {};
  for (const [env, checks] of Object.entries(src)) {
    const envKey = normalizeToken(env, 64);
    if (!envKey) continue;
    out[envKey] = Array.from(new Set((Array.isArray(checks) ? checks : [])
      .map((c) => normalizeToken(c, 120))
      .filter(Boolean)));
  }
  return out;
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const order = Array.isArray(src.environment_order) && src.environment_order.length
    ? src.environment_order
    : base.environment_order;
  return {
    version: normalizeText(src.version || base.version, 32) || '1.0',
    strict_default: src.strict_default !== false,
    environment_order: Array.from(new Set(order.map((v) => normalizeToken(v, 64)).filter(Boolean))),
    ownership: Object.keys(src.ownership || {}).length > 0
      ? normalizeOwnershipMap(src.ownership)
      : normalizeOwnershipMap(base.ownership),
    dual_control_envs: Array.from(new Set((Array.isArray(src.dual_control_envs) ? src.dual_control_envs : base.dual_control_envs)
      .map((v) => normalizeToken(v, 64))
      .filter(Boolean))),
    min_approval_note_len: Math.max(8, Number(src.min_approval_note_len || base.min_approval_note_len || 12)),
    required_checks_by_env: Object.keys(src.required_checks_by_env || {}).length > 0
      ? normalizeChecksMap(src.required_checks_by_env)
      : normalizeChecksMap(base.required_checks_by_env)
  };
}

function loadState() {
  const src = readJson(STATE_PATH, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'environment_promotion_state',
      schema_version: '1.0',
      last_promotions: {},
      updated_at: null
    };
  }
  return {
    schema_id: 'environment_promotion_state',
    schema_version: '1.0',
    last_promotions: src.last_promotions && typeof src.last_promotions === 'object' ? src.last_promotions : {},
    updated_at: normalizeText(src.updated_at || '', 64) || null
  };
}

function saveState(state) {
  writeJsonAtomic(STATE_PATH, {
    schema_id: 'environment_promotion_state',
    schema_version: '1.0',
    last_promotions: state.last_promotions && typeof state.last_promotions === 'object' ? state.last_promotions : {},
    updated_at: nowIso()
  });
}

function promotionDecision(args, policy) {
  const from = normalizeToken(args.from, 64);
  const to = normalizeToken(args.to, 64);
  const owner = normalizeToken(args.owner, 120);
  const artifact = normalizeText(args.artifact || '', 240);
  const checks = parseCsvTokens(args.checks || '');
  const approvalNote = normalizeText(args['approval-note'] || args.approval_note || '', 360);
  const approverId = normalizeToken(args['approver-id'] || args.approver_id || '', 120);
  const secondApproverId = normalizeToken(args['second-approver-id'] || args.second_approver_id || '', 120);
  const secondApprovalNote = normalizeText(args['second-approval-note'] || args.second_approval_note || '', 360);

  const out = {
    ok: false,
    decision: 'DENY',
    ts: nowIso(),
    from,
    to,
    owner,
    artifact,
    checks,
    reasons: []
  };

  if (!from) out.reasons.push('from_required');
  if (!to) out.reasons.push('to_required');
  if (!owner) out.reasons.push('owner_required');
  if (!artifact) out.reasons.push('artifact_required');
  if (approvalNote.length < policy.min_approval_note_len) out.reasons.push('approval_note_too_short');

  const order = policy.environment_order || [];
  const fromIdx = order.indexOf(from);
  const toIdx = order.indexOf(to);
  if (fromIdx === -1) out.reasons.push('from_environment_unknown');
  if (toIdx === -1) out.reasons.push('to_environment_unknown');
  if (fromIdx !== -1 && toIdx !== -1 && toIdx !== fromIdx + 1) out.reasons.push('non_sequential_promotion_blocked');

  const allowedOwners = policy.ownership && policy.ownership[to] ? policy.ownership[to] : [];
  if (!allowedOwners.includes(owner)) out.reasons.push('owner_not_authorized_for_target_env');

  const requiredChecks = policy.required_checks_by_env && policy.required_checks_by_env[to]
    ? policy.required_checks_by_env[to]
    : [];
  for (const req of requiredChecks) {
    if (!checks.includes(req)) out.reasons.push(`missing_required_check:${req}`);
  }

  const needsDual = policy.dual_control_envs.includes(to);
  if (needsDual) {
    if (!approverId) out.reasons.push('approver_id_required');
    if (!secondApproverId) out.reasons.push('second_approver_id_required');
    if (approverId && secondApproverId && approverId === secondApproverId) out.reasons.push('dual_approvers_must_differ');
    if (secondApprovalNote.length < policy.min_approval_note_len) out.reasons.push('second_approval_note_too_short');
  }

  if (out.reasons.length === 0) {
    out.ok = true;
    out.decision = 'ALLOW';
  }

  out.required_checks = requiredChecks;
  out.allowed_owners = allowedOwners;
  out.dual_control_required = needsDual;
  out.approver_id = approverId || null;
  out.second_approver_id = secondApproverId || null;

  return out;
}

function runIllusionAuditForPromotion(decision) {
  const enabled = String(process.env.ENV_PROMOTION_ILLUSION_AUDIT_ENABLED || '1') !== '0';
  if (!enabled) {
    return {
      ok: true,
      skipped: true,
      reason: 'feature_flag_disabled'
    };
  }
  const script = path.join(ROOT, 'systems', 'self_audit', 'illusion_integrity_lane.js');
  if (!fs.existsSync(script)) {
    return {
      ok: false,
      skipped: false,
      reason: 'illusion_audit_script_missing',
      script: relPath(script)
    };
  }
  const strict = String(process.env.ENV_PROMOTION_ILLUSION_AUDIT_STRICT || '0') === '1';
  const policyPath = normalizeText(
    process.env.ENV_PROMOTION_ILLUSION_AUDIT_POLICY_PATH || 'config/illusion_integrity_auditor_policy.json',
    320
  );
  const timeoutMs = Math.max(
    5000,
    Math.min(10 * 60 * 1000, Number(process.env.ENV_PROMOTION_ILLUSION_AUDIT_TIMEOUT_MS || 120000) || 120000)
  );
  const args = [
    script,
    'run',
    '--trigger=promotion',
    `--strict=${strict ? '1' : '0'}`,
    '--apply=0',
    `--policy=${policyPath}`
  ];
  if (decision && decision.artifact) args.push(`--promotion-artifact=${normalizeText(decision.artifact, 200)}`);
  const run = spawnSync('node', args, { cwd: ROOT, encoding: 'utf8', timeout: timeoutMs });
  let payload = null;
  try { payload = JSON.parse(String(run.stdout || '').trim()); } catch {}
  const ok = Number(run.status || 0) === 0 && !!payload && payload.ok === true;
  const payloadSummary = payload && payload.summary && typeof payload.summary === 'object' ? payload.summary : null;
  const payloadReason = payload && (payload.reason || payload.error)
    ? String(payload.reason || payload.error)
    : payload && payload.ok === false && payloadSummary
      ? `audit_failed:max_score_${Number(payloadSummary.max_score || 0)}`
      : null;
  return {
    ok,
    strict,
    skipped: false,
    status: Number.isFinite(run.status) ? run.status : 1,
    reason: ok
      ? null
      : normalizeText(
          payloadReason
          || String(run.stderr || '').trim()
          || String(run.stdout || '').trim()
          || `illusion_audit_exit_${Number.isFinite(run.status) ? run.status : 1}`,
          220
        ),
    finding_count: payload && payload.summary ? Number(payload.summary.finding_count || 0) : null,
    high_count: payload && payload.summary ? Number(payload.summary.high_count || 0) : null,
    max_score: payload && payload.summary ? Number(payload.summary.max_score || 0) : null,
    report_path: payload ? payload.report_path || null : null
  };
}

function cmdPromote(args) {
  const policy = loadPolicy();
  const strict = toBool(args.strict, policy.strict_default);
  const decision = promotionDecision(args, policy);
  const promotionAudit = decision.ok ? runIllusionAuditForPromotion(decision) : null;
  if (decision.ok && promotionAudit && promotionAudit.strict && promotionAudit.ok !== true) {
    decision.ok = false;
    decision.decision = 'DENY';
    decision.reasons = Array.isArray(decision.reasons) ? decision.reasons : [];
    decision.reasons.push('illusion_audit_strict_block');
  }

  appendJsonl(LOG_PATH, {
    type: 'environment_promotion_decision',
    policy_version: policy.version,
    strict,
    promotion_illusion_audit: promotionAudit,
    ...decision
  });

  if (decision.ok) {
    const state = loadState();
    state.last_promotions[decision.to] = {
      ts: decision.ts,
      from: decision.from,
      owner: decision.owner,
      artifact: decision.artifact,
      checks: decision.checks
    };
    saveState(state);
  }

  process.stdout.write(JSON.stringify({
    ...decision,
    promotion_illusion_audit: promotionAudit,
    policy_version: policy.version,
    log_path: relPath(LOG_PATH),
    state_path: relPath(STATE_PATH)
  }, null, 2) + '\n');

  if (strict && decision.ok !== true) process.exit(1);
}

function cmdStatus() {
  const policy = loadPolicy();
  const state = loadState();
  const rows = readJsonl(LOG_PATH)
    .filter((row) => row && row.type === 'environment_promotion_decision')
    .slice(-30);
  const denied = rows.filter((row) => row.decision !== 'ALLOW').length;

  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'environment_promotion_status',
    ts: nowIso(),
    policy_version: policy.version,
    environment_order: policy.environment_order,
    dual_control_envs: policy.dual_control_envs,
    ownership: policy.ownership,
    required_checks_by_env: policy.required_checks_by_env,
    recent_decisions: rows.length,
    recent_denied: denied,
    pass_rate: rows.length > 0 ? Number(((rows.length - denied) / rows.length).toFixed(4)) : null,
    last_promotions: state.last_promotions,
    log_path: relPath(LOG_PATH),
    state_path: relPath(STATE_PATH)
  }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeText(args._[0], 64).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd === 'promote') return cmdPromote(args);
  if (cmd === 'status') return cmdStatus();

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  promotionDecision
};
export {};
