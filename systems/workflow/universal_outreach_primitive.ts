#!/usr/bin/env node
'use strict';
export {};

/**
 * universal_outreach_primitive.js
 *
 * V3-ACT-002 scaffold:
 * - Profile-driven outreach planning and shadow execution.
 * - Disposable infrastructure brokering integration.
 * - Burn-oracle-aware batch sizing with deterministic reason codes.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.UNIVERSAL_OUTREACH_PRIMITIVE_POLICY_PATH
  ? path.resolve(process.env.UNIVERSAL_OUTREACH_PRIMITIVE_POLICY_PATH)
  : path.join(ROOT, 'config', 'universal_outreach_primitive_policy.json');
const DISPOSABLE_INFRA_SCRIPT = path.join(ROOT, 'systems', 'actuation', 'disposable_infrastructure_organ.js');
const EYE_KERNEL_SCRIPT = path.join(ROOT, 'systems', 'eye', 'eye_kernel.js');
const SOUL_GUARD_SCRIPT = path.join(ROOT, 'systems', 'security', 'soul_token_guard.js');
const CONSTITUTION_GUARD_SCRIPT = path.join(ROOT, 'systems', 'security', 'constitution_guardian.js');
const WEAVER_CORE_SCRIPT = path.join(ROOT, 'systems', 'weaver', 'weaver_core.js');
const ZERO_PERMISSION_LAYER_SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'zero_permission_conversational_layer.js');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 480);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function parseJsonArg(raw: unknown, fallback: any) {
  const text = cleanText(raw, 100000);
  if (!text) return fallback;
  const body = text.startsWith('@')
    ? fs.readFileSync(path.resolve(text.slice(1)), 'utf8')
    : text;
  try {
    const parsed = JSON.parse(body);
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function runNodeJson(scriptPath: string, args: string[], envExtras: AnyObj = {}, timeoutMs = 1200) {
  const proc = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: clampInt(timeoutMs, 200, 120000, 1200),
    maxBuffer: 1024 * 1024,
    env: {
      ...process.env,
      ...envExtras
    }
  });
  const stdout = String(proc.stdout || '').trim();
  let payload = null;
  if (stdout) {
    try {
      payload = JSON.parse(stdout);
    } catch {
      const lines = stdout.split('\n');
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          payload = JSON.parse(lines[i]);
          break;
        } catch {}
      }
    }
  }
  return {
    ok: proc.status === 0,
    code: Number(proc.status || 0),
    payload,
    stdout,
    stderr: String(proc.stderr || '').trim(),
    timed_out: Boolean(proc.error && (proc.error as AnyObj).code === 'ETIMEDOUT')
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_leads_per_batch: 25,
    min_personalization_score: 0.55,
    high_burn_batch_cap: 5,
    critical_burn_batch_cap: 2,
    default_channel: 'email',
    default_region: 'us',
    autonomous_execution: {
      enabled: true,
      high_risk_min_approval_note_chars: 12,
      medium_veto_window_minutes: 10,
      low_to_medium_promote_usd: 50,
      default_cost_per_lead_usd: 8,
      default_liability_score: 0.35,
      workflow_class_default: 'revenue_outreach',
      allow_gate_timeout_low_medium: true,
      threshold_usd: {
        low: 100,
        medium: 1000
      },
      liability_threshold: {
        low: 0.2,
        medium: 0.55
      }
    },
    dependencies: {
      burn_oracle_latest_path: 'state/ops/dynamic_burn_budget_oracle/latest.json',
      disposable_infra_policy_path: 'config/disposable_infrastructure_organ_policy.json',
      weaver_latest_path: 'state/autonomy/weaver/latest.json'
    },
    profile_pack: {
      actions: [
        { id: 'site_build', profile_id: 'marketing_site_generator_v1', lane: 'build', required: true },
        { id: 'site_deploy', profile_id: 'static_site_deploy_v1', lane: 'deploy', required: true },
        { id: 'email_draft', profile_id: 'cold_email_personalize_v1', lane: 'draft', required: true },
        { id: 'email_send', profile_id: 'cold_email_send_v1', lane: 'send', required: true },
        { id: 'followup_schedule', profile_id: 'followup_schedule_v1', lane: 'followup', required: false }
      ],
      storm_human_lane: {
        enabled: true,
        queue_name: 'storm_human_outreach_review'
      }
    },
    state: {
      state_path: 'state/workflow/universal_outreach_primitive/state.json',
      campaigns_dir: 'state/workflow/universal_outreach_primitive/campaigns',
      latest_path: 'state/workflow/universal_outreach_primitive/latest.json',
      receipts_path: 'state/workflow/universal_outreach_primitive/receipts.jsonl',
      weaver_hints_path: 'state/autonomy/weaver/outreach_hints.jsonl'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const deps = raw.dependencies && typeof raw.dependencies === 'object' ? raw.dependencies : {};
  const profilePack = raw.profile_pack && typeof raw.profile_pack === 'object' ? raw.profile_pack : {};
  const stormLane = profilePack.storm_human_lane && typeof profilePack.storm_human_lane === 'object'
    ? profilePack.storm_human_lane
    : {};
  const autoExec = raw.autonomous_execution && typeof raw.autonomous_execution === 'object'
    ? raw.autonomous_execution
    : {};
  const thresholdUsd = autoExec.threshold_usd && typeof autoExec.threshold_usd === 'object'
    ? autoExec.threshold_usd
    : {};
  const liabilityThreshold = autoExec.liability_threshold && typeof autoExec.liability_threshold === 'object'
    ? autoExec.liability_threshold
    : {};
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    max_leads_per_batch: clampInt(raw.max_leads_per_batch, 1, 5000, base.max_leads_per_batch),
    min_personalization_score: clampNumber(raw.min_personalization_score, 0, 1, base.min_personalization_score),
    high_burn_batch_cap: clampInt(raw.high_burn_batch_cap, 1, 1000, base.high_burn_batch_cap),
    critical_burn_batch_cap: clampInt(raw.critical_burn_batch_cap, 1, 500, base.critical_burn_batch_cap),
    default_channel: normalizeToken(raw.default_channel || base.default_channel, 40) || base.default_channel,
    default_region: normalizeToken(raw.default_region || base.default_region, 40) || base.default_region,
    autonomous_execution: {
      enabled: autoExec.enabled !== false,
      high_risk_min_approval_note_chars: clampInt(
        autoExec.high_risk_min_approval_note_chars,
        1,
        200,
        base.autonomous_execution.high_risk_min_approval_note_chars
      ),
      medium_veto_window_minutes: clampInt(
        autoExec.medium_veto_window_minutes,
        0,
        24 * 60,
        base.autonomous_execution.medium_veto_window_minutes
      ),
      low_to_medium_promote_usd: clampNumber(
        autoExec.low_to_medium_promote_usd,
        0,
        1000000,
        base.autonomous_execution.low_to_medium_promote_usd
      ),
      default_cost_per_lead_usd: clampNumber(
        autoExec.default_cost_per_lead_usd,
        0,
        10000,
        base.autonomous_execution.default_cost_per_lead_usd
      ),
      default_liability_score: clampNumber(
        autoExec.default_liability_score,
        0,
        1,
        base.autonomous_execution.default_liability_score
      ),
      workflow_class_default: normalizeToken(
        autoExec.workflow_class_default || base.autonomous_execution.workflow_class_default,
        80
      ) || base.autonomous_execution.workflow_class_default,
      allow_gate_timeout_low_medium: autoExec.allow_gate_timeout_low_medium !== false,
      threshold_usd: {
        low: clampNumber(thresholdUsd.low, 0, 1000000, base.autonomous_execution.threshold_usd.low),
        medium: clampNumber(thresholdUsd.medium, 0, 10000000, base.autonomous_execution.threshold_usd.medium)
      },
      liability_threshold: {
        low: clampNumber(
          liabilityThreshold.low,
          0,
          1,
          base.autonomous_execution.liability_threshold.low
        ),
        medium: clampNumber(
          liabilityThreshold.medium,
          0,
          1,
          base.autonomous_execution.liability_threshold.medium
        )
      }
    },
    dependencies: {
      burn_oracle_latest_path: resolvePath(deps.burn_oracle_latest_path || base.dependencies.burn_oracle_latest_path, base.dependencies.burn_oracle_latest_path),
      disposable_infra_policy_path: resolvePath(deps.disposable_infra_policy_path || base.dependencies.disposable_infra_policy_path, base.dependencies.disposable_infra_policy_path),
      weaver_latest_path: resolvePath(deps.weaver_latest_path || base.dependencies.weaver_latest_path, base.dependencies.weaver_latest_path)
    },
    profile_pack: {
      actions: (Array.isArray(profilePack.actions) ? profilePack.actions : base.profile_pack.actions)
        .map((row: AnyObj) => ({
          id: normalizeToken(row && row.id || '', 80),
          profile_id: normalizeToken(row && row.profile_id || '', 160),
          lane: normalizeToken(row && row.lane || '', 80),
          required: row && row.required !== false
        }))
        .filter((row: AnyObj) => row.id && row.profile_id && row.lane),
      storm_human_lane: {
        enabled: stormLane.enabled !== false,
        queue_name: normalizeToken(stormLane.queue_name || base.profile_pack.storm_human_lane.queue_name, 120)
          || base.profile_pack.storm_human_lane.queue_name
      }
    },
    state: {
      state_path: resolvePath(state.state_path || base.state.state_path, base.state.state_path),
      campaigns_dir: resolvePath(state.campaigns_dir || base.state.campaigns_dir, base.state.campaigns_dir),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      weaver_hints_path: resolvePath(state.weaver_hints_path || base.state.weaver_hints_path, base.state.weaver_hints_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function defaultState() {
  return {
    schema_id: 'universal_outreach_primitive_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    campaigns: {},
    metrics: {
      campaigns_planned: 0,
      campaigns_run: 0
    }
  };
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') return defaultState();
  const metricsRaw = src.metrics && typeof src.metrics === 'object' ? src.metrics : {};
  return {
    schema_id: 'universal_outreach_primitive_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60) || nowIso(),
    campaigns: src.campaigns && typeof src.campaigns === 'object' ? src.campaigns : {},
    metrics: {
      campaigns_planned: clampInt(metricsRaw.campaigns_planned, 0, 1_000_000_000, 0),
      campaigns_run: clampInt(metricsRaw.campaigns_run, 0, 1_000_000_000, 0)
    }
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'universal_outreach_primitive_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    campaigns: state.campaigns && typeof state.campaigns === 'object' ? state.campaigns : {},
    metrics: state.metrics && typeof state.metrics === 'object' ? state.metrics : defaultState().metrics
  });
}

function persistLatest(policy: AnyObj, row: AnyObj) {
  writeJsonAtomic(policy.state.latest_path, row);
  appendJsonl(policy.state.receipts_path, row);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/universal_outreach_primitive.js plan --campaign-id=<id> --leads-json=<json|@file> [--offer-json=<json|@file>] [--region=<id>] [--channel=<id>] [--risk-tier=<low|medium|high>] [--estimated-cost-usd=<n>] [--liability-score=<0..1>] [--apply=0|1]');
  console.log('  node systems/workflow/universal_outreach_primitive.js run --campaign-id=<id> [--veto=1] [--veto-note=\"...\"] [--force=1] [--approval-note=\"...\"] [--apply=0|1]');
  console.log('  node systems/workflow/universal_outreach_primitive.js status [--campaign-id=<id>]');
}

function tierRank(v: unknown) {
  const tier = normalizeToken(v, 40);
  if (tier === 'high') return 3;
  if (tier === 'medium') return 2;
  if (tier === 'low') return 1;
  return 0;
}

function inferRiskProfile(policy: AnyObj, args: AnyObj, leadsSelected: number, burnProjection: AnyObj) {
  const cfg = policy.autonomous_execution && typeof policy.autonomous_execution === 'object'
    ? policy.autonomous_execution
    : defaultPolicy().autonomous_execution;
  const override = normalizeToken(args['risk-tier'] || args.risk_tier || args.risk || '', 40);
  const workflowClass = normalizeToken(
    args['workflow-class'] || args.workflow_class || cfg.workflow_class_default || 'revenue_outreach',
    80
  ) || 'revenue_outreach';
  const estimatedCostUsd = clampNumber(
    args['estimated-cost-usd'] || args.estimated_cost_usd,
    0,
    1_000_000_000,
    Number(leadsSelected || 0) * Number(cfg.default_cost_per_lead_usd || 0)
  );
  const liabilityScore = clampNumber(
    args['liability-score'] || args.liability_score,
    0,
    1,
    cfg.default_liability_score
  );
  const reasonCodes: string[] = [];

  let riskTier = ['low', 'medium', 'high'].includes(override) ? override : '';
  if (!riskTier) {
    if (
      estimatedCostUsd <= Number(cfg.threshold_usd && cfg.threshold_usd.low || 100)
      && liabilityScore <= Number(cfg.liability_threshold && cfg.liability_threshold.low || 0.2)
    ) riskTier = 'low';
    else if (
      estimatedCostUsd <= Number(cfg.threshold_usd && cfg.threshold_usd.medium || 1000)
      && liabilityScore <= Number(cfg.liability_threshold && cfg.liability_threshold.medium || 0.55)
    ) riskTier = 'medium';
    else riskTier = 'high';
  }

  if (workflowClass === 'revenue_outreach' && tierRank(riskTier) > tierRank('medium') && !override) {
    riskTier = 'medium';
    reasonCodes.push('revenue_default_low_medium');
  }
  if (workflowClass === 'revenue_outreach' && !reasonCodes.includes('revenue_default_low_medium')) {
    reasonCodes.push('revenue_default_low_medium');
  }

  const pressure = normalizeToken(burnProjection && burnProjection.pressure || 'none', 40);
  if (pressure === 'critical' && tierRank(riskTier) < tierRank('high')) {
    riskTier = 'high';
    reasonCodes.push('burn_pressure_promoted_to_high');
  } else if (
    pressure === 'high'
    && riskTier === 'low'
    && estimatedCostUsd > Number(cfg.low_to_medium_promote_usd || 50)
  ) {
    riskTier = 'medium';
    reasonCodes.push('burn_pressure_promoted_to_medium');
  }

  return {
    workflow_class: workflowClass,
    risk_tier: riskTier,
    estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)),
    liability_score: Number(liabilityScore.toFixed(6)),
    reason_codes: reasonCodes
  };
}

function buildExecutionContract(policy: AnyObj, riskProfile: AnyObj, startTs: string) {
  const cfg = policy.autonomous_execution && typeof policy.autonomous_execution === 'object'
    ? policy.autonomous_execution
    : defaultPolicy().autonomous_execution;
  const startMs = Date.parse(String(startTs || nowIso()));
  const vetoWindowMinutes = clampInt(cfg.medium_veto_window_minutes, 0, 24 * 60, 10);
  if (riskProfile.risk_tier === 'low') {
    return {
      risk_tier: 'low',
      execution_mode: 'execute_and_report',
      operator_prompt_required: false,
      auto_execute_at: nowIso(),
      veto_window_minutes: 0,
      veto_deadline_at: null
    };
  }
  if (riskProfile.risk_tier === 'medium') {
    const executeAtMs = Number.isFinite(startMs)
      ? startMs + (vetoWindowMinutes * 60 * 1000)
      : Date.now() + (vetoWindowMinutes * 60 * 1000);
    return {
      risk_tier: 'medium',
      execution_mode: 'shadow_then_auto_execute_unless_vetoed',
      operator_prompt_required: false,
      auto_execute_at: new Date(executeAtMs).toISOString(),
      veto_window_minutes: vetoWindowMinutes,
      veto_deadline_at: new Date(executeAtMs).toISOString()
    };
  }
  return {
    risk_tier: 'high',
    execution_mode: 'explicit_approval_required',
    operator_prompt_required: true,
    auto_execute_at: null,
    veto_window_minutes: 0,
    veto_deadline_at: null
  };
}

function resolveConversationContract(policy: AnyObj, riskProfile: AnyObj, args: AnyObj, startTs: string) {
  const fallbackExecution = buildExecutionContract(policy, riskProfile, startTs);
  const fallbackApproval = evaluateApprovalContract(policy, riskProfile.risk_tier, args);
  const payload = runNodeJson(ZERO_PERMISSION_LAYER_SCRIPT, [
    'decide',
    `--action-id=${normalizeToken(args['campaign-id'] || args.campaign_id || 'outreach_campaign', 160) || 'outreach_campaign'}`,
    `--risk-tier=${normalizeToken(riskProfile.risk_tier || 'medium', 20) || 'medium'}`,
    `--estimated-cost-usd=${Number(riskProfile.estimated_cost_usd || 0).toFixed(6)}`,
    `--liability-score=${Number(riskProfile.liability_score || 0).toFixed(6)}`,
    `--approval-note=${cleanText(args['approval-note'] || args.approval_note || '', 800)}`,
    `--apply=${toBool(args.apply, false) ? '1' : '0'}`
  ], {}, 5000).payload;
  if (!payload || typeof payload !== 'object' || payload.ok !== true) {
    return {
      execution: fallbackExecution,
      approval: fallbackApproval,
      source: 'fallback_internal'
    };
  }
  const execution = {
    risk_tier: normalizeToken(payload.risk_tier || fallbackExecution.risk_tier, 20) || fallbackExecution.risk_tier,
    execution_mode: cleanText(payload.execution_mode || fallbackExecution.execution_mode, 120) || fallbackExecution.execution_mode,
    operator_prompt_required: payload.operator_prompt_required === true,
    auto_execute_at: payload.execute_now === true ? nowIso() : fallbackExecution.auto_execute_at,
    veto_window_minutes: clampInt(
      payload.veto_deadline_at ? policy.autonomous_execution.medium_veto_window_minutes : fallbackExecution.veto_window_minutes,
      0,
      24 * 60,
      fallbackExecution.veto_window_minutes
    ),
    veto_deadline_at: cleanText(payload.veto_deadline_at || fallbackExecution.veto_deadline_at || '', 60) || fallbackExecution.veto_deadline_at || null
  };
  const approval = {
    apply_requested: payload.apply_requested === true,
    apply_allowed: payload.approval_satisfied !== false || execution.risk_tier !== 'high',
    explicit_approval_satisfied: payload.approval_satisfied !== false,
    approval_note: cleanText(args['approval-note'] || args.approval_note || '', 800) || null,
    reason_codes: Array.isArray(payload.reason_codes)
      ? payload.reason_codes.map((row: unknown) => cleanText(row, 120)).filter(Boolean)
      : []
  };
  return {
    execution,
    approval,
    source: 'zero_permission_layer'
  };
}

function readBurnProjection(policy: AnyObj) {
  const burn = readJson(policy.dependencies.burn_oracle_latest_path, null);
  const projection = burn && burn.projection && typeof burn.projection === 'object' ? burn.projection : {};
  const pressure = normalizeToken(projection.pressure || 'none', 40) || 'none';
  const runwayDays = Number.isFinite(Number(projection.projected_runway_days)) ? Number(projection.projected_runway_days) : null;
  return {
    pressure,
    projected_runway_days: runwayDays,
    source_path: rel(policy.dependencies.burn_oracle_latest_path)
  };
}

function computeBatchCap(policy: AnyObj, burnProjection: AnyObj) {
  const pressure = normalizeToken(burnProjection.pressure || 'none', 40);
  if (pressure === 'critical') return Math.min(Number(policy.max_leads_per_batch || 25), Number(policy.critical_burn_batch_cap || 2));
  if (pressure === 'high') return Math.min(Number(policy.max_leads_per_batch || 25), Number(policy.high_burn_batch_cap || 5));
  return Number(policy.max_leads_per_batch || 25);
}

function evaluateApprovalContract(policy: AnyObj, riskTier: string, args: AnyObj) {
  const cfg = policy.autonomous_execution && typeof policy.autonomous_execution === 'object'
    ? policy.autonomous_execution
    : defaultPolicy().autonomous_execution;
  const approvalNote = cleanText(args['approval-note'] || args.approval_note || '', 800);
  const applyRequested = toBool(args.apply, false);
  const reasonCodes: string[] = [];
  let applyAllowed = true;
  let explicitApprovalSatisfied = true;
  if (riskTier === 'high') {
    applyAllowed = applyRequested && policy.shadow_only !== true;
    explicitApprovalSatisfied = applyRequested
      && approvalNote.length >= Number(cfg.high_risk_min_approval_note_chars || 12);
    if (policy.shadow_only === true) reasonCodes.push('shadow_only_mode');
    if (!applyRequested) reasonCodes.push('high_risk_apply_required');
    if (approvalNote.length < Number(cfg.high_risk_min_approval_note_chars || 12)) {
      reasonCodes.push('high_risk_approval_note_required');
    }
  } else if (policy.shadow_only === true) {
    reasonCodes.push('autonomous_tier_override_shadow');
  }
  return {
    apply_requested: applyRequested,
    apply_allowed: applyAllowed,
    explicit_approval_satisfied: explicitApprovalSatisfied,
    approval_note: approvalNote || null,
    reason_codes: reasonCodes
  };
}

function scoreLead(raw: AnyObj) {
  const row = raw && typeof raw === 'object' ? raw : {};
  let score = 0;
  if (cleanText(row.business_name || row.company || '', 120)) score += 0.27;
  if (cleanText(row.email || '', 180)) score += 0.25;
  if (cleanText(row.website || '', 220)) score += 0.18;
  if (cleanText(row.category || row.industry || '', 120)) score += 0.15;
  if (cleanText(row.city || row.location || '', 120)) score += 0.15;
  return Number(clampNumber(score, 0, 1, 0).toFixed(6));
}

function normalizeLead(raw: AnyObj, idx: number, policy: AnyObj) {
  const row = raw && typeof raw === 'object' ? raw : {};
  const leadId = normalizeToken(
    row.lead_id || row.id || `${cleanText(row.business_name || row.company || `lead_${idx + 1}`, 120)}_${idx + 1}`,
    160
  ) || `lead_${idx + 1}`;
  const score = scoreLead(row);
  return {
    lead_id: leadId,
    business_name: cleanText(row.business_name || row.company || '', 160) || `Lead ${idx + 1}`,
    email: cleanText(row.email || '', 220) || null,
    website: cleanText(row.website || '', 260) || null,
    category: cleanText(row.category || row.industry || '', 120) || null,
    city: cleanText(row.city || row.location || '', 120) || null,
    channel: normalizeToken(row.channel || policy.default_channel, 40) || policy.default_channel,
    region: normalizeToken(row.region || policy.default_region, 40) || policy.default_region,
    personalization_score: score
  };
}

function buildMicroTasks(policy: AnyObj, campaignId: string, lead: AnyObj, sessionHint: AnyObj) {
  const actions = Array.isArray(policy.profile_pack.actions) ? policy.profile_pack.actions : [];
  return actions.map((action: AnyObj) => ({
    task_id: `mt_${normalizeToken(`${campaignId}_${lead.lead_id}_${action.id}`, 200)}`,
    campaign_id: campaignId,
    lead_id: lead.lead_id,
    action_id: action.id,
    lane: action.lane,
    profile_id: action.profile_id,
    required: action.required === true,
    route: {
      weaver_lane: 'parallel_micro_agents',
      storm_human_lane: policy.profile_pack.storm_human_lane && policy.profile_pack.storm_human_lane.enabled === true
        ? policy.profile_pack.storm_human_lane.queue_name
        : null
    },
    session_hint: sessionHint
  }));
}

function evaluateGovernanceGates(policy: AnyObj, riskTier: string, requireSoul: boolean) {
  const gates: AnyObj = {};
  gates.eye = runNodeJson(EYE_KERNEL_SCRIPT, [
    'route',
    '--lane=organ',
    '--target=workflow',
    '--action=universal_outreach_campaign',
    `--risk=${normalizeToken(riskTier || 'medium', 20) || 'medium'}`,
    '--clearance=L2',
    '--apply=0'
  ]);
  gates.constitution = runNodeJson(CONSTITUTION_GUARD_SCRIPT, ['status']);
  gates.weaver = runNodeJson(WEAVER_CORE_SCRIPT, ['status', 'latest']);
  gates.soul = requireSoul ? runNodeJson(SOUL_GUARD_SCRIPT, ['verify', '--strict=1']) : { ok: true, skipped: true, timed_out: false };

  const reasonCodes: string[] = []
    .concat(gates.eye.timed_out ? ['eye_probe_timeout'] : [])
    .concat(gates.weaver.timed_out ? ['weaver_probe_timeout'] : [])
    .concat(gates.constitution.timed_out ? ['constitution_probe_timeout'] : [])
    .concat(gates.soul.timed_out ? ['soul_probe_timeout'] : []);
  const hardFailures: string[] = []
    .concat(gates.eye.ok ? [] : (gates.eye.timed_out ? [] : ['eye_gate_failed']))
    .concat(gates.weaver.ok ? [] : (gates.weaver.timed_out ? [] : ['weaver_gate_failed']))
    .concat(gates.constitution.ok ? [] : (gates.constitution.timed_out ? [] : ['constitution_gate_failed']))
    .concat(gates.soul.ok ? [] : (gates.soul.timed_out ? [] : ['soul_gate_failed']));
  const timeoutFailures = reasonCodes.filter((row) => row.endsWith('_timeout'));
  const highRisk = normalizeToken(riskTier || '', 20) === 'high';
  const allowLowMediumTimeout = policy.autonomous_execution
    && policy.autonomous_execution.allow_gate_timeout_low_medium !== false;
  const timeoutBlocks = timeoutFailures.length > 0
    && (highRisk || allowLowMediumTimeout !== true);
  const constitutionHardFail = hardFailures.includes('constitution_gate_failed');
  const strictHardFail = highRisk
    ? hardFailures.length > 0
    : constitutionHardFail;
  const ok = !strictHardFail && !timeoutBlocks;
  if (!ok) reasonCodes.push('governance_gate_failed');
  if (timeoutBlocks) reasonCodes.push('governance_timeout_block');

  return {
    ok,
    mode: riskTier === 'high' ? 'enforced_high_risk' : 'enforced_autonomous',
    gates: {
      eye: gates.eye.ok,
      weaver: gates.weaver.ok,
      constitution: gates.constitution.ok,
      soul: gates.soul.ok
    },
    require_soul: requireSoul === true,
    reason_codes: reasonCodes,
    hard_failures: hardFailures
  };
}

function acquireDisposableSession(
  policy: AnyObj,
  campaignId: string,
  leadId: string,
  riskTier: string,
  estimatedCostUsd: number,
  liabilityScore: number
) {
  const args = [
    'acquire-session',
    `--task-id=${normalizeToken(`${campaignId}_${leadId}`, 180)}`,
    `--risk-class=${normalizeToken(riskTier || 'medium', 20) || 'medium'}`,
    `--estimated-cost-usd=${Number(estimatedCostUsd || 0).toFixed(4)}`,
    `--liability-score=${Number(liabilityScore || 0).toFixed(4)}`,
    '--apply=0',
    `--policy=${policy.dependencies.disposable_infra_policy_path}`
  ];
  const proc = runNodeJson(DISPOSABLE_INFRA_SCRIPT, args);
  if (!proc.ok || !proc.payload || proc.payload.ok !== true) {
    return {
      ok: false,
      reason: proc.payload && proc.payload.error ? String(proc.payload.error) : 'session_unavailable'
    };
  }
  return {
    ok: true,
    session_id: cleanText(proc.payload.session && proc.payload.session.session_id || '', 160) || null,
    account_id: cleanText(proc.payload.session && proc.payload.session.account_id || '', 160) || null,
    proxy_id: cleanText(proc.payload.session && proc.payload.session.proxy_id || '', 160) || null
  };
}

function cmdPlan(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const campaignId = normalizeToken(args['campaign-id'] || args.campaign_id || '', 160);
  if (!campaignId) return { ok: false, type: 'universal_outreach_plan', ts: nowIso(), error: 'campaign_id_required' };

  const leadsRaw = parseJsonArg(args['leads-json'] || args.leads_json || '', null);
  if (!Array.isArray(leadsRaw)) {
    return { ok: false, type: 'universal_outreach_plan', ts: nowIso(), error: 'leads_json_array_required' };
  }
  const offer = parseJsonArg(args['offer-json'] || args.offer_json || '', {});

  const burnProjection = readBurnProjection(policy);
  const cap = computeBatchCap(policy, burnProjection);
  const normalizedLeads = leadsRaw.map((row: AnyObj, idx: number) => normalizeLead(row, idx, policy));
  const eligibleLeads = normalizedLeads
    .filter((row: AnyObj) => Number(row.personalization_score || 0) >= Number(policy.min_personalization_score || 0))
    .slice(0, cap);

  const riskProfile = inferRiskProfile(policy, args, eligibleLeads.length, burnProjection);
  const conversationContract = resolveConversationContract(policy, riskProfile, args, nowIso());
  const approvalContract = conversationContract.approval;
  const contractRiskTier = normalizeToken(
    conversationContract.execution && conversationContract.execution.risk_tier || riskProfile.risk_tier,
    20
  ) || riskProfile.risk_tier;
  riskProfile.risk_tier = contractRiskTier;
  const governance = evaluateGovernanceGates(policy, riskProfile.risk_tier, riskProfile.risk_tier === 'high');
  if (!governance.ok) {
    return {
      ok: false,
      type: 'universal_outreach_plan',
      ts: nowIso(),
      error: 'governance_gate_failed',
      governance,
      risk_tier: riskProfile.risk_tier,
      reason_codes: []
        .concat(riskProfile.reason_codes || [])
        .concat(approvalContract.reason_codes || [])
        .concat(governance.reason_codes || [])
    };
  }
  const executionContract = conversationContract.execution;

  const reasonCodes = []
    .concat(riskProfile.reason_codes || [])
    .concat(burnProjection.pressure && burnProjection.pressure !== 'none' ? [`burn_pressure_${burnProjection.pressure}`] : [])
    .concat(eligibleLeads.length < normalizedLeads.length ? ['personalization_filtered'] : [])
    .concat(approvalContract.reason_codes || [])
    .concat(governance.reason_codes || []);

  const leadPlans = eligibleLeads.map((lead: AnyObj) => {
    const session = acquireDisposableSession(
      policy,
      campaignId,
      lead.lead_id,
      riskProfile.risk_tier,
      riskProfile.estimated_cost_usd / Math.max(1, eligibleLeads.length),
      riskProfile.liability_score
    );
    return {
      lead,
      session,
      tasks: buildMicroTasks(policy, campaignId, lead, session.ok ? session : null)
    };
  });
  const microTasks = leadPlans.flatMap((row: AnyObj) => row.tasks || []);

  const campaign = {
    campaign_id: campaignId,
    created_at: nowIso(),
    updated_at: nowIso(),
    stage: executionContract.risk_tier === 'low'
      ? 'planned_autonomous_low'
      : executionContract.risk_tier === 'medium'
        ? 'planned_shadow_medium'
        : 'planned_high_risk_pending_approval',
    channel: normalizeToken(args.channel || policy.default_channel, 40) || policy.default_channel,
    region: normalizeToken(args.region || policy.default_region, 40) || policy.default_region,
    offer: offer && typeof offer === 'object' ? offer : {},
    burn_projection: burnProjection,
    risk_profile: riskProfile,
    execution_contract: executionContract,
    batch_cap: cap,
    leads_total: normalizedLeads.length,
    leads_selected: eligibleLeads.length,
    reason_codes: reasonCodes,
    lead_plans: leadPlans,
    micro_tasks: microTasks,
    governance
  };

  ensureDir(policy.state.campaigns_dir);
  const campaignPath = path.join(policy.state.campaigns_dir, `${campaignId}.json`);
  writeJsonAtomic(campaignPath, campaign);
  state.campaigns[campaignId] = {
    campaign_id: campaignId,
    stage: campaign.stage,
    updated_at: nowIso(),
    leads_selected: eligibleLeads.length,
    micro_tasks: microTasks.length
  };
  state.metrics.campaigns_planned = clampInt(Number(state.metrics.campaigns_planned || 0) + 1, 0, 1_000_000_000, 0);
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'universal_outreach_plan',
    ts: nowIso(),
    ...approvalContract,
    campaign_id: campaignId,
    stage: campaign.stage,
    leads_total: campaign.leads_total,
    leads_selected: campaign.leads_selected,
    micro_tasks: microTasks.length,
    risk_tier: riskProfile.risk_tier,
    estimated_cost_usd: riskProfile.estimated_cost_usd,
    liability_score: riskProfile.liability_score,
    execution_mode: executionContract.execution_mode,
    veto_deadline_at: executionContract.veto_deadline_at,
    operator_prompt_required: executionContract.operator_prompt_required === true,
    conversation_contract_source: conversationContract.source,
    reason_codes: reasonCodes,
    projected_runway_days: burnProjection.projected_runway_days,
    pressure: burnProjection.pressure,
    governance,
    paths: {
      campaign_path: rel(campaignPath),
      state_path: rel(policy.state.state_path),
      latest_path: rel(policy.state.latest_path)
    }
  };
  persistLatest(policy, out);
  appendJsonl(policy.state.weaver_hints_path, {
    ts: nowIso(),
    type: 'universal_outreach_hint',
    campaign_id: campaignId,
    leads_selected: campaign.leads_selected,
    micro_tasks: microTasks.length,
    burn_projection: burnProjection,
    route: {
      lane: 'parallel_micro_agents',
      storm_human_lane: policy.profile_pack.storm_human_lane && policy.profile_pack.storm_human_lane.enabled === true
        ? policy.profile_pack.storm_human_lane.queue_name
        : null
    }
  });
  return out;
}

function cmdRun(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const campaignId = normalizeToken(args['campaign-id'] || args.campaign_id || '', 160);
  if (!campaignId) return { ok: false, type: 'universal_outreach_run', ts: nowIso(), error: 'campaign_id_required' };
  const campaignPath = path.join(policy.state.campaigns_dir, `${campaignId}.json`);
  const campaign = readJson(campaignPath, null);
  if (!campaign || typeof campaign !== 'object') {
    return { ok: false, type: 'universal_outreach_run', ts: nowIso(), error: 'campaign_not_found' };
  }
  const riskProfile = campaign.risk_profile && typeof campaign.risk_profile === 'object'
    ? campaign.risk_profile
    : inferRiskProfile(
      policy,
      args,
      clampInt(campaign.leads_selected, 0, 1_000_000, 0),
      campaign.burn_projection && typeof campaign.burn_projection === 'object' ? campaign.burn_projection : readBurnProjection(policy)
    );
  const conversationContract = resolveConversationContract(policy, riskProfile, args, nowIso());
  const executionContract = campaign.execution_contract && typeof campaign.execution_contract === 'object'
    ? campaign.execution_contract
    : conversationContract.execution;
  const approvalContract = conversationContract.approval;
  riskProfile.risk_tier = normalizeToken(
    executionContract && executionContract.risk_tier || riskProfile.risk_tier,
    20
  ) || riskProfile.risk_tier;
  const governance = evaluateGovernanceGates(policy, riskProfile.risk_tier, riskProfile.risk_tier === 'high');
  const reasonCodes = []
    .concat(approvalContract.reason_codes || [])
    .concat(governance.reason_codes || []);
  if (!governance.ok) {
    return {
      ok: false,
      type: 'universal_outreach_run',
      ts: nowIso(),
      error: 'governance_gate_failed',
      risk_tier: riskProfile.risk_tier,
      governance,
      reason_codes: reasonCodes
    };
  }

  const vetoRequested = toBool(args.veto, false);
  const vetoNote = cleanText(args['veto-note'] || args.veto_note || '', 600);
  if (vetoRequested && riskProfile.risk_tier === 'medium') {
    campaign.updated_at = nowIso();
    campaign.stage = 'vetoed_medium';
    campaign.execution = {
      ts: nowIso(),
      risk_tier: riskProfile.risk_tier,
      vetoed: true,
      veto_note: vetoNote || null,
      governance
    };
    writeJsonAtomic(campaignPath, campaign);
    state.campaigns[campaignId] = {
      campaign_id: campaignId,
      stage: campaign.stage,
      updated_at: nowIso(),
      leads_selected: clampInt(campaign.leads_selected, 0, 1_000_000, 0),
      micro_tasks: Array.isArray(campaign.micro_tasks) ? campaign.micro_tasks.length : 0
    };
    saveState(policy, state);
    const vetoOut = {
      ok: true,
      type: 'universal_outreach_run',
      ts: nowIso(),
      ...approvalContract,
      campaign_id: campaignId,
      stage: campaign.stage,
      leads_executed: 0,
      deliverability_average: 0,
      governance,
      risk_tier: riskProfile.risk_tier,
      execution_mode: executionContract.execution_mode,
      operator_prompt_required: false,
      reason_codes: reasonCodes.concat('operator_vetoed_medium')
    };
    persistLatest(policy, vetoOut);
    return vetoOut;
  }

  const autoExecuteAtMs = Date.parse(String(executionContract.auto_execute_at || executionContract.veto_deadline_at || ''));
  const forceRun = toBool(args.force, false) || toBool(args['force-auto'], false);
  const highRiskReady = approvalContract.explicit_approval_satisfied === true
    && governance.gates
    && governance.gates.soul === true;
  const shouldExecute = riskProfile.risk_tier === 'low'
    ? true
    : riskProfile.risk_tier === 'medium'
      ? (
        forceRun
        || !Number.isFinite(autoExecuteAtMs)
        || Date.now() >= Number(autoExecuteAtMs)
      )
      : highRiskReady;

  if (!shouldExecute) {
    if (riskProfile.risk_tier === 'medium') {
      const pendingOut = {
        ok: true,
        type: 'universal_outreach_run',
        ts: nowIso(),
        ...approvalContract,
        campaign_id: campaignId,
        stage: 'pending_veto_window',
        leads_executed: 0,
        deliverability_average: 0,
        governance,
        risk_tier: riskProfile.risk_tier,
        execution_mode: executionContract.execution_mode,
        operator_prompt_required: false,
        veto_deadline_at: executionContract.veto_deadline_at,
        reason_codes: reasonCodes.concat('waiting_veto_window')
      };
      persistLatest(policy, pendingOut);
      return pendingOut;
    }
    return {
      ok: false,
      type: 'universal_outreach_run',
      ts: nowIso(),
      error: 'high_risk_approval_required',
      campaign_id: campaignId,
      risk_tier: riskProfile.risk_tier,
      governance,
      reason_codes: reasonCodes.concat('high_risk_approval_required')
    };
  }

  const leadPlans = Array.isArray(campaign.lead_plans) ? campaign.lead_plans : [];
  const results = leadPlans.map((row: AnyObj) => {
    const lead = row.lead && typeof row.lead === 'object' ? row.lead : {};
    const session = row.session && typeof row.session === 'object' ? row.session : {};
    const personalization = clampNumber(lead.personalization_score, 0, 1, 0);
    const sessionConfidence = session && session.ok === true ? 0.75 : 0.35;
    const deliverability = Number(clampNumber((personalization * 0.6) + (sessionConfidence * 0.4), 0, 1, 0).toFixed(6));
    return {
      lead_id: cleanText(lead.lead_id || '', 160) || null,
      stage: riskProfile.risk_tier === 'low'
        ? 'executed_autonomous'
        : riskProfile.risk_tier === 'medium'
          ? 'executed_after_veto_window'
          : 'executed_high_risk_approved',
      deliverability_score: deliverability,
      session_id: cleanText(session.session_id || '', 160) || null,
      action_summary: {
        site_build: true,
        site_deploy: true,
        draft: true,
        send: true,
        followup_scheduled: true
      }
    };
  });

  const deliverabilityAvg = results.length
    ? Number((results.reduce((acc: number, row: AnyObj) => acc + Number(row.deliverability_score || 0), 0) / results.length).toFixed(6))
    : 0;

  campaign.updated_at = nowIso();
  campaign.stage = riskProfile.risk_tier === 'low'
    ? 'executed_autonomous_low'
    : riskProfile.risk_tier === 'medium'
      ? 'executed_autonomous_medium'
      : 'executed_high_risk_approved';
  campaign.execution = {
    ts: nowIso(),
    ...approvalContract,
    risk_tier: riskProfile.risk_tier,
    execution_mode: executionContract.execution_mode,
    governance,
    deliverability_average: deliverabilityAvg,
    results
  };
  writeJsonAtomic(campaignPath, campaign);

  state.campaigns[campaignId] = {
    campaign_id: campaignId,
    stage: campaign.stage,
    updated_at: nowIso(),
    leads_selected: clampInt(campaign.leads_selected, 0, 1_000_000, 0),
    micro_tasks: Array.isArray(campaign.micro_tasks) ? campaign.micro_tasks.length : 0
  };
  state.metrics.campaigns_run = clampInt(Number(state.metrics.campaigns_run || 0) + 1, 0, 1_000_000_000, 0);
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'universal_outreach_run',
    ts: nowIso(),
    ...approvalContract,
    campaign_id: campaignId,
    stage: campaign.stage,
    leads_executed: results.length,
    deliverability_average: deliverabilityAvg,
    governance,
    risk_tier: riskProfile.risk_tier,
    execution_mode: executionContract.execution_mode,
    operator_prompt_required: executionContract.operator_prompt_required === true,
    conversation_contract_source: conversationContract.source,
    reason_codes: reasonCodes,
    paths: {
      campaign_path: rel(campaignPath),
      state_path: rel(policy.state.state_path),
      latest_path: rel(policy.state.latest_path)
    }
  };
  persistLatest(policy, out);
  return out;
}

function cmdStatus(policy: AnyObj, args: AnyObj) {
  const state = loadState(policy);
  const latest = readJson(policy.state.latest_path, null);
  const campaignId = normalizeToken(args['campaign-id'] || args.campaign_id || '', 160);
  const campaignPath = campaignId ? path.join(policy.state.campaigns_dir, `${campaignId}.json`) : '';
  const campaign = campaignPath ? readJson(campaignPath, null) : null;
  return {
    ok: true,
    type: 'universal_outreach_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      enabled: policy.enabled === true,
      shadow_only: policy.shadow_only === true
    },
    metrics: state.metrics,
    campaign_id: campaignId || null,
    campaign: campaign && typeof campaign === 'object'
      ? {
        stage: cleanText(campaign.stage || '', 80) || null,
        leads_selected: clampInt(campaign.leads_selected, 0, 1_000_000, 0),
        risk_tier: cleanText(campaign.risk_profile && campaign.risk_profile.risk_tier || '', 32) || null,
        execution_mode: cleanText(campaign.execution_contract && campaign.execution_contract.execution_mode || '', 120) || null,
        updated_at: cleanText(campaign.updated_at || '', 60) || null
      }
      : null,
    latest: latest && typeof latest === 'object'
      ? {
        type: cleanText(latest.type || '', 120) || null,
        ts: cleanText(latest.ts || '', 60) || null
      }
      : null,
    paths: {
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.state.state_path),
      campaigns_dir: rel(policy.state.campaigns_dir),
      latest_path: rel(policy.state.latest_path),
      receipts_path: rel(policy.state.receipts_path)
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  let out: AnyObj;
  if (!policy.enabled) {
    out = {
      ok: false,
      type: 'universal_outreach_primitive',
      ts: nowIso(),
      error: 'policy_disabled'
    };
  } else if (cmd === 'plan') {
    out = cmdPlan(policy, args);
  } else if (cmd === 'run') {
    out = cmdRun(policy, args);
  } else if (cmd === 'status') {
    out = cmdStatus(policy, args);
  } else if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
    return;
  } else {
    out = {
      ok: false,
      type: 'universal_outreach_primitive',
      ts: nowIso(),
      error: `unknown_command:${cmd}`
    };
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdPlan,
  cmdRun,
  cmdStatus
};
