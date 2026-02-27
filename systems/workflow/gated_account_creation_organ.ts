#!/usr/bin/env node
'use strict';
export {};

/**
 * gated_account_creation_organ.js
 *
 * V2-065:
 * Thin, profile-driven account creation orchestrator built on:
 * - alias_verification_vault (V2-066)
 * - capability profiles / universal execution primitive (V2-067 / V3-039)
 * - agent passport chain (V2-063)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { issuePassport, appendAction } = require('../security/agent_passport.js');
const { loadPolicy: loadAliasPolicy, commandIssue: aliasIssue } = require('../security/alias_verification_vault.js');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.GATED_ACCOUNT_CREATION_POLICY_PATH
  ? path.resolve(process.env.GATED_ACCOUNT_CREATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'gated_account_creation_policy.json');
const DEFAULT_TEMPLATES_PATH = process.env.GATED_ACCOUNT_CREATION_TEMPLATES_PATH
  ? path.resolve(process.env.GATED_ACCOUNT_CREATION_TEMPLATES_PATH)
  : path.join(ROOT, 'config', 'account_creation_templates.json');
const EYE_KERNEL_SCRIPT = path.join(ROOT, 'systems', 'eye', 'eye_kernel.js');
const SOUL_GUARD_SCRIPT = path.join(ROOT, 'systems', 'security', 'soul_token_guard.js');
const WEAVER_CORE_SCRIPT = path.join(ROOT, 'systems', 'weaver', 'weaver_core.js');
const UNIVERSAL_EXECUTION_SCRIPT = path.join(ROOT, 'systems', 'actuation', 'universal_execution_primitive.js');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
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

function readJson(filePath: string, fallback: any) {
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
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackAbs: string) {
  const text = cleanText(raw, 420);
  if (!text) return fallbackAbs;
  return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
}

function runNodeJson(scriptPath: string, args: string[]) {
  const r = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const stdout = String(r.stdout || '').trim();
  const stderr = String(r.stderr || '').trim();
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
    ok: r.status === 0,
    code: Number(r.status || 0),
    payload,
    stdout,
    stderr
  };
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    require_objective_id: true,
    templates_path: 'config/account_creation_templates.json',
    high_risk_classes: ['payments', 'auth', 'filesystem', 'shell', 'network-control'],
    require_human_approval_for_high_risk: true,
    actor_defaults: {
      actor_id: 'account_creation_organ',
      role: 'workflow'
    },
    execution: {
      mock_mode: false
    },
    state: {
      state_path: 'state/workflow/gated_account_creation/state.json',
      latest_path: 'state/workflow/gated_account_creation/latest.json',
      receipts_path: 'state/workflow/gated_account_creation/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const state = raw.state && typeof raw.state === 'object' ? raw.state : {};
  const actor = raw.actor_defaults && typeof raw.actor_defaults === 'object' ? raw.actor_defaults : {};
  const execution = raw.execution && typeof raw.execution === 'object' ? raw.execution : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    shadow_only: raw.shadow_only !== false,
    require_objective_id: raw.require_objective_id !== false,
    templates_path: resolvePath(raw.templates_path || base.templates_path, path.join(ROOT, base.templates_path)),
    high_risk_classes: Array.from(new Set(
      (Array.isArray(raw.high_risk_classes) ? raw.high_risk_classes : base.high_risk_classes)
        .map((v: unknown) => normalizeToken(v, 80))
        .filter(Boolean)
    )),
    require_human_approval_for_high_risk: raw.require_human_approval_for_high_risk !== false,
    actor_defaults: {
      actor_id: normalizeToken(actor.actor_id || base.actor_defaults.actor_id, 120) || base.actor_defaults.actor_id,
      role: normalizeToken(actor.role || base.actor_defaults.role, 80) || base.actor_defaults.role
    },
    execution: {
      mock_mode: execution.mock_mode === true
    },
    state: {
      state_path: resolvePath(state.state_path || base.state.state_path, path.join(ROOT, base.state.state_path)),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, path.join(ROOT, base.state.latest_path)),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, path.join(ROOT, base.state.receipts_path))
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadTemplates(policy: AnyObj) {
  const doc = readJson(policy.templates_path, {});
  const templatesRaw = doc.templates && typeof doc.templates === 'object' ? doc.templates : {};
  return templatesRaw;
}

function loadState(policy: AnyObj) {
  const src = readJson(policy.state.state_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'gated_account_creation_state',
      schema_version: '1.0',
      updated_at: nowIso(),
      runs: []
    };
  }
  return {
    schema_id: 'gated_account_creation_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 60),
    runs: Array.isArray(src.runs) ? src.runs : []
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  writeJsonAtomic(policy.state.state_path, {
    schema_id: 'gated_account_creation_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    runs: Array.isArray(state.runs) ? state.runs.slice(-1000) : []
  });
}

function passFail(ok: boolean, reason: string, payload: AnyObj = {}) {
  return { ok: ok === true, reason: cleanText(reason, 160), payload };
}

function runConstitutionGate(riskClass: string, gateOverride: string | null = null) {
  const override = normalizeToken(gateOverride || '', 20);
  if (override === 'pass') return passFail(true, 'mock_constitution_pass');
  if (override === 'fail') return passFail(false, 'mock_constitution_fail');
  const gate = runNodeJson(EYE_KERNEL_SCRIPT, [
    'route',
    '--lane=organ',
    '--target=workflow',
    '--action=create_account',
    `--risk=${riskClass || 'medium'}`,
    '--clearance=L2',
    '--apply=0'
  ]);
  const decision = gate && gate.payload ? cleanText(gate.payload.decision || '', 40) : '';
  return passFail(gate.ok && decision === 'allow', gate.ok ? `eye_decision_${decision || 'unknown'}` : 'eye_route_failed', gate.payload || {});
}

function runSoulGate(gateOverride: string | null = null) {
  const override = normalizeToken(gateOverride || '', 20);
  if (override === 'pass') return passFail(true, 'mock_soul_pass');
  if (override === 'fail') return passFail(false, 'mock_soul_fail');
  const soul = runNodeJson(SOUL_GUARD_SCRIPT, ['verify', '--strict=1']);
  return passFail(soul.ok, soul.ok ? 'soul_guard_pass' : 'soul_guard_failed', soul.payload || {});
}

function runWeaverGate(gateOverride: string | null = null) {
  const override = normalizeToken(gateOverride || '', 20);
  if (override === 'pass') return passFail(true, 'mock_weaver_pass');
  if (override === 'fail') return passFail(false, 'mock_weaver_fail');
  const weaver = runNodeJson(WEAVER_CORE_SCRIPT, ['status', 'latest']);
  const ok = weaver.ok && weaver.payload && weaver.payload.ok !== false;
  return passFail(ok, ok ? 'weaver_status_pass' : 'weaver_status_failed', weaver.payload || {});
}

function ensurePassport(policy: AnyObj, objectiveId: string | null, args: AnyObj) {
  const actorId = normalizeToken(args.actor_id || args['actor-id'] || policy.actor_defaults.actor_id, 120);
  const role = normalizeToken(args.role || policy.actor_defaults.role, 80);
  const issued = issuePassport({
    actor: actorId,
    role,
    tenant: normalizeToken(args.tenant || 'local', 120),
    model: normalizeToken(args.model || 'universal_execution_primitive', 120),
    framework: normalizeToken(args.framework || 'openclaw', 120),
    org: normalizeToken(args.org || 'protheus', 120),
    'ttl-hours': cleanText(args['ttl-hours'] || args.ttl_hours || '', 20)
  }, { apply: true });
  if (!issued || issued.ok !== true || !issued.passport_id) return null;
  appendAction({
    action_json: JSON.stringify({
      action_type: 'account_creation_begin',
      objective_id: objectiveId || null
    })
  });
  return cleanText(issued.passport_id || '', 140) || null;
}

function maybeIssueAlias(template: AnyObj, passportId: string | null, applyMode: boolean) {
  const channel = normalizeToken(template.alias_channel || '', 20);
  if (!channel) return null;
  const policy = loadAliasPolicy();
  const issued = aliasIssue({
    channel,
    purpose: cleanText(template.alias_purpose || 'account_creation_verification', 200),
    'passport-id': passportId || '',
    apply: applyMode ? '1' : '0'
  }, policy);
  if (!issued || issued.ok !== true) return null;
  return issued;
}

function executeTemplateStep(step: AnyObj, passportId: string | null, objectiveId: string | null, mockExecution: boolean, applyMode: boolean) {
  const intent = normalizeToken(step.intent || 'create_account', 80) || 'create_account';
  const params = step.params && typeof step.params === 'object' ? step.params : {};
  const profile = step.profile && typeof step.profile === 'object' ? step.profile : null;
  if (mockExecution) {
    return {
      ok: true,
      type: 'account_creation_step',
      mocked: true,
      intent,
      adapter_kind: normalizeToken(profile && profile.execution && profile.execution.adapter_kind || 'http_request', 80) || 'http_request',
      row: {
        passport_link_id: passportId,
        objective_id: objectiveId || null,
        dry_run: !applyMode
      }
    };
  }
  const args = [
    'run',
    `--intent=${intent}`,
    `--params=${JSON.stringify(params)}`,
    `--context=${JSON.stringify({ passport_id: passportId, objective_id: objectiveId, source: 'gated_account_creation_organ' })}`
  ];
  if (profile) args.push(`--profile-json=${JSON.stringify(profile)}`);
  if (!applyMode) args.push('--dry-run=1');
  return runNodeJson(UNIVERSAL_EXECUTION_SCRIPT, args);
}

function cmdCreate(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    const out = { ok: false, type: 'gated_account_creation', error: 'policy_disabled' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }
  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 160) || null;
  if (policy.require_objective_id && !objectiveId) {
    const out = { ok: false, type: 'gated_account_creation', error: 'objective_id_required' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }

  const templates = loadTemplates(policy);
  const templateId = normalizeToken(args.template || args['template-id'] || 'generic_email_account', 120);
  const template = templateId && templates[templateId] && typeof templates[templateId] === 'object'
    ? templates[templateId]
    : null;
  if (!template) {
    const out = { ok: false, type: 'gated_account_creation', error: 'template_not_found', template_id: templateId };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }

  const riskClass = normalizeToken(template.risk_class || args['risk-class'] || args.risk_class || 'medium', 40) || 'medium';
  const humanApproved = toBool(args['human-approved'] || args.human_approved, false);
  if (policy.require_human_approval_for_high_risk && policy.high_risk_classes.includes(riskClass) && !humanApproved) {
    const out = {
      ok: false,
      type: 'gated_account_creation',
      error: 'high_risk_requires_human_approval',
      risk_class: riskClass
    };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }

  const applyMode = toBool(args.apply, false) && !policy.shadow_only;
  const mockExecution = toBool(args['mock-execution'] || args.mock_execution, policy.execution.mock_mode === true);
  const gateSoul = runSoulGate(args['gate-soul'] || args.gate_soul || null);
  const gateWeaver = runWeaverGate(args['gate-weaver'] || args.gate_weaver || null);
  const gateConstitution = runConstitutionGate(riskClass, args['gate-constitution'] || args.gate_constitution || null);
  const gatePass = gateSoul.ok && gateWeaver.ok && gateConstitution.ok;

  const ts = nowIso();
  const passportId = gatePass ? ensurePassport(policy, objectiveId, args) : null;
  if (gatePass && !passportId) {
    const out = { ok: false, type: 'gated_account_creation', error: 'passport_issue_failed' };
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    process.exit(1);
    return;
  }

  let alias = null;
  if (gatePass) {
    alias = maybeIssueAlias(template, passportId, applyMode);
  }

  const steps = Array.isArray(template.steps) ? template.steps : [];
  const stepResults: AnyObj[] = [];
  let allStepsOk = true;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i] && typeof steps[i] === 'object' ? steps[i] : {};
    const result = gatePass
      ? executeTemplateStep(step, passportId, objectiveId, mockExecution, applyMode)
      : { ok: false, skipped: true, reason: 'gates_not_passed' };
    stepResults.push({
      step_id: normalizeToken(step.id || `step_${i + 1}`, 80) || `step_${i + 1}`,
      intent: normalizeToken(step.intent || '', 80) || null,
      ok: result && result.ok === true,
      mocked: result && result.mocked === true,
      error: result && result.ok !== true ? cleanText(result.stderr || result.error || result.reason || 'execution_failed', 200) : null
    });
    if (!result || result.ok !== true) allStepsOk = false;
    if (passportId) {
      appendAction({
        action_json: JSON.stringify({
          action_type: 'account_creation_step',
          objective_id: objectiveId,
          template_id: templateId,
          step_id: normalizeToken(step.id || `step_${i + 1}`, 80) || `step_${i + 1}`,
          ok: result && result.ok === true
        })
      });
    }
  }

  const runId = normalizeToken(`acr_${Date.now()}_${templateId}`, 120);
  const summary = {
    run_id: runId,
    ts,
    objective_id: objectiveId,
    template_id: templateId,
    risk_class: riskClass,
    apply_mode: applyMode,
    mock_execution: mockExecution,
    human_approved: humanApproved,
    gate_pass: gatePass,
    gates: {
      soul: gateSoul,
      weaver: gateWeaver,
      constitution: gateConstitution
    },
    passport_id: passportId,
    alias_id: alias && alias.alias ? alias.alias.alias_id : null,
    step_count: stepResults.length,
    steps_ok: allStepsOk,
    step_results: stepResults,
    status: gatePass && allStepsOk ? (applyMode ? 'applied' : 'shadow_only') : 'blocked'
  };

  const state = loadState(policy);
  state.runs.push(summary);
  saveState(policy, state);
  appendJsonl(policy.state.receipts_path, {
    type: 'gated_account_creation',
    ...summary
  });
  writeJsonAtomic(policy.state.latest_path, {
    ok: summary.status !== 'blocked',
    type: 'gated_account_creation_latest',
    ...summary,
    paths: {
      state_path: rel(policy.state.state_path),
      receipts_path: rel(policy.state.receipts_path)
    }
  });

  process.stdout.write(`${JSON.stringify({
    ok: summary.status !== 'blocked',
    type: 'gated_account_creation',
    ...summary
  }, null, 2)}\n`);
  if (summary.status === 'blocked') process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy || DEFAULT_POLICY_PATH);
  const state = loadState(policy);
  const rows = Array.isArray(state.runs) ? state.runs : [];
  const out = {
    ok: true,
    type: 'gated_account_creation_status',
    ts: nowIso(),
    runs_total: rows.length,
    applied: rows.filter((row: AnyObj) => row && row.status === 'applied').length,
    shadow_only: rows.filter((row: AnyObj) => row && row.status === 'shadow_only').length,
    blocked: rows.filter((row: AnyObj) => row && row.status === 'blocked').length,
    latest: rows.length ? rows[rows.length - 1] : null,
    paths: {
      state_path: rel(policy.state.state_path),
      latest_path: rel(policy.state.latest_path),
      receipts_path: rel(policy.state.receipts_path)
    }
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/gated_account_creation_organ.js create --template=<id> --objective-id=<id> [--apply=1|0] [--human-approved=1|0] [--mock-execution=1|0]');
  console.log('  node systems/workflow/gated_account_creation_organ.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 60);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'create') return cmdCreate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  loadTemplates,
  runConstitutionGate,
  runSoulGate,
  runWeaverGate
};

