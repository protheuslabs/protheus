#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.REAL_WORLD_CLAWS_POLICY_PATH
  ? path.resolve(process.env.REAL_WORLD_CLAWS_POLICY_PATH)
  : path.join(ROOT, 'config', 'real_world_claws_policy.json');
const STATE_PATH = process.env.REAL_WORLD_CLAWS_STATE_PATH
  ? path.resolve(process.env.REAL_WORLD_CLAWS_STATE_PATH)
  : path.join(ROOT, 'state', 'actuation', 'real_world_claws', 'state.json');
const RECEIPTS_PATH = process.env.REAL_WORLD_CLAWS_RECEIPTS_PATH
  ? path.resolve(process.env.REAL_WORLD_CLAWS_RECEIPTS_PATH)
  : path.join(ROOT, 'state', 'actuation', 'real_world_claws', 'receipts.jsonl');
const ACTUATION_EXECUTOR_SCRIPT = process.env.REAL_WORLD_CLAWS_EXECUTOR_SCRIPT
  ? path.resolve(process.env.REAL_WORLD_CLAWS_EXECUTOR_SCRIPT)
  : path.join(ROOT, 'systems', 'actuation', 'actuation_executor.js');

type AnyObj = Record<string, any>;

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 260) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, '');
}
function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
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
function ensureDir(dir: string) { fs.mkdirSync(dir, { recursive: true }); }
function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}
function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) { out._.push(token); continue; }
    const i = token.indexOf('=');
    if (i < 0) out[token.slice(2)] = true;
    else out[token.slice(2, i)] = token.slice(i + 1);
  }
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    shadow_only: true,
    require_eye_route: true,
    approval_tiers: {
      low: { human_approval: false },
      medium: { human_approval: false },
      high: { human_approval: true },
      critical: { human_approval: true }
    },
    channels: {
      browser: { enabled: true, adapter: 'browser_action' },
      api: { enabled: true, adapter: 'api_request' },
      payments: { enabled: true, adapter: 'payment_action', always_human_approval: true },
      comms: { enabled: true, adapter: 'message_send' },
      files: { enabled: true, adapter: 'file_update' }
    },
    computer_use_hardening: {
      enabled: true,
      session_resume_on_fail: true,
      max_resume_attempts: 1,
      require_human_handoff_on_verification: true,
      verification_keywords: ['captcha', 'verification_code', '2fa', 'one_time_code'],
      checkpoints_path: 'state/actuation/real_world_claws/checkpoints.jsonl',
      handoff_path: 'state/actuation/real_world_claws/handoffs.jsonl'
    },
    max_steps_per_plan: 8
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const channelsRaw = raw.channels && typeof raw.channels === 'object' ? raw.channels : {};
  const hardeningRaw = raw.computer_use_hardening && typeof raw.computer_use_hardening === 'object'
    ? raw.computer_use_hardening
    : {};
  const outChannels: AnyObj = {};
  for (const key of Object.keys(base.channels)) {
    const src = channelsRaw[key] && typeof channelsRaw[key] === 'object' ? channelsRaw[key] : {};
    outChannels[key] = {
      enabled: src.enabled !== false && base.channels[key].enabled !== false,
      adapter: cleanText(src.adapter || base.channels[key].adapter, 120) || base.channels[key].adapter,
      always_human_approval: src.always_human_approval === true || base.channels[key].always_human_approval === true
    };
  }
  return {
    version: cleanText(raw.version || base.version, 32) || '1.0',
    shadow_only: raw.shadow_only !== false,
    require_eye_route: raw.require_eye_route !== false,
    approval_tiers: raw.approval_tiers && typeof raw.approval_tiers === 'object' ? raw.approval_tiers : base.approval_tiers,
    channels: outChannels,
    computer_use_hardening: {
      enabled: hardeningRaw.enabled !== false,
      session_resume_on_fail: hardeningRaw.session_resume_on_fail !== false,
      max_resume_attempts: clampInt(
        hardeningRaw.max_resume_attempts,
        0,
        5,
        base.computer_use_hardening.max_resume_attempts
      ),
      require_human_handoff_on_verification: hardeningRaw.require_human_handoff_on_verification !== false,
      verification_keywords: Array.isArray(hardeningRaw.verification_keywords)
        ? hardeningRaw.verification_keywords.map((row: unknown) => cleanText(row, 80).toLowerCase()).filter(Boolean)
        : base.computer_use_hardening.verification_keywords.slice(0),
      checkpoints_path: path.isAbsolute(cleanText(hardeningRaw.checkpoints_path || base.computer_use_hardening.checkpoints_path, 260))
        ? cleanText(hardeningRaw.checkpoints_path || base.computer_use_hardening.checkpoints_path, 260)
        : path.join(ROOT, cleanText(hardeningRaw.checkpoints_path || base.computer_use_hardening.checkpoints_path, 260)),
      handoff_path: path.isAbsolute(cleanText(hardeningRaw.handoff_path || base.computer_use_hardening.handoff_path, 260))
        ? cleanText(hardeningRaw.handoff_path || base.computer_use_hardening.handoff_path, 260)
        : path.join(ROOT, cleanText(hardeningRaw.handoff_path || base.computer_use_hardening.handoff_path, 260))
    },
    max_steps_per_plan: clampInt(raw.max_steps_per_plan, 1, 64, base.max_steps_per_plan)
  };
}

function defaultState() {
  return {
    schema_id: 'real_world_claws_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    plans: {},
    executions: {}
  };
}

function loadState() {
  const src = readJson(STATE_PATH, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'real_world_claws_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    plans: src.plans && typeof src.plans === 'object' ? src.plans : {},
    executions: src.executions && typeof src.executions === 'object' ? src.executions : {}
  };
}

function saveState(state: AnyObj) {
  writeJsonAtomic(STATE_PATH, {
    schema_id: 'real_world_claws_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    plans: state && state.plans && typeof state.plans === 'object' ? state.plans : {},
    executions: state && state.executions && typeof state.executions === 'object' ? state.executions : {}
  });
}

function parsePlan(arg: unknown) {
  try {
    const parsed = JSON.parse(String(arg || '{}'));
    const steps = Array.isArray(parsed.steps) ? parsed.steps : [];
    return {
      objective: cleanText(parsed.objective || '', 240),
      risk: normalizeToken(parsed.risk || 'medium', 24) || 'medium',
      steps: steps.map((s: AnyObj, idx: number) => ({
        id: normalizeToken(s.id || `step_${idx + 1}`, 80) || `step_${idx + 1}`,
        channel: normalizeToken(s.channel || '', 40),
        action: normalizeToken(s.action || '', 120),
        params: s.params && typeof s.params === 'object' ? s.params : {},
        dry_run: toBool(s.dry_run, false)
      }))
    };
  } catch {
    return null;
  }
}

function hasVerificationHint(input: AnyObj, keywords: string[]) {
  const text = JSON.stringify(input || {}).toLowerCase();
  for (const kwRaw of Array.isArray(keywords) ? keywords : []) {
    const kw = cleanText(kwRaw, 80).toLowerCase();
    if (!kw) continue;
    if (text.includes(kw)) return true;
  }
  return false;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/real_world_claws_bundle.js plan --plan-json="{objective,risk,steps:[...]}"');
  console.log('  node systems/actuation/real_world_claws_bundle.js execute --plan-id=<id> [--apply=1|0] [--approver-id=<id>] [--approval-note="..."]');
  console.log('  node systems/actuation/real_world_claws_bundle.js status [--plan-id=<id>]');
}

function cmdPlan(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  const parsed = parsePlan(args.plan_json || args['plan-json']);
  if (!parsed || !parsed.objective || !Array.isArray(parsed.steps) || parsed.steps.length === 0) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'real_world_claws_plan', error: 'valid_plan_json_required' })}\n`);
    process.exit(1);
  }
  const planId = normalizeToken(args.plan_id || args['plan-id'] || `claw_${Date.now().toString(36)}`, 120) || `claw_${Date.now().toString(36)}`;
  const steps = parsed.steps.slice(0, policy.max_steps_per_plan).filter((step: AnyObj) => policy.channels[step.channel] && policy.channels[step.channel].enabled);
  const blockedChannels = parsed.steps.filter((step: AnyObj) => !policy.channels[step.channel] || policy.channels[step.channel].enabled !== true).map((step: AnyObj) => step.channel);
  const record = {
    plan_id: planId,
    ts: nowIso(),
    objective: parsed.objective,
    risk: parsed.risk,
    steps,
    blocked_channels: Array.from(new Set(blockedChannels)).filter(Boolean),
    status: 'planned'
  };
  state.plans[planId] = record;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts: nowIso(), type: 'real_world_claws_plan', plan_id: planId, status: 'planned', blocked_channels: record.blocked_channels });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'real_world_claws_plan', plan: record })}\n`);
}

function runActuation(adapterKind: string, params: AnyObj, dryRun: boolean, context: AnyObj = {}) {
  const args = [
    ACTUATION_EXECUTOR_SCRIPT,
    'run',
    `--kind=${adapterKind}`,
    `--params=${JSON.stringify(params || {})}`,
    `--context=${JSON.stringify(context || {})}`
  ];
  if (dryRun) args.push('--dry-run');
  const proc = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
  let payload = null;
  try { payload = JSON.parse(String(proc.stdout || '').trim().split('\n').filter(Boolean).slice(-1)[0] || '{}'); } catch {}
  return {
    ok: Number(proc.status) === 0 && payload && payload.ok === true,
    status: Number(proc.status),
    payload,
    stderr: String(proc.stderr || '').trim().slice(0, 500)
  };
}

function cmdExecute(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState();
  const planId = normalizeToken(args.plan_id || args['plan-id'] || '', 120);
  const plan = planId ? state.plans[planId] : null;
  if (!plan) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'real_world_claws_execute', error: 'plan_not_found' })}\n`);
    process.exit(1);
  }
  const apply = toBool(args.apply, false);
  const approverId = normalizeToken(args.approver_id || args['approver-id'] || '', 120);
  const approvalNote = cleanText(args.approval_note || args['approval-note'] || '', 240);
  const tier = policy.approval_tiers[plan.risk] || policy.approval_tiers.medium;
  const requiresApproval = tier.human_approval === true || plan.steps.some((step: AnyObj) => policy.channels[step.channel] && policy.channels[step.channel].always_human_approval === true);

  const reasons: string[] = [];
  if (policy.shadow_only === true && apply === true) reasons.push('shadow_only_mode');
  if (requiresApproval && (!approverId || !approvalNote)) reasons.push('human_approval_required');
  const allowed = reasons.length === 0;

  const stepOutcomes = [];
  if (allowed) {
    for (const step of plan.steps) {
      const channelCfg = policy.channels[step.channel] || null;
      if (!channelCfg || channelCfg.enabled !== true) {
        stepOutcomes.push({ step_id: step.id, ok: false, reason: 'channel_disabled' });
        continue;
      }
      const dryRun = policy.shadow_only === true || apply !== true || toBool(step.dry_run, false);
      const hardeningEnabled = policy.computer_use_hardening
        && policy.computer_use_hardening.enabled === true;
      const protectedStep = hardeningEnabled
        && (step.channel === 'browser' || step.channel === 'api'
          || String(channelCfg.adapter || '').toLowerCase().includes('browser')
          || String(channelCfg.adapter || '').toLowerCase().includes('api'));
      const checkpointId = protectedStep
        ? (cleanText(step.params && step.params.checkpoint_id || '', 120)
          || `claw_chk_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`)
        : null;
      const sessionId = protectedStep
        ? (cleanText(step.params && step.params.session_id || '', 160) || null)
        : null;
      if (protectedStep) {
        appendJsonl(policy.computer_use_hardening.checkpoints_path, {
          ts: nowIso(),
          type: 'real_world_claws_checkpoint',
          plan_id: planId,
          step_id: step.id,
          channel: step.channel,
          adapter: channelCfg.adapter,
          session_id: sessionId,
          checkpoint_id: checkpointId
        });
      }
      const verificationDetected = protectedStep
        && hasVerificationHint(
          {
            action: step.action,
            params: step.params || {},
            channel: step.channel
          },
          policy.computer_use_hardening.verification_keywords || []
        );
      if (verificationDetected && policy.computer_use_hardening.require_human_handoff_on_verification === true) {
        appendJsonl(policy.computer_use_hardening.handoff_path, {
          ts: nowIso(),
          type: 'real_world_claws_handoff_required',
          reason: 'verification_detected',
          plan_id: planId,
          step_id: step.id,
          channel: step.channel,
          adapter: channelCfg.adapter,
          session_id: sessionId,
          checkpoint_id: checkpointId
        });
        stepOutcomes.push({
          step_id: step.id,
          channel: step.channel,
          adapter: channelCfg.adapter,
          dry_run: dryRun,
          ok: false,
          status: 1,
          recovery_attempts: 0,
          checkpoint_id: checkpointId,
          session_id: sessionId,
          verification_handoff_required: true,
          error: 'verification_handoff_required'
        });
        break;
      }
      const execContext = {
        plan_id: planId,
        step_id: step.id,
        channel: step.channel,
        session_id: sessionId,
        checkpoint_id: checkpointId
      };
      let exec = runActuation(channelCfg.adapter, step.params, dryRun, execContext);
      let recoveryAttempts = 0;
      const maxResumeAttempts = protectedStep && policy.computer_use_hardening.session_resume_on_fail === true
        ? Number(policy.computer_use_hardening.max_resume_attempts || 0)
        : 0;
      while (!exec.ok && recoveryAttempts < maxResumeAttempts) {
        recoveryAttempts += 1;
        const retryParams = {
          ...(step.params || {}),
          session_resume: true,
          recovery_attempt: recoveryAttempts
        };
        const retryContext = {
          ...execContext,
          recovery_attempt: recoveryAttempts,
          recovery_mode: 'session_resume'
        };
        exec = runActuation(channelCfg.adapter, retryParams, dryRun, retryContext);
        if (exec.ok) break;
      }
      stepOutcomes.push({
        step_id: step.id,
        channel: step.channel,
        adapter: channelCfg.adapter,
        dry_run: dryRun,
        ok: exec.ok,
        status: exec.status,
        recovery_attempts: recoveryAttempts,
        checkpoint_id: checkpointId,
        session_id: sessionId,
        verification_handoff_required: false,
        error: exec.ok ? null : (exec.payload && exec.payload.error) || exec.stderr || 'execution_failed'
      });
      if (!exec.ok) break;
    }
  }

  const success = allowed && stepOutcomes.every((row: AnyObj) => row.ok === true);
  const executionId = normalizeToken(`exec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, 120);
  const record = {
    execution_id: executionId,
    plan_id: planId,
    ts: nowIso(),
    apply,
    allowed,
    reasons,
    approver_id: approverId || null,
    approval_note: approvalNote || null,
    success,
    step_outcomes: stepOutcomes
  };
  state.executions[executionId] = record;
  plan.status = success ? 'executed' : 'failed';
  plan.last_execution_id = executionId;
  state.plans[planId] = plan;
  saveState(state);
  appendJsonl(RECEIPTS_PATH, { ts: nowIso(), type: 'real_world_claws_execute', ...record });
  process.stdout.write(`${JSON.stringify({ ok: success, type: 'real_world_claws_execute', execution: record })}\n`);
  if (!success) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const state = loadState();
  const planId = normalizeToken(args.plan_id || args['plan-id'] || '', 120);
  const out = {
    ok: true,
    type: 'real_world_claws_status',
    ts: nowIso(),
    plan_id: planId || null,
    plan: planId ? (state.plans[planId] || null) : null,
    plans: planId ? undefined : state.plans,
    executions: planId ? undefined : state.executions
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'plan') return cmdPlan(args);
  if (cmd === 'execute') return cmdExecute(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
