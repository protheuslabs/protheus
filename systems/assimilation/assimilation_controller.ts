#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/assimilation/assimilation_controller.js
 *
 * Shadow-first scaffold for governed tool assimilation:
 * - Unified candidacy ledger for local skills + external adapters.
 * - Usage-triggered thresholds and retry cooldowns.
 * - Legal gate -> research probe -> forge replica -> nursery/adversarial -> doctor graft.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const {
  loadLedger,
  saveLedger,
  recordUsage,
  listReadyCandidates,
  computeThresholdFlags,
  setAttemptOutcome
} = require('./candidacy_ledger');
const { evaluateLegalGate } = require('./legal_gate');
const { runResearchProbe } = require('./research_probe');
const { compileProfileFromResearch } = require('./capability_profile_compiler');
const { buildForgeReplica } = require('./forge_replica');
const { evaluateGraftDecision } = require('./graft_manager');
let recordAttribution = null;
try {
  ({ recordAttribution } = require('../attribution/value_attribution_primitive.js'));
} catch {
  recordAttribution = null;
}
let dualityEvaluate = null;
let registerDualityObservation = null;
try {
  const duality = require('../../lib/duality_seed.js');
  dualityEvaluate = duality.duality_evaluate || duality.evaluateDualitySignal || null;
  registerDualityObservation = duality.registerDualityObservation || null;
} catch {
  dualityEvaluate = null;
  registerDualityObservation = null;
}

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = path.join(ROOT, 'config', 'assimilation_policy.json');
const DEFAULT_STATE_DIR = path.join(ROOT, 'state', 'assimilation');
const DEFAULT_RUNS_DIR = path.join(DEFAULT_STATE_DIR, 'runs');
const DEFAULT_LATEST_PATH = path.join(DEFAULT_STATE_DIR, 'latest.json');
const DEFAULT_LEDGER_PATH = path.join(DEFAULT_STATE_DIR, 'ledger.json');
const DEFAULT_EVENTS_PATH = path.join(DEFAULT_STATE_DIR, 'events.jsonl');
const DEFAULT_OBSIDIAN_PATH = path.join(DEFAULT_STATE_DIR, 'obsidian_projection.jsonl');
const DEFAULT_ROLLBACKS_PATH = path.join(DEFAULT_STATE_DIR, 'rollbacks.jsonl');
const DEFAULT_WEAVER_LATEST_PATH = path.join(ROOT, 'state', 'autonomy', 'weaver', 'latest.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/assimilation_controller.js record-use --capability-id=<id> [--source-type=local_skill|external_adapter|external_tool] [--workflow-id=<id>] [--success=1|0] [--pain-score=0..1] [--cost-score=0..1]');
  console.log('  node systems/assimilation/assimilation_controller.js assess [--capability-id=<id>] [--policy=path]');
  console.log('  node systems/assimilation/assimilation_controller.js run [YYYY-MM-DD] [--policy=path] [--capability-id=<id>] [--max-candidates=N] [--apply=1|0] [--human-approved=1|0]');
  console.log('  node systems/assimilation/assimilation_controller.js rollback --capability-id=<id> [--reason=<txt>]');
  console.log('  node systems/assimilation/assimilation_controller.js status [latest|YYYY-MM-DD]');
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

function nowIso() {
  return new Date().toISOString();
}

function toDate(v: unknown) {
  const raw = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  return nowIso().slice(0, 10);
}

function cleanText(v: unknown, maxLen = 220) {
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

function parseIsoMs(v: unknown) {
  const ms = Date.parse(String(v || ''));
  return Number.isFinite(ms) ? ms : null;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function sha16(seed: string) {
  return crypto.createHash('sha256').update(String(seed || '')).digest('hex').slice(0, 16);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    max_candidates_per_run: 3,
    trigger: {
      min_uses: 12,
      min_workflow_spread: 3,
      min_days_observed: 7,
      min_pain_score: 0.15,
      cooldown_after_failure_hours: 24,
      cooldown_after_rejection_hours: 12
    },
    legal_gate: {
      fail_closed: true,
      require_license_check: true,
      require_tos_check: true,
      require_robots_check: true,
      require_data_rights: true,
      denied_licenses: ['agpl-3.0', 'gpl-3.0'],
      allowed_licenses: [],
      blocked_domains: []
    },
    anti_gaming: {
      hidden_eval_min_cases: 5,
      hidden_eval_max_cases: 13,
      retry_rate_limit_per_capability_per_day: 2
    },
    risk_classes: {
      high_risk: ['payments', 'auth', 'filesystem', 'shell', 'network-control'],
      require_explicit_human_approval: true
    },
    ttl: {
      default_days: 14,
      permanent_promotion_stability_days: 30,
      min_success_receipts_for_permanent: 20
    },
    assimilation_scope: {
      max_assimilation_depth: 2,
      approval_threshold_score: 0.7,
      resource_budget_gate: {
        enabled: true,
        max_load_per_cpu: 12,
        max_rss_mb: 8192,
        require_surface_budget_clear: false
      },
      atrophy: {
        enabled: true,
        dormant_after_days: 30,
        compression: 'zstd'
      }
    },
    research_probe: {
      min_confidence: 0.55
    },
    forge: {
      sandbox_profile: 'strict_isolated',
      max_build_steps: 8
    },
    integration: {
      weaver_latest_path: relPath(DEFAULT_WEAVER_LATEST_PATH),
      research_organ_enabled: true,
      nursery_shadow_only: true,
      adversarial_shadow_only: true,
      doctor_required: true
    },
    outputs: {
      emit_events: true,
      emit_ide_events: true,
      emit_obsidian_projection: true
    }
  };
}

function normalizeList(src: unknown, maxItems = 64, maxLen = 120) {
  if (!Array.isArray(src)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of src) {
    const token = normalizeToken(raw, maxLen);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxItems) break;
  }
  return out;
}

function loadPolicy(policyPath: string) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const trigger = raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : {};
  const antiGaming = raw.anti_gaming && typeof raw.anti_gaming === 'object' ? raw.anti_gaming : {};
  const risk = raw.risk_classes && typeof raw.risk_classes === 'object' ? raw.risk_classes : {};
  const ttl = raw.ttl && typeof raw.ttl === 'object' ? raw.ttl : {};
  const scope = raw.assimilation_scope && typeof raw.assimilation_scope === 'object'
    ? raw.assimilation_scope
    : {};
  const scopeResource = scope.resource_budget_gate && typeof scope.resource_budget_gate === 'object'
    ? scope.resource_budget_gate
    : {};
  const scopeAtrophy = scope.atrophy && typeof scope.atrophy === 'object'
    ? scope.atrophy
    : {};
  const legal = raw.legal_gate && typeof raw.legal_gate === 'object' ? raw.legal_gate : {};
  const researchProbe = raw.research_probe && typeof raw.research_probe === 'object' ? raw.research_probe : {};
  const forge = raw.forge && typeof raw.forge === 'object' ? raw.forge : {};
  const integration = raw.integration && typeof raw.integration === 'object' ? raw.integration : {};
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    ...base,
    version: cleanText(raw.version || base.version, 32) || '1.0',
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    allow_apply: raw.allow_apply === true,
    max_candidates_per_run: clampInt(raw.max_candidates_per_run, 1, 64, base.max_candidates_per_run),
    trigger: {
      ...base.trigger,
      min_uses: clampInt(trigger.min_uses, 1, 1000000, base.trigger.min_uses),
      min_workflow_spread: clampInt(trigger.min_workflow_spread, 1, 1000000, base.trigger.min_workflow_spread),
      min_days_observed: clampNumber(trigger.min_days_observed, 0, 3650, base.trigger.min_days_observed),
      min_pain_score: clampNumber(trigger.min_pain_score, 0, 1, base.trigger.min_pain_score),
      cooldown_after_failure_hours: clampInt(
        trigger.cooldown_after_failure_hours,
        0,
        24 * 365,
        base.trigger.cooldown_after_failure_hours
      ),
      cooldown_after_rejection_hours: clampInt(
        trigger.cooldown_after_rejection_hours,
        0,
        24 * 365,
        base.trigger.cooldown_after_rejection_hours
      )
    },
    legal_gate: {
      ...base.legal_gate,
      fail_closed: legal.fail_closed !== false,
      require_license_check: legal.require_license_check !== false,
      require_tos_check: legal.require_tos_check !== false,
      require_robots_check: legal.require_robots_check !== false,
      require_data_rights: legal.require_data_rights !== false,
      denied_licenses: normalizeList(legal.denied_licenses, 64, 80).length
        ? normalizeList(legal.denied_licenses, 64, 80)
        : base.legal_gate.denied_licenses.slice(0),
      allowed_licenses: normalizeList(legal.allowed_licenses, 64, 80),
      blocked_domains: normalizeList(legal.blocked_domains, 256, 120)
    },
    anti_gaming: {
      ...base.anti_gaming,
      hidden_eval_min_cases: clampInt(
        antiGaming.hidden_eval_min_cases,
        1,
        1000,
        base.anti_gaming.hidden_eval_min_cases
      ),
      hidden_eval_max_cases: clampInt(
        antiGaming.hidden_eval_max_cases,
        1,
        1000,
        base.anti_gaming.hidden_eval_max_cases
      ),
      retry_rate_limit_per_capability_per_day: clampInt(
        antiGaming.retry_rate_limit_per_capability_per_day,
        1,
        1000,
        base.anti_gaming.retry_rate_limit_per_capability_per_day
      )
    },
    risk_classes: {
      ...base.risk_classes,
      high_risk: normalizeList(risk.high_risk, 64, 64).length
        ? normalizeList(risk.high_risk, 64, 64)
        : base.risk_classes.high_risk.slice(0),
      require_explicit_human_approval: risk.require_explicit_human_approval !== false
    },
    ttl: {
      ...base.ttl,
      default_days: clampInt(ttl.default_days, 1, 3650, base.ttl.default_days),
      permanent_promotion_stability_days: clampInt(
        ttl.permanent_promotion_stability_days,
        1,
        3650,
        base.ttl.permanent_promotion_stability_days
      ),
      min_success_receipts_for_permanent: clampInt(
        ttl.min_success_receipts_for_permanent,
        1,
        1000000,
        base.ttl.min_success_receipts_for_permanent
      )
    },
    assimilation_scope: {
      ...base.assimilation_scope,
      max_assimilation_depth: clampInt(
        scope.max_assimilation_depth,
        1,
        16,
        base.assimilation_scope.max_assimilation_depth
      ),
      approval_threshold_score: clampNumber(
        scope.approval_threshold_score,
        0,
        1,
        base.assimilation_scope.approval_threshold_score
      ),
      resource_budget_gate: {
        ...base.assimilation_scope.resource_budget_gate,
        enabled: scopeResource.enabled !== false,
        max_load_per_cpu: clampNumber(
          scopeResource.max_load_per_cpu,
          0.1,
          100,
          base.assimilation_scope.resource_budget_gate.max_load_per_cpu
        ),
        max_rss_mb: clampInt(
          scopeResource.max_rss_mb,
          64,
          262144,
          base.assimilation_scope.resource_budget_gate.max_rss_mb
        ),
        require_surface_budget_clear: scopeResource.require_surface_budget_clear === true
      },
      atrophy: {
        ...base.assimilation_scope.atrophy,
        enabled: scopeAtrophy.enabled !== false,
        dormant_after_days: clampInt(
          scopeAtrophy.dormant_after_days,
          1,
          3650,
          base.assimilation_scope.atrophy.dormant_after_days
        ),
        compression: normalizeToken(
          scopeAtrophy.compression || base.assimilation_scope.atrophy.compression,
          32
        ) || base.assimilation_scope.atrophy.compression
      }
    },
    research_probe: {
      min_confidence: clampNumber(
        researchProbe.min_confidence,
        0,
        1,
        base.research_probe.min_confidence
      )
    },
    forge: {
      sandbox_profile: normalizeToken(
        forge.sandbox_profile || base.forge.sandbox_profile,
        80
      ) || base.forge.sandbox_profile,
      max_build_steps: clampInt(forge.max_build_steps, 3, 64, base.forge.max_build_steps)
    },
    integration: {
      ...base.integration,
      weaver_latest_path: cleanText(integration.weaver_latest_path || base.integration.weaver_latest_path, 300),
      research_organ_enabled: integration.research_organ_enabled !== false,
      nursery_shadow_only: integration.nursery_shadow_only !== false,
      adversarial_shadow_only: integration.adversarial_shadow_only !== false,
      doctor_required: integration.doctor_required !== false
    },
    outputs: {
      emit_events: outputs.emit_events !== false,
      emit_ide_events: outputs.emit_ide_events !== false,
      emit_obsidian_projection: outputs.emit_obsidian_projection !== false
    }
  };
}

function evaluateResourceGate(policy: AnyObj = {}) {
  const scope = policy && policy.assimilation_scope && typeof policy.assimilation_scope === 'object'
    ? policy.assimilation_scope
    : {};
  const gate = scope.resource_budget_gate && typeof scope.resource_budget_gate === 'object'
    ? scope.resource_budget_gate
    : {};
  if (gate.enabled === false) {
    return {
      allowed: true,
      reason_codes: ['resource_budget_gate_disabled'],
      metrics: {}
    };
  }
  const cpus = Math.max(1, os.cpus().length);
  const load1 = Array.isArray(os.loadavg()) ? Number(os.loadavg()[0] || 0) : 0;
  const loadPerCpu = Number((load1 / cpus).toFixed(6));
  const rssMb = Number((process.memoryUsage().rss / (1024 * 1024)).toFixed(3));
  const maxLoadPerCpu = clampNumber(gate.max_load_per_cpu, 0.1, 100, 12);
  const maxRssMb = clampInt(gate.max_rss_mb, 64, 262144, 8192);
  const requireSurfaceBudgetClear = gate.require_surface_budget_clear === true;
  const surfaceBudgetClear = requireSurfaceBudgetClear
    ? toBool(process.env.ASSIMILATION_SURFACE_BUDGET_CLEAR, false)
    : true;
  const reasonCodes: string[] = [];
  let blocked = false;
  if (loadPerCpu > maxLoadPerCpu) {
    blocked = true;
    reasonCodes.push('resource_gate_load_block');
  }
  if (rssMb > maxRssMb) {
    blocked = true;
    reasonCodes.push('resource_gate_rss_block');
  }
  if (!surfaceBudgetClear) {
    blocked = true;
    reasonCodes.push('resource_gate_surface_budget_block');
  }
  if (!blocked) reasonCodes.push('resource_gate_clear');
  return {
    allowed: !blocked,
    reason_codes: reasonCodes,
    metrics: {
      cpus,
      load_1m: load1,
      load_per_cpu: loadPerCpu,
      rss_mb: rssMb,
      max_load_per_cpu: maxLoadPerCpu,
      max_rss_mb: maxRssMb,
      require_surface_budget_clear: requireSurfaceBudgetClear,
      surface_budget_clear: surfaceBudgetClear
    }
  };
}

function runtimePaths(policyPath: string, policy: AnyObj) {
  const stateDir = process.env.ASSIMILATION_STATE_DIR
    ? path.resolve(process.env.ASSIMILATION_STATE_DIR)
    : DEFAULT_STATE_DIR;
  const weaverLatestRaw = cleanText(
    process.env.ASSIMILATION_WEAVER_LATEST_PATH
    || (policy && policy.integration && policy.integration.weaver_latest_path)
    || relPath(DEFAULT_WEAVER_LATEST_PATH),
    400
  );
  const weaverLatestPath = path.isAbsolute(weaverLatestRaw)
    ? weaverLatestRaw
    : path.join(ROOT, weaverLatestRaw);
  return {
    policy_path: policyPath,
    state_dir: stateDir,
    runs_dir: path.join(stateDir, 'runs'),
    latest_path: path.join(stateDir, 'latest.json'),
    ledger_path: path.join(stateDir, 'ledger.json'),
    events_path: path.join(stateDir, 'events.jsonl'),
    obsidian_path: path.join(stateDir, 'obsidian_projection.jsonl'),
    rollbacks_path: path.join(stateDir, 'rollbacks.jsonl'),
    weaver_latest_path: weaverLatestPath
  };
}

function emitEvent(paths: AnyObj, policy: AnyObj, stage: string, payload: AnyObj = {}) {
  if (!(policy && policy.outputs && policy.outputs.emit_events === true)) return;
  appendJsonl(paths.events_path, {
    ts: nowIso(),
    type: 'assimilation_event',
    stage,
    ...payload
  });
}

function emitIdeProjection(paths: AnyObj, policy: AnyObj, payload: AnyObj = {}) {
  if (!(policy && policy.outputs && policy.outputs.emit_ide_events === true)) return;
  emitEvent(paths, policy, 'ide_projection', payload);
}

function emitObsidianProjection(paths: AnyObj, policy: AnyObj, payload: AnyObj = {}) {
  if (!(policy && policy.outputs && policy.outputs.emit_obsidian_projection === true)) return;
  appendJsonl(paths.obsidian_path, {
    ts: nowIso(),
    type: 'assimilation_obsidian_projection',
    ...payload
  });
}

function buildHiddenEvalSuite(runId: string, capabilityId: string, policy: AnyObj = {}) {
  const cfg = policy && policy.anti_gaming && typeof policy.anti_gaming === 'object'
    ? policy.anti_gaming
    : {};
  const minCases = clampInt(cfg.hidden_eval_min_cases, 1, 1000, 5);
  const maxCasesRaw = clampInt(cfg.hidden_eval_max_cases, 1, 1000, 13);
  const maxCases = Math.max(minCases, maxCasesRaw);
  const hash = crypto.createHash('sha256')
    .update(`${runId}|${capabilityId}|${Date.now()}`)
    .digest('hex');
  const span = maxCases - minCases + 1;
  const seed = parseInt(hash.slice(0, 8), 16);
  const caseCount = minCases + (seed % span);
  return {
    suite_hash: hash.slice(0, 16),
    case_count: caseCount
  };
}

function evaluateWeaverGate(paths: AnyObj) {
  const latest = readJson(paths.weaver_latest_path, null);
  if (!latest || typeof latest !== 'object') {
    return {
      available: false,
      decision: 'allow',
      reason_codes: ['weaver_snapshot_missing_allow']
    };
  }
  const vetoBlocked = !!(
    latest.veto_blocked === true
    || (latest.value_context
      && latest.value_context.constitutional_veto
      && latest.value_context.constitutional_veto.blocked === true)
  );
  return {
    available: true,
    decision: vetoBlocked ? 'deny' : 'allow',
    reason_codes: vetoBlocked
      ? ['weaver_constitutional_veto_blocked']
      : ['weaver_clear'],
    primary_metric_id: cleanText(
      latest.value_context && latest.value_context.primary_metric_id || '',
      80
    ) || null,
    value_currency: cleanText(
      latest.value_context && latest.value_context.value_currency || '',
      80
    ) || null
  };
}

function assess(policy: AnyObj, paths: AnyObj, capabilityFilter: string | null, nowTs = nowIso()) {
  const ledger = loadLedger(fs, paths.ledger_path);
  const ready = listReadyCandidates(ledger, policy, nowTs);
  const rows = (capabilityFilter
    ? ready.filter((row: AnyObj) => String(row.capability_id || '') === capabilityFilter)
    : ready
  );
  return {
    ledger,
    ready: rows
  };
}

function commandRecordUse(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.ASSIMILATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const capabilityId = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  if (!capabilityId) throw new Error('capability_id_required');
  const nowTs = nowIso();
  const ledger = loadLedger(fs, paths.ledger_path);
  const record = recordUsage(ledger, {
    capability_id: capabilityId,
    source_type: args['source-type'] || args.source_type,
    workflow_id: args['workflow-id'] || args.workflow_id,
    success: toBool(args.success, true),
    pain_score: args['pain-score'] || args.pain_score,
    cost_score: args['cost-score'] || args.cost_score,
    risk_class: args['risk-class'] || args.risk_class,
    native_equivalent_id: args['native-equivalent-id'] || args.native_equivalent_id,
    license: args.license,
    tos_ok: args['tos-ok'] == null ? null : toBool(args['tos-ok'], true),
    robots_ok: args['robots-ok'] == null ? null : toBool(args['robots-ok'], true),
    data_rights_ok: args['data-rights-ok'] == null ? null : toBool(args['data-rights-ok'], true)
  }, nowTs);
  const threshold = computeThresholdFlags(record, policy, nowTs);
  const outLedger = saveLedger(fs, path, paths.ledger_path, ledger, nowTs);
  emitEvent(paths, policy, 'usage_recorded', {
    capability_id: capabilityId,
    source_type: record.source_type,
    threshold_flags: threshold.flags,
    threshold_metrics: threshold.metrics
  });
  const out = {
    ok: true,
    type: 'assimilation_record_use',
    ts: nowTs,
    capability_id: capabilityId,
    source_type: record.source_type,
    threshold,
    ledger_path: relPath(paths.ledger_path),
    policy: {
      version: policy.version,
      path: relPath(policyPath)
    },
    ledger_updated_at: outLedger.updated_at
  };
  writeJsonAtomic(paths.latest_path, out);
  return out;
}

function commandAssess(args: AnyObj) {
  const policyPath = path.resolve(String(args.policy || process.env.ASSIMILATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const filter = normalizeToken(args['capability-id'] || args.capability_id || '', 160) || null;
  const nowTs = nowIso();
  const out = assess(policy, paths, filter, nowTs);
  return {
    ok: true,
    type: 'assimilation_assess',
    ts: nowTs,
    candidates_ready: out.ready.length,
    candidates: out.ready.slice(0, 64),
    ledger_path: relPath(paths.ledger_path),
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only === true,
      path: relPath(policyPath)
    }
  };
}

function commandRun(args: AnyObj) {
  const date = toDate(args._ && args._[0] ? args._[0] : nowIso().slice(0, 10));
  const policyPath = path.resolve(String(args.policy || process.env.ASSIMILATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const capabilityFilter = normalizeToken(args['capability-id'] || args.capability_id || '', 160) || null;
  const nowTs = nowIso();
  const runId = `asm_${sha16(`${date}|${nowTs}|${Math.random()}`)}`;
  const applyRequested = toBool(args.apply, false);
  const humanApproved = toBool(args['human-approved'] || args.human_approved, false);
  const resourceGate = evaluateResourceGate(policy);

  if (policy.enabled !== true) {
    const payload = {
      ok: true,
      skipped: true,
      reason: 'policy_disabled',
      type: 'assimilation_run',
      date,
      ts: nowTs,
      run_id: runId
    };
    writeJsonAtomic(paths.latest_path, payload);
    return payload;
  }
  if (resourceGate.allowed !== true) {
    const payload = {
      ok: true,
      skipped: true,
      reason: 'resource_budget_gate_blocked',
      type: 'assimilation_run',
      date,
      ts: nowTs,
      run_id: runId,
      resource_gate: resourceGate
    };
    writeJsonAtomic(paths.latest_path, payload);
    emitEvent(paths, policy, 'run_skipped_resource_gate', {
      run_id: runId,
      date,
      reason_codes: resourceGate.reason_codes,
      metrics: resourceGate.metrics
    });
    return payload;
  }

  const { ledger, ready } = assess(policy, paths, capabilityFilter, nowTs);
  const maxCandidates = clampInt(
    args['max-candidates'] || args.max_candidates,
    1,
    64,
    policy.max_candidates_per_run
  );
  const rankedByDuality = ready
    .slice(0)
    .map((row: AnyObj) => {
      const duality = typeof dualityEvaluate === 'function'
        ? dualityEvaluate({
          lane: 'assimilation_candidacy',
          source: 'assimilation_controller',
          run_id: runId,
          capability_id: row && row.capability_id,
          source_type: row && row.source_type,
          risk_class: row && row.risk_class,
          thresholds: row && row.thresholds
        }, {
          lane: 'assimilation_candidacy',
          source: 'assimilation_controller',
          run_id: runId,
          persist: true
        })
        : null;
      const baseline = Number(
        row
        && row.thresholds
        && row.thresholds.metrics
        && row.thresholds.metrics.pain_cost_score
        || 0
      );
      const advisoryDelta = duality && duality.enabled === true
        ? clampNumber(
          Number(duality.score_trit || 0) * Number(duality.effective_weight || 0) * 0.1,
          -0.1,
          0.1,
          0
        )
        : 0;
      return {
        ...row,
        _duality: duality,
        _duality_rank: Number((baseline + advisoryDelta).toFixed(6))
      };
    })
    .sort((a: AnyObj, b: AnyObj) => Number(b._duality_rank || 0) - Number(a._duality_rank || 0));
  const selected = rankedByDuality.slice(0, maxCandidates);
  const weaverGate = evaluateWeaverGate(paths);
  const results: AnyObj[] = [];

  for (const candidate of selected) {
    const capabilityId = String(candidate.capability_id || '');
    const dualitySignal = candidate && candidate._duality && typeof candidate._duality === 'object'
      ? candidate._duality
      : null;
    const record = ledger.capabilities && ledger.capabilities[capabilityId]
      ? ledger.capabilities[capabilityId]
      : null;
    if (!record) continue;
    const improvementMode = !!record.native_equivalent_id;
    const legalGate = evaluateLegalGate({
      capability_id: capabilityId,
      source_type: record.source_type,
      legal: record.legal || {},
      risk_class: record.risk_class || 'general'
    }, policy);
    const research = runResearchProbe({
      capability_id: capabilityId,
      source_type: record.source_type,
      legal: record.legal || {},
      risk_class: record.risk_class || 'general',
      metadata: record.metadata || {}
    }, policy);
    const profileCompile = compileProfileFromResearch({
      capability_id: capabilityId,
      source_type: record.source_type,
      research,
      origin: 'assimilation_controller',
      source_receipt_id: runId,
      high_risk_classes: record.risk_class ? [record.risk_class] : [],
      requires_human_approval: (
        Array.isArray(policy && policy.risk_classes && policy.risk_classes.high_risk)
        && policy.risk_classes.high_risk.includes(String(record.risk_class || ''))
      )
    }, {
      strict: true,
      generated_by: 'assimilation_controller'
    });
    const forge = buildForgeReplica({
      capability_id: capabilityId,
      source: 'assimilation',
      source_type: record.source_type,
      risk_class: record.risk_class || 'general',
      mode: improvementMode ? 'improvement' : 'assimilation',
      now_ts: nowTs
    }, policy);
    const hiddenEval = buildHiddenEvalSuite(runId, capabilityId, policy);

    const profileGatePassed = profileCompile && profileCompile.ok === true;
    const nurseryPassed = legalGate.allowed === true
      && research.fit === 'sufficient'
      && profileGatePassed === true;
    const adversarialPassed = nurseryPassed === true;
    const nursery = {
      mode: policy.integration && policy.integration.nursery_shadow_only !== false ? 'shadow' : 'active',
      passed: nurseryPassed,
      reason_codes: nurseryPassed
        ? ['nursery_shadow_pass']
        : ['nursery_shadow_fail']
            .concat(profileGatePassed ? [] : ['capability_profile_validation_fail'])
    };
    const adversarial = {
      mode: policy.integration && policy.integration.adversarial_shadow_only !== false ? 'shadow' : 'active',
      passed: adversarialPassed,
      reason_codes: adversarialPassed ? ['adversarial_shadow_pass'] : ['adversarial_shadow_fail']
    };
    const constitutionalVeto = {
      blocked: weaverGate.decision === 'deny',
      reason_codes: Array.isArray(weaverGate.reason_codes) ? weaverGate.reason_codes.slice(0, 12) : []
    };
    const graft = evaluateGraftDecision({
      capability_id: capabilityId,
      risk_class: record.risk_class || 'general',
      strand_candidate: forge && forge.strand_candidate ? forge.strand_candidate : null,
      legal_gate: legalGate,
      constitutional_veto: constitutionalVeto,
      research_probe: research,
      nursery,
      adversarial,
      apply_requested: applyRequested,
      human_approved: humanApproved
    }, policy);

    const reasonCodes = []
      .concat(Array.isArray(legalGate.reason_codes) ? legalGate.reason_codes : [])
      .concat(Array.isArray(weaverGate.reason_codes) ? weaverGate.reason_codes : [])
      .concat(Array.isArray(research.reason_codes) ? research.reason_codes : [])
      .concat(Array.isArray(profileCompile && profileCompile.validation && profileCompile.validation.failures)
        ? profileCompile.validation.failures.map((f: string) => `profile:${f}`)
        : [])
      .concat(Array.isArray(nursery.reason_codes) ? nursery.reason_codes : [])
      .concat(Array.isArray(adversarial.reason_codes) ? adversarial.reason_codes : [])
      .concat(Array.isArray(graft.reason_codes) ? graft.reason_codes : []);

    let outcome = 'shadow_only';
    if (graft.apply_executed === true) outcome = 'success';
    else if (graft.blocked === true) outcome = 'reject';
    else if (policy.shadow_only === true || applyRequested !== true) outcome = 'shadow_only';
    else outcome = 'fail';
    setAttemptOutcome(record, outcome, reasonCodes, policy, nowTs);
    if (outcome === 'success') {
      record.status = 'assimilated_ttl';
    } else if (outcome === 'shadow_only') {
      record.status = 'shadow_candidate';
    } else {
      record.status = 'candidate';
    }

    let valueAttribution = null;
    if (typeof recordAttribution === 'function') {
      try {
        const attrOut = recordAttribution({
          source_type: record.source_type || 'external_tool',
          source_id: capabilityId,
          source_url: record.legal && record.legal.source_url ? record.legal.source_url : null,
          creator_id: record.metadata && record.metadata.creator_id ? record.metadata.creator_id : 'unknown_creator',
          creator_alias: record.metadata && record.metadata.creator_alias ? record.metadata.creator_alias : null,
          creator_opt_in: record.metadata && record.metadata.creator_opt_in === true,
          license: record.legal && record.legal.license ? record.legal.license : 'unknown',
          objective_id: `assimilation_${runId}`,
          capability_id: capabilityId,
          task_id: `${runId}_${capabilityId}`,
          run_id: runId,
          lane: 'assimilation',
          weight: Number(candidate && candidate.thresholds && candidate.thresholds.metrics && candidate.thresholds.metrics.pain_cost_score || 1),
          confidence: Number(research && research.confidence || 0.5),
          impact_score: Number(graft && graft.score || 0.5),
          influence_score: outcome === 'success' ? 0.8 : (outcome === 'shadow_only' ? 0.45 : 0.1)
        }, {
          apply: false
        });
        if (attrOut && attrOut.ok === true) {
          valueAttribution = {
            attribution_id: attrOut.attribution_id || null,
            influence_score: Number(attrOut.influence_score || 0),
            shadow_only: attrOut.shadow_only === true,
            creator_id: attrOut.creator_id || null
          };
        }
      } catch {
        // Attribution is additive and must not block assimilation flow.
      }
    }

    const row = {
      capability_id: capabilityId,
      source_type: record.source_type,
      risk_class: record.risk_class || 'general',
      improvement_mode: improvementMode,
      native_equivalent_id: record.native_equivalent_id || null,
      duality: dualitySignal
        ? {
          enabled: dualitySignal.enabled === true,
          score_trit: Number(dualitySignal.score_trit || 0),
          score_label: cleanText(dualitySignal.score_label || 'unknown', 32),
          zero_point_harmony_potential: Number(dualitySignal.zero_point_harmony_potential || 0),
          recommended_adjustment: cleanText(dualitySignal.recommended_adjustment || '', 120) || null,
          confidence: Number(dualitySignal.confidence || 0),
          effective_weight: Number(dualitySignal.effective_weight || 0),
          advisory_rank: Number(candidate && candidate._duality_rank || 0),
          indicator: dualitySignal.indicator && typeof dualitySignal.indicator === 'object'
            ? dualitySignal.indicator
            : null,
          zero_point_insight: cleanText(dualitySignal.zero_point_insight || '', 220) || null
        }
        : {
          enabled: false,
          advisory_rank: Number(candidate && candidate._duality_rank || 0)
        },
      thresholds: candidate.thresholds,
      legal_gate: legalGate,
      weaver_gate: weaverGate,
      research_probe: research,
      capability_profile: {
        ok: profileCompile && profileCompile.ok === true,
        strict: profileCompile && profileCompile.strict === true,
        profile_id: profileCompile && profileCompile.profile_id || null,
        profile_hash: profileCompile && profileCompile.profile_hash || null,
        profile_path: profileCompile && profileCompile.profile_path || null,
        validation: profileCompile && profileCompile.validation || null
      },
      forge_replica: forge,
      hidden_eval_suite: hiddenEval,
      nursery,
      adversarial,
      graft,
      value_attribution: valueAttribution,
      outcome
    };
    results.push(row);
    if (dualitySignal && dualitySignal.enabled === true && typeof registerDualityObservation === 'function') {
      try {
        registerDualityObservation({
          lane: 'assimilation_candidacy',
          source: 'assimilation_controller',
          run_id: runId,
          predicted_trit: Number(dualitySignal.score_trit || 0),
          observed_trit: outcome === 'success' ? 1 : (outcome === 'reject' ? -1 : 0)
        });
      } catch {
        // Advisory telemetry must not block candidate processing.
      }
    }
    emitEvent(paths, policy, 'candidate_processed', {
      run_id: runId,
      date,
      capability_id: capabilityId,
      outcome,
      improvement_mode: improvementMode,
      reason_codes: reasonCodes.slice(0, 24),
      duality: dualitySignal
        ? {
          score_trit: Number(dualitySignal.score_trit || 0),
          zero_point_harmony_potential: Number(dualitySignal.zero_point_harmony_potential || 0),
          recommended_adjustment: cleanText(dualitySignal.recommended_adjustment || '', 120) || null
        }
        : { enabled: false }
    });
  }

  const outLedger = saveLedger(fs, path, paths.ledger_path, ledger, nowTs);
  const payload = {
    ok: true,
    type: 'assimilation_run',
    ts: nowTs,
    date,
    run_id: runId,
    policy: {
      version: policy.version,
      path: relPath(policyPath),
      shadow_only: policy.shadow_only === true
    },
    resource_gate: resourceGate,
    apply_requested: applyRequested,
    apply_allowed: policy.allow_apply === true,
    candidates_considered: selected.length,
    candidates_processed: results.length,
    candidates: results,
    ledger_path: relPath(paths.ledger_path),
    ledger_updated_at: outLedger.updated_at
  };
  const runPath = path.join(paths.runs_dir, `${date}.json`);
  writeJsonAtomic(runPath, payload);
  writeJsonAtomic(paths.latest_path, payload);
  emitEvent(paths, policy, 'run_completed', {
    run_id: runId,
    date,
    candidates_processed: results.length,
    apply_requested: applyRequested
  });
  emitIdeProjection(paths, policy, {
    run_id: runId,
    date,
    candidates: results.slice(0, 24).map((row) => ({
      capability_id: row.capability_id,
      outcome: row.outcome,
      improvement_mode: row.improvement_mode,
      risk_class: row.risk_class,
      duality: row.duality && typeof row.duality === 'object'
        ? {
          enabled: row.duality.enabled === true,
          score_trit: Number(row.duality.score_trit || 0),
          zero_point_harmony_potential: Number(row.duality.zero_point_harmony_potential || 0),
          indicator: row.duality.indicator && typeof row.duality.indicator === 'object'
            ? row.duality.indicator
            : null
        }
        : { enabled: false }
    }))
  });
  const summaryLines = [
    `# Assimilation Run (${date})`,
    '',
    `- Run: \`${runId}\``,
    `- Shadow only: \`${policy.shadow_only === true ? 'yes' : 'no'}\``,
    `- Candidates processed: \`${results.length}\``,
    ''
  ];
  for (const row of results.slice(0, 8)) {
    summaryLines.push(`- \`${row.capability_id}\` -> \`${row.outcome}\` (improvement=\`${row.improvement_mode ? 'yes' : 'no'}\`)`);
  }
  emitObsidianProjection(paths, policy, {
    run_id: runId,
    date,
    markdown: summaryLines.join('\n'),
    duality: results.slice(0, 8).map((row) => ({
      capability_id: row.capability_id,
      score_trit: Number(row.duality && row.duality.score_trit || 0),
      harmony: Number(row.duality && row.duality.zero_point_harmony_potential || 0),
      recommendation: cleanText(row.duality && row.duality.recommended_adjustment || '', 120) || null
    }))
  });
  return {
    ...payload,
    run_path: relPath(runPath),
    latest_path: relPath(paths.latest_path)
  };
}

function commandRollback(args: AnyObj) {
  const capabilityId = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  if (!capabilityId) throw new Error('capability_id_required');
  const policyPath = path.resolve(String(args.policy || process.env.ASSIMILATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const nowTs = nowIso();
  const reason = cleanText(args.reason || 'manual_rollback', 180) || 'manual_rollback';
  const ledger = loadLedger(fs, paths.ledger_path);
  const record = ledger.capabilities && ledger.capabilities[capabilityId]
    ? ledger.capabilities[capabilityId]
    : null;
  if (!record) throw new Error('capability_not_found');
  record.status = 'candidate';
  record.last_outcome = 'rolled_back';
  record.last_reason_codes = [reason];
  record.cooldown_until_ts = null;
  setAttemptOutcome(record, 'reject', ['manual_rollback'], policy, nowTs);
  const outLedger = saveLedger(fs, path, paths.ledger_path, ledger, nowTs);
  appendJsonl(paths.rollbacks_path, {
    ts: nowTs,
    type: 'assimilation_rollback',
    capability_id: capabilityId,
    reason
  });
  emitEvent(paths, policy, 'rollback', {
    capability_id: capabilityId,
    reason
  });
  return {
    ok: true,
    type: 'assimilation_rollback',
    ts: nowTs,
    capability_id: capabilityId,
    reason,
    ledger_updated_at: outLedger.updated_at
  };
}

function commandStatus(args: AnyObj) {
  const dateArg = String(args._ && args._[0] ? args._[0] : 'latest');
  const policyPath = path.resolve(String(args.policy || process.env.ASSIMILATION_POLICY_PATH || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  const paths = runtimePaths(policyPath, policy);
  const payload = dateArg === 'latest'
    ? readJson(paths.latest_path, null)
    : readJson(path.join(paths.runs_dir, `${toDate(dateArg)}.json`), null);
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      type: 'assimilation_status',
      error: 'assimilation_snapshot_missing',
      date: dateArg === 'latest' ? 'latest' : toDate(dateArg)
    };
  }
  return {
    ok: true,
    type: 'assimilation_status',
    ts: String(payload.ts || ''),
    date: String(payload.date || ''),
    run_id: String(payload.run_id || ''),
    candidates_processed: Number(payload.candidates_processed || 0),
    shadow_only: !!(payload.policy && payload.policy.shadow_only === true),
    apply_requested: payload.apply_requested === true
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  try {
    let out: AnyObj;
    if (cmd === 'record-use') out = commandRecordUse(args);
    else if (cmd === 'assess') out = commandAssess(args);
    else if (cmd === 'run') {
      args._ = args._.slice(1);
      out = commandRun(args);
    } else if (cmd === 'rollback') out = commandRollback(args);
    else if (cmd === 'status') {
      args._ = args._.slice(1);
      out = commandStatus(args);
    } else if (!cmd || cmd === '--help' || cmd === 'help') {
      usage();
      process.exit(0);
      return;
    } else {
      throw new Error(`unknown_command:${cmd}`);
    }
    process.stdout.write(`${JSON.stringify(out)}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'assimilation_controller',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'assimilation_failed', 240)
    })}\n`);
    process.exit(1);
  }
}

if (require.main === module) main();

module.exports = {
  commandRecordUse,
  commandAssess,
  commandRun,
  commandRollback,
  commandStatus
};
