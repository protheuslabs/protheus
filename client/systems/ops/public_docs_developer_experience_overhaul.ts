#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-UX-003
 * Public docs + developer experience overhaul verification lane.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
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

const DEFAULT_POLICY_PATH = process.env.PUBLIC_DOCS_DX_OVERHAUL_POLICY_PATH
  ? path.resolve(process.env.PUBLIC_DOCS_DX_OVERHAUL_POLICY_PATH)
  : path.join(ROOT, 'config', 'public_docs_developer_experience_overhaul_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/public_docs_developer_experience_overhaul.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/public_docs_developer_experience_overhaul.js snapshot [--label=<name>] [--policy=<path>]');
  console.log('  node systems/ops/public_docs_developer_experience_overhaul.js status [--policy=<path>]');
  console.log('  node systems/ops/public_docs_developer_experience_overhaul.js enable [--policy=<path>]');
  console.log('  node systems/ops/public_docs_developer_experience_overhaul.js disable [--policy=<path>]');
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
    feature_flag_name: 'phase1_docs_dx_overhaul',
    feature_flag_default: false,
    required_docs: [
      'README.md',
      'ARCHITECTURE.md',
      'CONTRIBUTING.md',
      'docs/README.md',
      'docs/HELP.md',
      'docs/DEVELOPER_LANE_QUICKSTART.md',
      'docs/ONBOARDING_PLAYBOOK.md'
    ],
    required_links: [
      { source: 'README.md', target: 'ARCHITECTURE.md' },
      { source: 'README.md', target: 'docs/DEVELOPER_LANE_QUICKSTART.md' },
      { source: 'README.md', target: 'docs/HELP.md' },
      { source: 'ARCHITECTURE.md', target: 'docs/README.md' },
      { source: 'CONTRIBUTING.md', target: 'docs/DEVELOPER_LANE_QUICKSTART.md' },
      { source: 'docs/README.md', target: 'DEVELOPER_LANE_QUICKSTART.md' }
    ],
    quickstart_requirements: {
      path: 'docs/DEVELOPER_LANE_QUICKSTART.md',
      required_phrases: ['under 10 minutes', 'first custom lane', 'rollback']
    },
    onboarding_check: {
      script: 'systems/ops/first_run_onboarding_wizard.js',
      args: ['status']
    },
    paths: {
      feature_flags_path: 'config/feature_flags.json',
      latest_path: 'state/ops/public_docs_developer_experience_overhaul/latest.json',
      history_path: 'state/ops/public_docs_developer_experience_overhaul/history.jsonl',
      snapshot_root: 'state/ops/public_docs_developer_experience_overhaul/snapshots'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const quick = raw.quickstart_requirements && typeof raw.quickstart_requirements === 'object' ? raw.quickstart_requirements : {};
  const onboarding = raw.onboarding_check && typeof raw.onboarding_check === 'object' ? raw.onboarding_check : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const requiredLinks = Array.isArray(raw.required_links) && raw.required_links.length
    ? raw.required_links
    : base.required_links;

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    feature_flag_name: cleanText(raw.feature_flag_name || base.feature_flag_name, 120) || base.feature_flag_name,
    feature_flag_default: toBool(raw.feature_flag_default, base.feature_flag_default),
    required_docs: Array.isArray(raw.required_docs) && raw.required_docs.length
      ? raw.required_docs.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : base.required_docs,
    required_links: requiredLinks
      .map((row: AnyObj) => ({
        source: cleanText(row && row.source, 260),
        target: cleanText(row && row.target, 260)
      }))
      .filter((row: AnyObj) => row.source && row.target),
    quickstart_requirements: {
      path: resolvePath(quick.path, base.quickstart_requirements.path),
      required_phrases: Array.isArray(quick.required_phrases) && quick.required_phrases.length
        ? quick.required_phrases.map((v: unknown) => cleanText(v, 120).toLowerCase()).filter(Boolean)
        : base.quickstart_requirements.required_phrases
    },
    onboarding_check: {
      script: resolvePath(onboarding.script, base.onboarding_check.script),
      args: Array.isArray(onboarding.args) && onboarding.args.length
        ? onboarding.args.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
        : base.onboarding_check.args
    },
    paths: {
      feature_flags_path: resolvePath(paths.feature_flags_path, base.paths.feature_flags_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      snapshot_root: resolvePath(paths.snapshot_root, base.paths.snapshot_root)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadFlags(flagsPath: string, flagName: string, defaultValue: boolean) {
  const row = readJson(flagsPath, {});
  if (!row || typeof row !== 'object') return { [flagName]: defaultValue };
  if (!Object.prototype.hasOwnProperty.call(row, flagName)) row[flagName] = defaultValue;
  return row;
}

function saveFlags(flagsPath: string, flags: AnyObj) {
  writeJsonAtomic(flagsPath, flags);
}

function runOnboardingCheck(policy: AnyObj) {
  if (!fs.existsSync(policy.onboarding_check.script)) {
    return {
      ok: false,
      status: 1,
      reason: 'onboarding_script_missing',
      script: policy.onboarding_check.script
    };
  }

  const proc = spawnSync(process.execPath, [policy.onboarding_check.script, ...(policy.onboarding_check.args || [])], {
    cwd: ROOT,
    encoding: 'utf8'
  });

  return {
    ok: Number(proc.status || 0) === 0,
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    script: policy.onboarding_check.script
  };
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'public_docs_developer_experience_overhaul',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const missingDocs = policy.required_docs
    .map((docRel: string) => ({ rel: docRel, abs: path.join(ROOT, docRel) }))
    .filter((row: AnyObj) => !fs.existsSync(row.abs))
    .map((row: AnyObj) => row.rel);

  const missingLinks: AnyObj[] = [];
  for (const row of policy.required_links) {
    const srcPath = path.join(ROOT, row.source);
    const src = readText(srcPath);
    if (!src.includes(row.target)) {
      missingLinks.push({ source: row.source, target: row.target });
    }
  }

  const quickstartText = readText(policy.quickstart_requirements.path).toLowerCase();
  const missingQuickstartPhrases = (policy.quickstart_requirements.required_phrases || [])
    .filter((phrase: string) => !quickstartText.includes(String(phrase || '').toLowerCase()));

  const onboarding = runOnboardingCheck(policy);
  const flags = loadFlags(policy.paths.feature_flags_path, policy.feature_flag_name, policy.feature_flag_default);
  const featureGatePresent = Object.prototype.hasOwnProperty.call(flags, policy.feature_flag_name);

  const checks = {
    required_docs_present: missingDocs.length === 0,
    required_links_present: missingLinks.length === 0,
    quickstart_contract_present: missingQuickstartPhrases.length === 0,
    onboarding_check_pass: onboarding.ok,
    feature_gate_present: featureGatePresent
  };

  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'public_docs_developer_experience_overhaul',
    lane_id: 'V4-UX-003',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_docs: missingDocs,
    missing_links: missingLinks,
    missing_quickstart_phrases: missingQuickstartPhrases,
    onboarding_check: {
      ok: onboarding.ok,
      status: onboarding.status,
      script: rel(onboarding.script)
    },
    feature_flag: {
      name: policy.feature_flag_name,
      enabled: toBool(flags[policy.feature_flag_name], false)
    },
    rollback: {
      snapshot_command: `node systems/ops/public_docs_developer_experience_overhaul.js snapshot --label=rollback_anchor --policy=${rel(policy.policy_path)}`,
      compatibility_mode: 'link_redirect_compatible'
    },
    verification_receipt_id: `docs_dx_${stableHash(JSON.stringify({ missingDocs, missingLinks, missingQuickstartPhrases, onboarding: onboarding.ok }), 14)}`
  };
}

function copyFile(absSrc: string, absDst: string) {
  fs.mkdirSync(path.dirname(absDst), { recursive: true });
  fs.copyFileSync(absSrc, absDst);
}

function cmdSnapshot(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const label = cleanText(args.label || 'snapshot', 80).replace(/[^a-zA-Z0-9_.-]+/g, '_');
  const tsKey = nowIso().replace(/[:]/g, '-');
  const snapshotDir = path.join(policy.paths.snapshot_root, `${tsKey}_${label}`);

  const copied: string[] = [];
  for (const relPath of policy.required_docs) {
    const absSrc = path.join(ROOT, relPath);
    if (!fs.existsSync(absSrc)) continue;
    const absDst = path.join(snapshotDir, relPath);
    copyFile(absSrc, absDst);
    copied.push(relPath);
  }

  const out = {
    ok: true,
    type: 'public_docs_developer_experience_overhaul_snapshot',
    ts: nowIso(),
    lane_id: 'V4-UX-003',
    snapshot_id: `docs_snapshot_${stableHash(`${snapshotDir}|${copied.join(',')}`, 14)}`,
    snapshot_dir: rel(snapshotDir),
    copied_docs: copied
  };

  appendJsonl(policy.paths.history_path, out);
  emit(out, 0);
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
    type: 'public_docs_developer_experience_overhaul_toggle',
    ts: nowIso(),
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
    type: 'public_docs_developer_experience_overhaul_toggle',
    ts: nowIso(),
    feature_flag: policy.feature_flag_name,
    enabled: false,
    flags_path: rel(policy.paths.feature_flags_path),
    flags
  }, 0);
}

function cmdVerify(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, true);
  const out = verify(policy);

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    blocking_checks: out.blocking_checks
  });

  emit({
    ...out,
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.paths.latest_path)
  }, out.ok || !strict ? 0 : 1);
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const flags = loadFlags(policy.paths.feature_flags_path, policy.feature_flag_name, policy.feature_flag_default);
  emit({
    ok: true,
    type: 'public_docs_developer_experience_overhaul_status',
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
  if (cmd === 'snapshot') return cmdSnapshot(args);
  if (cmd === 'enable') return cmdEnable(args);
  if (cmd === 'disable') return cmdDisable(args);
  if (cmd === 'status') return cmdStatus(args);

  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();
