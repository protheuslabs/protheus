#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-160
 * Collective intelligence integration contract check.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.COLLECTIVE_INTELLIGENCE_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.COLLECTIVE_INTELLIGENCE_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'collective_intelligence_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/collective_intelligence_contract_check.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/collective_intelligence_contract_check.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    required_docs: ['docs/ECONOMY.md', 'docs/INTELLIGENCE.md', 'docs/DATA_SCOPE_BOUNDARIES.md'],
    lanes: [
      { id: 'V3-RACE-153', module_path: 'systems/training/collective_training_orchestrator.ts', policy_path: 'config/collective_training_orchestrator_policy.json', user_paths: ['memory/training/contributions', 'adaptive/training/contributions'] },
      { id: 'V3-RACE-154', module_path: 'systems/training/training_contribution_contracts.ts', policy_path: 'config/training_contribution_contract_policy.json', user_paths: ['memory/training/contracts', 'adaptive/training/contracts'] },
      { id: 'V3-RACE-155', module_path: 'systems/training/fractal_training_oversight.ts', policy_path: 'config/fractal_training_oversight_policy.json', user_paths: ['memory/training/preferences', 'adaptive/training/curriculum'] },
      { id: 'V3-RACE-156', module_path: 'systems/training/sovereign_model_rollout_ladder.ts', policy_path: 'config/sovereign_model_rollout_policy.json', user_paths: ['memory/training/rollout_preferences', 'adaptive/training/rollout'] },
      { id: 'V3-RACE-157', module_path: 'systems/training/model_artifact_archive.ts', policy_path: 'config/model_artifact_archive_policy.json', user_paths: ['memory/training/artifact_access', 'adaptive/training/artifacts'] },
      { id: 'V3-RACE-158', module_path: 'systems/economy/training_contributor_incentive_engine.ts', policy_path: 'config/training_contributor_incentive_policy.json', user_paths: ['memory/economy/training_rewards', 'adaptive/economy/training_rewards'] },
      { id: 'V3-RACE-159', module_path: 'systems/economy/model_access_tier_governance.ts', policy_path: 'config/model_access_tier_policy.json', user_paths: ['memory/economy/model_access', 'adaptive/economy/model_access'] }
    ],
    paths: {
      latest_path: 'state/ops/collective_intelligence_contract_check/latest.json',
      receipts_path: 'state/ops/collective_intelligence_contract_check/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    required_docs: Array.isArray(raw.required_docs) ? raw.required_docs : base.required_docs,
    lanes: Array.isArray(raw.lanes) ? raw.lanes : base.lanes,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function hasCodeFileUnder(relDir: string) {
  const absDir = path.join(ROOT, relDir);
  if (!fs.existsSync(absDir)) return false;
  const stack = [absDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    const rows = fs.readdirSync(cur, { withFileTypes: true });
    for (const row of rows) {
      const abs = path.join(cur, row.name);
      if (row.isDirectory()) stack.push(abs);
      else if (row.name.endsWith('.ts') || row.name.endsWith('.js')) return true;
    }
  }
  return false;
}

function validateLane(row: any) {
  const moduleExists = fs.existsSync(path.join(ROOT, String(row.module_path || '')));
  const policyExists = fs.existsSync(path.join(ROOT, String(row.policy_path || '')));
  const lanePolicy = policyExists ? readJson(path.join(ROOT, String(row.policy_path)), {}) : {};
  const eventStream = lanePolicy && lanePolicy.event_stream && typeof lanePolicy.event_stream === 'object' ? lanePolicy.event_stream : {};
  const risk = lanePolicy && lanePolicy.risk && typeof lanePolicy.risk === 'object' ? lanePolicy.risk : {};
  const userPathCodeViolations = (Array.isArray(row.user_paths) ? row.user_paths : []).filter((relDir: string) => hasCodeFileUnder(String(relDir)));
  return {
    id: String(row.id || 'unknown'),
    ok: moduleExists && policyExists && eventStream.publish === true && Number(risk.require_explicit_approval_tier || 0) >= 3 && userPathCodeViolations.length === 0,
    module_exists: moduleExists,
    policy_exists: policyExists,
    event_stream_publish: eventStream.publish === true,
    risk_gate_ok: Number(risk.require_explicit_approval_tier || 0) >= 3,
    user_path_code_violations: userPathCodeViolations
  };
}

function runCheck(policy: any, strict: boolean) {
  const missingDocs = (policy.required_docs || [])
    .map((doc: unknown) => String(doc || ''))
    .filter(Boolean)
    .filter((doc: string) => !fs.existsSync(path.join(ROOT, doc)));
  const lanes = (policy.lanes || []).map((row: any) => validateLane(row));
  const laneFailures = lanes.filter((row: any) => row.ok !== true);

  const checks = {
    docs_present: missingDocs.length === 0,
    lane_contracts_ok: laneFailures.length === 0
  };
  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([name]) => name);
  const pass = blocking.length === 0;
  const out = {
    ok: strict ? pass : true,
    pass,
    strict,
    type: 'collective_intelligence_contract_check',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    details: {
      missing_docs: missingDocs,
      lanes
    }
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();
  if (args.help || cmd === '--help' || cmd === 'help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (cmd === 'status') {
    return emit(readJson(policy.paths.latest_path, {
      ok: true,
      type: 'collective_intelligence_contract_check',
      status: 'no_status'
    }), 0);
  }
  if (cmd !== 'check') {
    usage();
    return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
  }
  const strict = toBool(args.strict, true);
  const out = runCheck(policy, strict);
  return emit(out, out.ok ? 0 : 1);
}

main();
