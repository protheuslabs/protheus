#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CRITICAL_PATH_FORMAL_POLICY_PATH
  ? path.resolve(process.env.CRITICAL_PATH_FORMAL_POLICY_PATH)
  : path.join(ROOT, 'config', 'critical_path_formal_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/critical_path_formal_verifier.js run [--strict=1|0]');
  console.log('  node systems/security/critical_path_formal_verifier.js status');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(absPath: string, payload: AnyObj) {
  ensureDir(path.dirname(absPath));
  const tmp = `${absPath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, absPath);
}

function appendJsonl(absPath: string, payload: AnyObj) {
  ensureDir(path.dirname(absPath));
  fs.appendFileSync(absPath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function normalizeRelativeForRoot(raw: string) {
  const rel = String(raw || '').trim().replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
  if (!rel) return rel;
  if (rel === 'state' || rel.startsWith('state/')) {
    return path.join('local', rel);
  }
  if (rel === 'client/state' || rel.startsWith('client/state/')) {
    const suffix = rel === 'client/state' ? '' : rel.slice('client/state/'.length);
    return path.join('local', 'state', suffix);
  }
  if (rel.startsWith('client/')) {
    return rel.slice('client/'.length);
  }
  return rel;
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = cleanText(raw, 320);
  const normalized = normalizeRelativeForRoot(text || fallbackRel);
  if (!text) return path.join(ROOT, normalized);
  return path.isAbsolute(text) ? text : path.join(ROOT, normalized);
}

function readFileText(absPath: string) {
  try {
    return fs.readFileSync(absPath, 'utf8');
  } catch {
    return '';
  }
}

function getPathValue(src: AnyObj, dotPathRaw: unknown) {
  const dotPath = cleanText(dotPathRaw, 200);
  if (!dotPath) return undefined;
  const parts = dotPath.split('.').map((row) => row.trim()).filter(Boolean);
  let cur: any = src;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object' || !(part in cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

function defaultPolicy() {
  return {
    schema_id: 'critical_path_formal_policy',
    schema_version: '1.0',
    enabled: true,
    strict_fail_closed: true,
    paths: {
      weaver_policy: 'config/weaver_policy.json',
      inversion_policy: 'config/inversion_policy.json',
      constitution_policy: 'config/constitution_guardian_policy.json',
      formal_invariants: 'config/formal_invariants.json',
      weaver_arbitration_source: 'systems/weaver/arbitration_engine.ts',
      weaver_core_source: 'systems/weaver/weaver_core.ts',
      inversion_source: 'systems/autonomy/inversion_controller.ts'
    },
    checks: {
      required_weaver_weights: [
        'impact',
        'confidence',
        'uncertainty',
        'drift_risk',
        'cost_pressure',
        'mirror_pressure',
        'regime_alignment'
      ],
      required_axiom_ids: [
        'preserve_root_constitution',
        'preserve_user_sovereignty',
        'never_self_terminate',
        'never_bypass_guardrails',
        'never_disable_integrity_kernel'
      ],
      objective_id_required_min_target_rank: 2,
      require_shadow_pass_for_live_rank_at_least: 2,
      require_human_veto_for_live_rank_at_least: 3,
      minimum_observer_quorum_for_live_rank_at_least: 2,
      minimum_shadow_hours_for_live_rank_at_least: 2,
      required_disabled_live_targets: [
        'directive',
        'constitution'
      ]
    },
    state_path: 'local/state/security/critical_path_formal/latest.json',
    history_path: 'local/state/security/critical_path_formal/history.jsonl'
  };
}

function loadPolicy() {
  const base = defaultPolicy();
  const raw = readJson(POLICY_PATH, base);
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const checks = raw.checks && typeof raw.checks === 'object' ? raw.checks : {};
  return {
    schema_id: 'critical_path_formal_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    enabled: raw.enabled !== false,
    strict_fail_closed: raw.strict_fail_closed !== false,
    paths: {
      weaver_policy: resolvePath(paths.weaver_policy || base.paths.weaver_policy, base.paths.weaver_policy),
      inversion_policy: resolvePath(paths.inversion_policy || base.paths.inversion_policy, base.paths.inversion_policy),
      constitution_policy: resolvePath(paths.constitution_policy || base.paths.constitution_policy, base.paths.constitution_policy),
      formal_invariants: resolvePath(paths.formal_invariants || base.paths.formal_invariants, base.paths.formal_invariants),
      weaver_arbitration_source: resolvePath(paths.weaver_arbitration_source || base.paths.weaver_arbitration_source, base.paths.weaver_arbitration_source),
      weaver_core_source: resolvePath(paths.weaver_core_source || base.paths.weaver_core_source, base.paths.weaver_core_source),
      inversion_source: resolvePath(paths.inversion_source || base.paths.inversion_source, base.paths.inversion_source)
    },
    checks: {
      required_weaver_weights: Array.isArray(checks.required_weaver_weights)
        ? checks.required_weaver_weights.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : base.checks.required_weaver_weights.slice(0),
      required_axiom_ids: Array.isArray(checks.required_axiom_ids)
        ? checks.required_axiom_ids.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : base.checks.required_axiom_ids.slice(0),
      objective_id_required_min_target_rank: Math.max(1, Number(checks.objective_id_required_min_target_rank || base.checks.objective_id_required_min_target_rank) || base.checks.objective_id_required_min_target_rank),
      require_shadow_pass_for_live_rank_at_least: Math.max(1, Number(checks.require_shadow_pass_for_live_rank_at_least || base.checks.require_shadow_pass_for_live_rank_at_least) || base.checks.require_shadow_pass_for_live_rank_at_least),
      require_human_veto_for_live_rank_at_least: Math.max(1, Number(checks.require_human_veto_for_live_rank_at_least || base.checks.require_human_veto_for_live_rank_at_least) || base.checks.require_human_veto_for_live_rank_at_least),
      minimum_observer_quorum_for_live_rank_at_least: Math.max(1, Number(checks.minimum_observer_quorum_for_live_rank_at_least || base.checks.minimum_observer_quorum_for_live_rank_at_least) || base.checks.minimum_observer_quorum_for_live_rank_at_least),
      minimum_shadow_hours_for_live_rank_at_least: Math.max(1, Number(checks.minimum_shadow_hours_for_live_rank_at_least || base.checks.minimum_shadow_hours_for_live_rank_at_least) || base.checks.minimum_shadow_hours_for_live_rank_at_least),
      required_disabled_live_targets: Array.isArray(checks.required_disabled_live_targets)
        ? checks.required_disabled_live_targets.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
        : base.checks.required_disabled_live_targets.slice(0)
    },
    state_path: resolvePath(raw.state_path || base.state_path, base.state_path),
    history_path: resolvePath(raw.history_path || base.history_path, base.history_path)
  };
}

function runVerifier() {
  const policy = loadPolicy();
  const outChecks: AnyObj[] = [];
  const addCheck = (id: string, ok: boolean, detail: string, extra: AnyObj = {}) => {
    outChecks.push({
      id: normalizeToken(id, 120) || 'check',
      ok: ok === true,
      detail: cleanText(detail, 320),
      ...extra
    });
  };

  const files = policy.paths;
  addCheck('files:weaver_policy_present', fs.existsSync(files.weaver_policy), path.relative(ROOT, files.weaver_policy).replace(/\\/g, '/'));
  addCheck('files:inversion_policy_present', fs.existsSync(files.inversion_policy), path.relative(ROOT, files.inversion_policy).replace(/\\/g, '/'));
  addCheck('files:constitution_policy_present', fs.existsSync(files.constitution_policy), path.relative(ROOT, files.constitution_policy).replace(/\\/g, '/'));
  addCheck('files:formal_invariants_present', fs.existsSync(files.formal_invariants), path.relative(ROOT, files.formal_invariants).replace(/\\/g, '/'));
  addCheck('files:weaver_arbitration_source_present', fs.existsSync(files.weaver_arbitration_source), path.relative(ROOT, files.weaver_arbitration_source).replace(/\\/g, '/'));
  addCheck('files:weaver_core_source_present', fs.existsSync(files.weaver_core_source), path.relative(ROOT, files.weaver_core_source).replace(/\\/g, '/'));
  addCheck('files:inversion_source_present', fs.existsSync(files.inversion_source), path.relative(ROOT, files.inversion_source).replace(/\\/g, '/'));

  const weaverPolicy = readJson(files.weaver_policy, {});
  const inversionPolicy = readJson(files.inversion_policy, {});
  const constitutionPolicy = readJson(files.constitution_policy, {});
  const formalInvariants = readJson(files.formal_invariants, {});
  const weaverArbSource = readFileText(files.weaver_arbitration_source);
  const weaverCoreSource = readFileText(files.weaver_core_source);
  const inversionSource = readFileText(files.inversion_source);

  addCheck('weaver:policy_enabled', weaverPolicy.enabled !== false, `enabled=${weaverPolicy.enabled !== false}`);
  addCheck(
    'weaver:arbitration_source_hooks',
    weaverArbSource.includes('applyConfiguredSoftCaps') && weaverArbSource.includes('applyCombinedShareCap'),
    'arbitration engine should include share-cap + soft-cap functions'
  );
  addCheck(
    'weaver:constitutional_veto_hook',
    weaverCoreSource.includes('evaluateConstitutionalVeto'),
    'weaver core should evaluate constitutional veto before outputs'
  );

  const requiredWeights = policy.checks.required_weaver_weights;
  const weights = weaverPolicy.arbitration && typeof weaverPolicy.arbitration === 'object'
    ? weaverPolicy.arbitration.weights || {}
    : {};
  const missingWeights = requiredWeights.filter((id: string) => {
    const n = Number(weights[id]);
    return !Number.isFinite(n) || n < 0;
  });
  addCheck(
    'weaver:required_weight_vector',
    missingWeights.length === 0,
    missingWeights.length === 0 ? `weights=${requiredWeights.length}` : `missing=${missingWeights.join(',')}`
  );
  addCheck(
    'weaver:monoculture_guard_enabled',
    !!(weaverPolicy.monoculture_guard && weaverPolicy.monoculture_guard.enabled !== false),
    `enabled=${!!(weaverPolicy.monoculture_guard && weaverPolicy.monoculture_guard.enabled !== false)}`
  );
  addCheck(
    'weaver:constitutional_veto_enabled',
    !!(weaverPolicy.constitutional_veto && weaverPolicy.constitutional_veto.enabled !== false),
    `enabled=${!!(weaverPolicy.constitutional_veto && weaverPolicy.constitutional_veto.enabled !== false)}`
  );

  const requiredAxiomIds = new Set(policy.checks.required_axiom_ids);
  const axiomRows = inversionPolicy.immutable_axioms && Array.isArray(inversionPolicy.immutable_axioms.axioms)
    ? inversionPolicy.immutable_axioms.axioms
    : [];
  const presentAxiomIds = new Set(axiomRows.map((row: AnyObj) => normalizeToken((row && row.id) || '', 80)).filter(Boolean));
  const missingAxiomIds = Array.from(requiredAxiomIds).filter((id) => !presentAxiomIds.has(id));
  addCheck(
    'inversion:immutable_axioms_enabled',
    !!(inversionPolicy.immutable_axioms && inversionPolicy.immutable_axioms.enabled === true),
    `enabled=${!!(inversionPolicy.immutable_axioms && inversionPolicy.immutable_axioms.enabled === true)}`
  );
  addCheck(
    'inversion:required_axioms_present',
    missingAxiomIds.length === 0,
    missingAxiomIds.length === 0 ? `axioms=${presentAxiomIds.size}` : `missing=${missingAxiomIds.join(',')}`
  );

  addCheck(
    'inversion:tier_transition_enabled',
    !!(inversionPolicy.tier_transition && inversionPolicy.tier_transition.enabled === true),
    `enabled=${!!(inversionPolicy.tier_transition && inversionPolicy.tier_transition.enabled === true)}`
  );
  addCheck(
    'inversion:shadow_pass_required_for_live',
    !!(inversionPolicy.shadow_pass_gate && inversionPolicy.shadow_pass_gate.require_for_live_apply === true),
    `required=${!!(inversionPolicy.shadow_pass_gate && inversionPolicy.shadow_pass_gate.require_for_live_apply === true)}`
  );

  const guardMinRank = Number(getPathValue(inversionPolicy, 'guardrails.objective_id_required_min_target_rank') || 0);
  addCheck(
    'inversion:objective_id_rank_gate',
    Number.isFinite(guardMinRank) && guardMinRank <= policy.checks.objective_id_required_min_target_rank,
    `required<=${policy.checks.objective_id_required_min_target_rank} actual=${guardMinRank}`
  );

  const targets = inversionPolicy.targets && typeof inversionPolicy.targets === 'object'
    ? inversionPolicy.targets
    : {};
  const requiredDisabled = policy.checks.required_disabled_live_targets;
  const liveEnabledByTarget: AnyObj = {};
  for (const [targetRaw, rowRaw] of Object.entries(targets)) {
    const target = normalizeToken(targetRaw, 80);
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    liveEnabledByTarget[target] = row.live_enabled === true;
  }
  const disabledViolations = requiredDisabled.filter((target) => liveEnabledByTarget[target] === true);
  addCheck(
    'inversion:high_risk_live_targets_disabled',
    disabledViolations.length === 0,
    disabledViolations.length === 0 ? `targets=${requiredDisabled.length}` : `violations=${disabledViolations.join(',')}`
  );

  const firstN = inversionPolicy.tier_transition && inversionPolicy.tier_transition.first_live_uses_require_human_veto
    ? inversionPolicy.tier_transition.first_live_uses_require_human_veto
    : {};
  const observerQuorum = inversionPolicy.live_graduation_ladder && inversionPolicy.live_graduation_ladder.observer_quorum_by_target
    ? inversionPolicy.live_graduation_ladder.observer_quorum_by_target
    : {};
  const shadowPasses = inversionPolicy.shadow_pass_gate && inversionPolicy.shadow_pass_gate.required_passes_by_target
    ? inversionPolicy.shadow_pass_gate.required_passes_by_target
    : {};

  const modelRows: AnyObj[] = [];
  for (const [targetRaw, rowRaw] of Object.entries(targets)) {
    const target = normalizeToken(targetRaw, 80);
    if (!target) continue;
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const rank = Math.max(0, Number(row.rank || 0) || 0);
    const liveEnabled = row.live_enabled === true;
    const minShadowHours = Math.max(0, Number(row.min_shadow_hours || 0) || 0);
    const requiredShadowPass = Math.max(0, Number(shadowPasses[target] || 0) || 0);
    const requiredFirstN = Math.max(0, Number(firstN[target] || 0) || 0);
    const quorum = Math.max(0, Number(observerQuorum[target] || 0) || 0);
    const shouldRequireShadow = liveEnabled && rank >= policy.checks.require_shadow_pass_for_live_rank_at_least;
    const shouldRequireVeto = liveEnabled && rank >= policy.checks.require_human_veto_for_live_rank_at_least;
    const shouldRequireQuorum = liveEnabled && rank >= policy.checks.minimum_observer_quorum_for_live_rank_at_least;
    const shouldRequireShadowHours = liveEnabled && rank >= policy.checks.minimum_shadow_hours_for_live_rank_at_least;
    const checksOk =
      (!shouldRequireShadow || requiredShadowPass > 0)
      && (!shouldRequireVeto || requiredFirstN > 0)
      && (!shouldRequireQuorum || quorum >= 1)
      && (!shouldRequireShadowHours || minShadowHours >= 1);
    modelRows.push({
      target,
      rank,
      live_enabled: liveEnabled,
      min_shadow_hours: minShadowHours,
      required_shadow_passes: requiredShadowPass,
      required_first_live_veto_uses: requiredFirstN,
      observer_quorum: quorum,
      checks_ok: checksOk
    });
  }

  const failedModels = modelRows.filter((row) => row.checks_ok !== true);
  addCheck(
    'inversion:model_check_live_gate_ordering',
    failedModels.length === 0,
    failedModels.length === 0
      ? `targets_checked=${modelRows.length}`
      : `failed=${failedModels.map((row) => row.target).join(',')}`
  );

  addCheck(
    'inversion:source_structured_axiom_matcher',
    inversionSource.includes('evaluateAxiomSemanticMatch'),
    'inversion controller should call semantic matcher for immutable axioms'
  );

  const invRows = Array.isArray(formalInvariants.invariants) ? formalInvariants.invariants : [];
  addCheck(
    'formal_invariants:spec_non_empty',
    invRows.length >= 6,
    `count=${invRows.length}`
  );
  const invIds = new Set(invRows.map((row: AnyObj) => normalizeToken((row && row.id) || '', 120)).filter(Boolean));
  addCheck(
    'formal_invariants:merge_guard_hook_present',
    invIds.has('merge_guard_profile_compat_hook') || invIds.has('guard_registry_profile_compat_hook'),
    'baseline formal invariants should include merge_guard coverage'
  );

  addCheck(
    'constitution:dual_approval_required',
    constitutionPolicy.require_dual_approval === true,
    `require_dual_approval=${constitutionPolicy.require_dual_approval === true}`
  );
  addCheck(
    'constitution:inheritance_lock_enforced',
    constitutionPolicy.enforce_inheritance_lock === true,
    `enforce_inheritance_lock=${constitutionPolicy.enforce_inheritance_lock === true}`
  );

  const payload = {
    schema_id: 'critical_path_formal_verifier_result',
    schema_version: '1.0',
    ts: nowIso(),
    ok: outChecks.every((row) => row.ok === true),
    checks: outChecks,
    model_rows: modelRows,
    failed_check_count: outChecks.filter((row) => row.ok !== true).length
  };
  writeJsonAtomic(policy.state_path, payload);
  appendJsonl(policy.history_path, payload);
  return payload;
}

function cmdRun(args: AnyObj) {
  const strict = boolFlag(args.strict, false);
  const payload = runVerifier();
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus() {
  const policy = loadPolicy();
  if (!fs.existsSync(policy.state_path)) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      reason: 'status_not_found',
      state_path: path.relative(ROOT, policy.state_path).replace(/\\/g, '/')
    }, null, 2)}\n`);
    process.exit(1);
  }
  process.stdout.write(`${fs.readFileSync(policy.state_path, 'utf8')}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus();
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
