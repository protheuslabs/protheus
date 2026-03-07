#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-ERR-012
 * Human-friendly failure messaging + deterministic guided recovery.
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

const DEFAULT_POLICY_PATH = process.env.GUIDED_RECOVERY_UX_POLICY_PATH
  ? path.resolve(process.env.GUIDED_RECOVERY_UX_POLICY_PATH)
  : path.join(ROOT, 'config', 'guided_recovery_error_ux_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/guided_recovery_error_ux.js verify [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/guided_recovery_error_ux.js explain --reason=<code> [--human=1] [--policy=<path>]');
  console.log('  node systems/ops/guided_recovery_error_ux.js enable [--policy=<path>]');
  console.log('  node systems/ops/guided_recovery_error_ux.js disable [--policy=<path>]');
  console.log('  node systems/ops/guided_recovery_error_ux.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    feature_flag_name: 'guided_recovery_ux',
    feature_flag_default: false,
    catalog_path: 'config/guided_recovery_error_catalog.json',
    required_reason_codes: [
      'integration_gates_failed',
      'scientific_loop_failed',
      'channel_revoked',
      'approval_required_for_risk_tier',
      'root_surface_contract_failed'
    ],
    paths: {
      feature_flags_path: 'config/feature_flags.json',
      latest_path: 'state/ops/guided_recovery_error_ux/latest.json',
      history_path: 'state/ops/guided_recovery_error_ux/history.jsonl'
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
    catalog_path: resolvePath(raw.catalog_path, base.catalog_path),
    required_reason_codes: Array.isArray(raw.required_reason_codes) && raw.required_reason_codes.length
      ? raw.required_reason_codes.map((v: unknown) => cleanText(v, 120)).filter(Boolean)
      : base.required_reason_codes,
    paths: {
      feature_flags_path: resolvePath(paths.feature_flags_path, base.paths.feature_flags_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadFlags(flagsPath: string, flagName: string, fallback: boolean) {
  const row = readJson(flagsPath, {});
  if (!row || typeof row !== 'object') return { [flagName]: fallback };
  if (!Object.prototype.hasOwnProperty.call(row, flagName)) row[flagName] = fallback;
  return row;
}

function saveFlags(flagsPath: string, row: AnyObj) {
  writeJsonAtomic(flagsPath, row);
}

function loadCatalog(policy: AnyObj) {
  const catalog = readJson(policy.catalog_path, {});
  const codes = catalog && catalog.codes && typeof catalog.codes === 'object' ? catalog.codes : {};
  return {
    version: cleanText(catalog.version || '1.0', 40) || '1.0',
    codes
  };
}

function verify(policy: AnyObj) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'guided_recovery_error_ux',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const catalog = loadCatalog(policy);
  const missingCodes: string[] = [];
  const malformedCodes: string[] = [];

  for (const code of policy.required_reason_codes) {
    if (!Object.prototype.hasOwnProperty.call(catalog.codes, code)) {
      missingCodes.push(code);
      continue;
    }
    const row = catalog.codes[code];
    const valid = row && typeof row === 'object'
      && cleanText(row.message, 400)
      && Array.isArray(row.suggestions) && row.suggestions.length > 0
      && cleanText(row.troubleshoot_command, 240);
    if (!valid) malformedCodes.push(code);
  }

  const flags = loadFlags(policy.paths.feature_flags_path, policy.feature_flag_name, policy.feature_flag_default);
  const checks = {
    catalog_present: fs.existsSync(policy.catalog_path),
    required_codes_present: missingCodes.length === 0,
    reason_codes_well_formed: malformedCodes.length === 0,
    feature_gate_present: Object.prototype.hasOwnProperty.call(flags, policy.feature_flag_name)
  };
  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'guided_recovery_error_ux',
    lane_id: 'V4-ERR-012',
    ts: nowIso(),
    checks,
    blocking_checks: blockingChecks,
    missing_codes: missingCodes,
    malformed_codes: malformedCodes,
    feature_flag: {
      name: policy.feature_flag_name,
      enabled: toBool(flags[policy.feature_flag_name], false)
    },
    verification_receipt_id: `guided_err_${stableHash(JSON.stringify({ missingCodes, malformedCodes }), 14)}`
  };
}

function explainReason(policy: AnyObj, reasonCodeRaw: unknown) {
  const code = cleanText(reasonCodeRaw, 160);
  const catalog = loadCatalog(policy);
  const row = catalog.codes[code];

  if (!row || typeof row !== 'object') {
    return {
      ok: true,
      type: 'guided_recovery_explain',
      lane_id: 'V4-ERR-012',
      ts: nowIso(),
      reason_code: code || 'unknown',
      message: 'Unknown error code. Run verification/status to gather current health evidence.',
      suggestions: [
        'Run strict lane verification for the failing subsystem.',
        'Inspect latest receipt artifact for deterministic reason codes.'
      ],
      troubleshoot_command: 'node systems/ops/guided_recovery_error_ux.js verify --strict=1',
      known_code: false,
      explain_receipt_id: `guided_explain_${stableHash(code || 'unknown', 14)}`
    };
  }

  return {
    ok: true,
    type: 'guided_recovery_explain',
    lane_id: 'V4-ERR-012',
    ts: nowIso(),
    reason_code: code,
    message: cleanText(row.message, 500),
    suggestions: Array.isArray(row.suggestions)
      ? row.suggestions.map((v: unknown) => cleanText(v, 260)).filter(Boolean)
      : [],
    troubleshoot_command: cleanText(row.troubleshoot_command, 260),
    known_code: true,
    explain_receipt_id: `guided_explain_${stableHash(`${code}|${row.troubleshoot_command}`, 14)}`
  };
}

function printHuman(out: AnyObj) {
  console.log(`Reason: ${out.reason_code}`);
  console.log(out.message);
  const suggestions = Array.isArray(out.suggestions) ? out.suggestions : [];
  if (suggestions.length) {
    console.log('Suggestions:');
    for (const row of suggestions) console.log(`- ${row}`);
  }
  console.log(`One-click: ${out.troubleshoot_command}`);
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

function cmdExplain(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const out = explainReason(policy, args.reason || args.code || args.error);

  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    reason_code: out.reason_code,
    known_code: out.known_code
  });

  if (toBool(args.human, false) || cleanText(args.format, 40).toLowerCase() === 'human') {
    printHuman(out);
    process.exit(0);
    return;
  }

  emit({
    ...out,
    policy_path: rel(policy.policy_path)
  }, 0);
}

function setFlag(policy: AnyObj, enabled: boolean) {
  const flags = loadFlags(policy.paths.feature_flags_path, policy.feature_flag_name, policy.feature_flag_default);
  flags[policy.feature_flag_name] = enabled;
  saveFlags(policy.paths.feature_flags_path, flags);
  return flags;
}

function cmdEnable(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const flags = setFlag(policy, true);
  emit({ ok: true, type: 'guided_recovery_error_ux_toggle', feature_flag: policy.feature_flag_name, enabled: true, flags }, 0);
}

function cmdDisable(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const flags = setFlag(policy, false);
  emit({ ok: true, type: 'guided_recovery_error_ux_toggle', feature_flag: policy.feature_flag_name, enabled: false, flags }, 0);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const flags = loadFlags(policy.paths.feature_flags_path, policy.feature_flag_name, policy.feature_flag_default);
  emit({
    ok: true,
    type: 'guided_recovery_error_ux_status',
    ts: nowIso(),
    latest: readJson(policy.paths.latest_path, null),
    feature_flag: { name: policy.feature_flag_name, enabled: toBool(flags[policy.feature_flag_name], false) },
    policy_path: rel(policy.policy_path)
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
  if (cmd === 'explain') return cmdExplain(args);
  if (cmd === 'enable') return cmdEnable(args);
  if (cmd === 'disable') return cmdDisable(args);
  if (cmd === 'status') return cmdStatus(args);

  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();
