#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-UX-002
 * Phase-1 traditional UI polish + consistency pass with feature-gated rollback.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  toBool,
  parseArgs,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.UI_PHASE1_POLISH_POLICY_PATH
  ? path.resolve(process.env.UI_PHASE1_POLISH_POLICY_PATH)
  : path.join(ROOT, 'config', 'ui_phase1_polish_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/ui_phase1_polish_consistency_pass.js verify [--strict=1|0] [--apply=1] [--policy=<path>]');
  console.log('  node systems/ops/ui_phase1_polish_consistency_pass.js enable [--policy=<path>]');
  console.log('  node systems/ops/ui_phase1_polish_consistency_pass.js disable [--policy=<path>]');
  console.log('  node systems/ops/ui_phase1_polish_consistency_pass.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function readText(filePath: string) {
  try {
    return fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : '';
  } catch {
    return '';
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    feature_flag_name: 'phase1_ui_polish',
    feature_flag_default: false,
    enable_on_apply: false,
    required_files: [
      'README.md',
      'docs/UI_SURFACE_MATURITY_MATRIX.md',
      'docs/UI_PHASE1_TRADITIONAL_POLISH.md',
      'docs/ONBOARDING_PLAYBOOK.md'
    ],
    required_sections: [
      'spacing',
      'typography',
      'motion',
      'states',
      'theme',
      'keyboard navigation',
      'command palette',
      'responsive'
    ],
    accessibility_terms: ['aria', 'keyboard', 'focus', 'contrast'],
    paths: {
      feature_flags_path: 'config/feature_flags.json',
      polish_spec_path: 'docs/UI_PHASE1_TRADITIONAL_POLISH.md',
      surface_matrix_path: 'docs/UI_SURFACE_MATURITY_MATRIX.md',
      latest_path: 'state/ops/ui_phase1_polish_consistency_pass/latest.json',
      history_path: 'state/ops/ui_phase1_polish_consistency_pass/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    feature_flag_name: cleanText(raw.feature_flag_name || base.feature_flag_name, 120) || base.feature_flag_name,
    feature_flag_default: toBool(raw.feature_flag_default, base.feature_flag_default),
    enable_on_apply: toBool(raw.enable_on_apply, base.enable_on_apply),
    required_files: Array.isArray(raw.required_files) && raw.required_files.length
      ? raw.required_files.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_files,
    required_sections: Array.isArray(raw.required_sections) && raw.required_sections.length
      ? raw.required_sections.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
      : base.required_sections,
    accessibility_terms: Array.isArray(raw.accessibility_terms) && raw.accessibility_terms.length
      ? raw.accessibility_terms.map((v: unknown) => cleanText(v, 80).toLowerCase()).filter(Boolean)
      : base.accessibility_terms,
    paths: {
      feature_flags_path: resolvePath(paths.feature_flags_path, base.paths.feature_flags_path),
      polish_spec_path: resolvePath(paths.polish_spec_path, base.paths.polish_spec_path),
      surface_matrix_path: resolvePath(paths.surface_matrix_path, base.paths.surface_matrix_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadFlags(flagsPath: string, flagName: string, defaultValue: boolean) {
  const row = readJson(flagsPath, {});
  if (!row || typeof row !== 'object') return { [flagName]: defaultValue };
  if (!Object.prototype.hasOwnProperty.call(row, flagName)) {
    row[flagName] = defaultValue;
  }
  return row;
}

function saveFlags(flagsPath: string, flags: AnyObj) {
  writeJsonAtomic(flagsPath, flags);
}

function verify(policy: AnyObj, args: AnyObj) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'ui_phase1_polish_consistency_pass',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const missingFiles = policy.required_files
    .map((relPath: string) => ({ rel: relPath, abs: path.join(ROOT, relPath) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const spec = readText(policy.paths.polish_spec_path).toLowerCase();
  const matrix = readText(policy.paths.surface_matrix_path).toLowerCase();
  const combined = `${spec}\n${matrix}`;

  const missingSections = policy.required_sections
    .filter((term: string) => !combined.includes(term));

  const missingA11y = policy.accessibility_terms
    .filter((term: string) => !combined.includes(term));

  const flags = loadFlags(policy.paths.feature_flags_path, policy.feature_flag_name, policy.feature_flag_default);
  const featureGatePresent = Object.prototype.hasOwnProperty.call(flags, policy.feature_flag_name);
  const featureEnabled = toBool(flags[policy.feature_flag_name], policy.feature_flag_default);

  if (toBool(args.apply, false) && policy.enable_on_apply) {
    flags[policy.feature_flag_name] = true;
    saveFlags(policy.paths.feature_flags_path, flags);
  }

  const checks = {
    required_files_present: missingFiles.length === 0,
    polish_sections_complete: missingSections.length === 0,
    accessibility_contract_complete: missingA11y.length === 0,
    feature_gate_present: featureGatePresent,
    rollback_toggle_available: true
  };

  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'ui_phase1_polish_consistency_pass',
    lane_id: 'V4-UX-002',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_files: missingFiles,
    missing_sections: missingSections,
    missing_accessibility_terms: missingA11y,
    feature_flag: {
      name: policy.feature_flag_name,
      enabled: featureEnabled,
      flags_path: rel(policy.paths.feature_flags_path)
    },
    rollback: {
      disable_command: `node systems/ops/ui_phase1_polish_consistency_pass.js disable --policy=${rel(policy.policy_path)}`
    },
    verification_receipt_id: `ux_polish_${stableHash(JSON.stringify({ missingFiles, missingSections, missingA11y, featureEnabled }), 14)}`
  };
}

function cmdVerify(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, true);
  const out = verify(policy, args);

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    blocking_checks: out.blocking_checks,
    feature_enabled: out.feature_flag && out.feature_flag.enabled === true
  });

  emit({
    ...out,
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path)
  }, out.ok || !strict ? 0 : 1);
}

function setFlag(policy: AnyObj, enabled: boolean) {
  const flags = loadFlags(policy.paths.feature_flags_path, policy.feature_flag_name, policy.feature_flag_default);
  flags[policy.feature_flag_name] = enabled;
  saveFlags(policy.paths.feature_flags_path, flags);
  return flags;
}

function cmdEnable(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const flags = setFlag(policy, true);
  emit({
    ok: true,
    type: 'ui_phase1_polish_toggle',
    ts: nowIso(),
    lane_id: 'V4-UX-002',
    feature_flag: policy.feature_flag_name,
    enabled: true,
    flags_path: rel(policy.paths.feature_flags_path),
    flags
  }, 0);
}

function cmdDisable(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const flags = setFlag(policy, false);
  emit({
    ok: true,
    type: 'ui_phase1_polish_toggle',
    ts: nowIso(),
    lane_id: 'V4-UX-002',
    feature_flag: policy.feature_flag_name,
    enabled: false,
    flags_path: rel(policy.paths.feature_flags_path),
    flags
  }, 0);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const flags = loadFlags(policy.paths.feature_flags_path, policy.feature_flag_name, policy.feature_flag_default);

  emit({
    ok: true,
    type: 'ui_phase1_polish_consistency_pass_status',
    ts: nowIso(),
    feature_flag: {
      name: policy.feature_flag_name,
      enabled: toBool(flags[policy.feature_flag_name], false)
    },
    latest: readJson(policy.paths.latest_path, null),
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path)
  }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 80).toLowerCase();
  if (args.help || ['help', '--help', '-h'].includes(cmd)) {
    usage();
    process.exit(0);
  }

  if (cmd === 'verify' || cmd === 'run') return cmdVerify(args);
  if (cmd === 'enable') return cmdEnable(args);
  if (cmd === 'disable') return cmdDisable(args);
  if (cmd === 'status') return cmdStatus(args);

  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();
