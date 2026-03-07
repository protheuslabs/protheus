#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-170
 * Spine kernel budget gate (<600 LOC, orchestration-only contract).
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.SPINE_KERNEL_BUDGET_POLICY_PATH
  ? path.resolve(process.env.SPINE_KERNEL_BUDGET_POLICY_PATH)
  : path.join(ROOT, 'config', 'spine_kernel_budget_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/spine_kernel_budget_check.js configure --owner=<owner_id> [--max-spine-loc=600]');
  console.log('  node systems/ops/spine_kernel_budget_check.js check [--strict=1|0]');
  console.log('  node systems/ops/spine_kernel_budget_check.js status');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_spine_loc: 600,
    forbidden_patterns: ['spawnSync(', 'execSync(', 'writeFileSync('],
    spine_entrypoints: ['systems/spine/spine.ts'],
    paths: {
      memory_pref_dir: 'memory/spine/preferences',
      adaptive_index_path: 'adaptive/spine/index.json',
      latest_path: 'state/ops/spine_kernel_budget_check/latest.json',
      receipts_path: 'state/ops/spine_kernel_budget_check/receipts.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    max_spine_loc: clampInt(raw.max_spine_loc, 50, 10000, base.max_spine_loc),
    forbidden_patterns: Array.isArray(raw.forbidden_patterns) ? raw.forbidden_patterns : base.forbidden_patterns,
    spine_entrypoints: Array.isArray(raw.spine_entrypoints) ? raw.spine_entrypoints : base.spine_entrypoints,
    paths: {
      memory_pref_dir: resolvePath(paths.memory_pref_dir, base.paths.memory_pref_dir),
      adaptive_index_path: resolvePath(paths.adaptive_index_path, base.paths.adaptive_index_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function ownerPath(policy: any, owner: string) {
  return path.join(policy.paths.memory_pref_dir, `${owner}.json`);
}

function configure(policy: any, args: any) {
  const owner = normalizeToken(args.owner || args.owner_id, 120);
  if (!owner) return { ok: false, error: 'missing_owner' };
  const maxSpineLoc = clampInt(args['max-spine-loc'] != null ? args['max-spine-loc'] : args.max_spine_loc, 50, 10000, policy.max_spine_loc);
  const row = {
    owner_id: owner,
    max_spine_loc: maxSpineLoc,
    updated_at: nowIso()
  };
  writeJsonAtomic(ownerPath(policy, owner), row);
  const adaptive = readJson(policy.paths.adaptive_index_path, { owners: [] });
  adaptive.owners = Array.isArray(adaptive.owners) ? adaptive.owners : [];
  adaptive.owners = adaptive.owners.filter((r: any) => String(r.owner_id) !== owner);
  adaptive.owners.push({
    owner_id: owner,
    preferred_max_spine_loc: maxSpineLoc,
    updated_at: row.updated_at
  });
  writeJsonAtomic(policy.paths.adaptive_index_path, adaptive);
  const out = {
    ok: true,
    type: 'spine_kernel_budget_configure',
    ts: nowIso(),
    owner_id: owner,
    max_spine_loc: maxSpineLoc
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function runCheck(policy: any, strict: boolean) {
  const rows = [];
  for (const relPath of policy.spine_entrypoints || []) {
    const abs = path.join(ROOT, String(relPath));
    const exists = fs.existsSync(abs);
    const source = exists ? fs.readFileSync(abs, 'utf8') : '';
    const loc = exists ? source.split('\n').length : 0;
    const forbiddenHits = (policy.forbidden_patterns || [])
      .map((pattern: string) => String(pattern))
      .filter((pattern: string) => source.includes(pattern));
    rows.push({
      entrypoint: relPath,
      exists,
      loc,
      loc_budget_ok: loc <= policy.max_spine_loc,
      forbidden_hits: forbiddenHits,
      forbidden_ok: forbiddenHits.length === 0
    });
  }
  const missing = rows.filter((row) => row.exists !== true).map((row) => row.entrypoint);
  const overBudget = rows.filter((row) => row.loc_budget_ok !== true).map((row) => ({ entrypoint: row.entrypoint, loc: row.loc }));
  const forbidden = rows.filter((row) => row.forbidden_ok !== true).map((row) => ({ entrypoint: row.entrypoint, hits: row.forbidden_hits }));
  const pass = missing.length === 0 && overBudget.length === 0 && forbidden.length === 0;
  const out = {
    ok: strict ? pass : true,
    pass,
    strict,
    type: 'spine_kernel_budget_check',
    ts: nowIso(),
    max_spine_loc: policy.max_spine_loc,
    checks: {
      entrypoints_exist: missing.length === 0,
      loc_budget: overBudget.length === 0,
      forbidden_surface: forbidden.length === 0
    },
    details: {
      missing_entrypoints: missing,
      over_budget: overBudget,
      forbidden_hits: forbidden,
      rows
    }
  };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function status(policy: any) {
  return readJson(policy.paths.latest_path, {
    ok: true,
    type: 'spine_kernel_budget_check',
    status: 'no_status'
  });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (args.help || cmd === '--help' || cmd === 'help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (cmd === 'configure') return emit(configure(policy, args), 0);
  if (cmd === 'check') {
    const out = runCheck(policy, toBool(args.strict, true));
    return emit(out, out.ok ? 0 : 1);
  }
  if (cmd === 'status') return emit(status(policy), 0);
  usage();
  return emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
