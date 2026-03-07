#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-136
 * Data-scope boundary contract check for economy/identity integration lanes.
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

const DEFAULT_POLICY_PATH = process.env.DATA_SCOPE_BOUNDARY_POLICY_PATH
  ? path.resolve(process.env.DATA_SCOPE_BOUNDARY_POLICY_PATH)
  : path.join(ROOT, 'config', 'data_scope_boundary_policy.json');

type AnyObj = Record<string, any>;

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/data_scope_boundary_check.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/data_scope_boundary_check.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    require_user_dirs: false,
    required_docs: [
      'docs/ECONOMY.md',
      'docs/IDENTITY.md',
      'docs/DATA_SCOPE_BOUNDARIES.md'
    ],
    lanes: [
      {
        id: 'V3-RACE-129',
        system_files: ['systems/contracts/soul_contracts.ts', 'config/soul_contracts_policy.json'],
        user_paths: ['memory/contracts', 'adaptive/contracts']
      },
      {
        id: 'V3-RACE-130',
        system_files: ['systems/economy/protheus_token_engine.ts', 'systems/economy/global_directive_fund.ts'],
        user_paths: ['memory/economy/preferences', 'adaptive/economy/preferences']
      },
      {
        id: 'V3-RACE-131',
        system_files: ['systems/spawn/seed_spawn_lineage.ts', 'systems/spawn/spawn_broker.ts'],
        user_paths: ['memory/lineage', 'adaptive/lineage']
      },
      {
        id: 'V3-RACE-132',
        system_files: ['systems/autonomy/civic_duty_allocation_engine.ts'],
        user_paths: ['memory/civic_duty', 'adaptive/civic_duty']
      },
      {
        id: 'V3-RACE-133',
        system_files: ['systems/economy/peer_lending_market.ts', 'systems/economy/gpu_contribution_tracker.ts'],
        user_paths: ['memory/economy/peer_lending', 'adaptive/economy/peer_lending']
      },
      {
        id: 'V3-RACE-134',
        system_files: ['systems/identity/visual_signature_engine.ts'],
        user_paths: ['memory/identity/signature', 'adaptive/identity/signature']
      },
      {
        id: 'V3-RACE-135',
        system_files: ['systems/research/pinnacle_tech_integration_engine.ts'],
        user_paths: ['memory/research/preferences', 'adaptive/research/preferences']
      }
    ],
    touchpoints: {
      required_files: [
        'systems/symbiosis/soul_vector_substrate.ts',
        'systems/economy/tithe_engine.ts',
        'systems/spawn/spawn_broker.ts',
        'systems/security/guard.ts',
        'systems/fractal/engine.ts',
        'systems/fractal/warden/complexity_warden_meta_organ.ts',
        'systems/security/jigsaw/attackcinema_replay_theater.ts'
      ]
    },
    paths: {
      latest_path: 'state/ops/data_scope_boundary_check/latest.json',
      receipts_path: 'state/ops/data_scope_boundary_check/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const touchpoints = raw.touchpoints && typeof raw.touchpoints === 'object' ? raw.touchpoints : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    require_user_dirs: toBool(raw.require_user_dirs, base.require_user_dirs),
    required_docs: Array.isArray(raw.required_docs) ? raw.required_docs : base.required_docs,
    lanes: Array.isArray(raw.lanes) ? raw.lanes : base.lanes,
    touchpoints: {
      required_files: Array.isArray(touchpoints.required_files)
        ? touchpoints.required_files
        : base.touchpoints.required_files
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function hasCodeFileUnder(absDir: string) {
  if (!fs.existsSync(absDir)) return false;
  const stack = [absDir];
  while (stack.length > 0) {
    const cur = stack.pop();
    const rows = fs.readdirSync(cur, { withFileTypes: true });
    for (const row of rows) {
      const abs = path.join(cur, row.name);
      if (row.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (row.name.endsWith('.ts') || row.name.endsWith('.js')) {
        return true;
      }
    }
  }
  return false;
}

function checkLane(policy: AnyObj, lane: AnyObj) {
  const id = cleanText(lane.id || 'unknown', 80) || 'unknown';
  const files = Array.isArray(lane.system_files) ? lane.system_files : [];
  const userPaths = Array.isArray(lane.user_paths) ? lane.user_paths : [];
  const missingSystemFiles = files
    .map((file: unknown) => String(file || ''))
    .filter(Boolean)
    .filter((relPath: string) => !fs.existsSync(path.join(ROOT, relPath)));
  const missingUserDirs = userPaths
    .map((dir: unknown) => String(dir || ''))
    .filter(Boolean)
    .filter((relDir: string) => policy.require_user_dirs && !fs.existsSync(path.join(ROOT, relDir)));

  const userCodeViolations = userPaths
    .map((dir: unknown) => String(dir || ''))
    .filter(Boolean)
    .filter((relDir: string) => hasCodeFileUnder(path.join(ROOT, relDir)));

  return {
    lane_id: id,
    ok: missingSystemFiles.length === 0
      && missingUserDirs.length === 0
      && userCodeViolations.length === 0,
    missing_system_files: missingSystemFiles,
    missing_user_dirs: missingUserDirs,
    user_code_violations: userCodeViolations
  };
}

function runCheck(policy: AnyObj, strict: boolean) {
  const docMissing = (policy.required_docs || [])
    .map((file: unknown) => String(file || ''))
    .filter(Boolean)
    .filter((relPath: string) => !fs.existsSync(path.join(ROOT, relPath)));
  const touchpointMissing = (policy.touchpoints.required_files || [])
    .map((file: unknown) => String(file || ''))
    .filter(Boolean)
    .filter((relPath: string) => !fs.existsSync(path.join(ROOT, relPath)));

  const lanes = (policy.lanes || []).map((lane: AnyObj) => checkLane(policy, lane));
  const laneFailures = lanes.filter((lane: AnyObj) => lane.ok !== true);

  const checks = {
    docs_present: docMissing.length === 0,
    touchpoints_present: touchpointMissing.length === 0,
    lane_scope_contracts_pass: laneFailures.length === 0
  };
  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([name]) => name);
  const pass = blocking.length === 0;
  const out = {
    ok: strict ? pass : true,
    pass,
    strict,
    type: 'data_scope_boundary_check',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    details: {
      missing_docs: docMissing,
      missing_touchpoint_files: touchpointMissing,
      lane_results: lanes
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
      type: 'data_scope_boundary_check',
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
