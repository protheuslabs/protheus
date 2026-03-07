#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-CLEAN-004
 * Root scaffolding rationalization with contract-first moves.
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

const DEFAULT_POLICY_PATH = process.env.ROOT_SCAFFOLDING_RATIONALIZATION_POLICY_PATH
  ? path.resolve(process.env.ROOT_SCAFFOLDING_RATIONALIZATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'root_scaffolding_rationalization_policy.json');

const CLASSES = new Set(['runtime_required', 'docs_required', 'internal_only']);

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/root_scaffolding_rationalization.js run [--apply=0|1] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/root_scaffolding_rationalization.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    scaffold_dirs: {
      drafts: 'docs_required',
      notes: 'docs_required',
      patches: 'runtime_required',
      research: 'runtime_required'
    },
    internal_target_dir: '.internal/root_scaffolds',
    move_internal_on_apply: false,
    root_contract_script: 'systems/ops/root_surface_contract.js',
    docs_contract_script: 'systems/ops/docs_surface_contract.js',
    data_scope_doc_path: 'docs/DATA_SCOPE_BOUNDARIES.md',
    require_data_scope_reference: '.internal/',
    paths: {
      latest_path: 'state/ops/root_scaffolding_rationalization/latest.json',
      history_path: 'state/ops/root_scaffolding_rationalization/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const dirs = raw.scaffold_dirs && typeof raw.scaffold_dirs === 'object' ? raw.scaffold_dirs : {};

  const scaffoldDirs: Record<string, string> = {};
  for (const [dir, klassRaw] of Object.entries(dirs)) {
    const name = cleanText(dir, 120);
    const klass = cleanText(klassRaw, 80).toLowerCase();
    if (!name) continue;
    scaffoldDirs[name] = CLASSES.has(klass) ? klass : 'internal_only';
  }
  if (!Object.keys(scaffoldDirs).length) {
    Object.assign(scaffoldDirs, base.scaffold_dirs);
  }

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    scaffold_dirs: scaffoldDirs,
    internal_target_dir: cleanText(raw.internal_target_dir || base.internal_target_dir, 260) || base.internal_target_dir,
    move_internal_on_apply: toBool(raw.move_internal_on_apply, base.move_internal_on_apply),
    root_contract_script: resolvePath(raw.root_contract_script, base.root_contract_script),
    docs_contract_script: resolvePath(raw.docs_contract_script, base.docs_contract_script),
    data_scope_doc_path: resolvePath(raw.data_scope_doc_path, base.data_scope_doc_path),
    require_data_scope_reference: cleanText(raw.require_data_scope_reference || base.require_data_scope_reference, 120),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function runContractCheck(scriptPath: string) {
  if (!fs.existsSync(scriptPath)) {
    return {
      ok: false,
      status: 1,
      payload: null,
      reason: 'script_missing',
      script_path: scriptPath
    };
  }

  const proc = spawnSync(process.execPath, [scriptPath, 'check', '--strict=1'], {
    cwd: ROOT,
    encoding: 'utf8'
  });

  const parsePayload = () => {
    const text = String(proc.stdout || '').trim();
    if (!text) return null;
    try { return JSON.parse(text); } catch {}
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try { return JSON.parse(lines[i]); } catch {}
    }
    return null;
  };

  const payload = parsePayload();
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    payload,
    script_path: scriptPath
  };
}

function safeMove(fromAbs: string, toAbs: string) {
  fs.mkdirSync(path.dirname(toAbs), { recursive: true });
  fs.renameSync(fromAbs, toAbs);
}

function runRationalization(args: AnyObj, policy: AnyObj) {
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'root_scaffolding_rationalization',
      ts: nowIso(),
      result: 'disabled_by_policy'
    };
  }

  const apply = toBool(args.apply, false);
  const moveInternal = apply && toBool(args.move_internal != null ? args.move_internal : policy.move_internal_on_apply, false);
  const entries: AnyObj[] = [];
  const pendingInternalMoves: AnyObj[] = [];
  const moved: AnyObj[] = [];

  for (const [dirName, classification] of Object.entries(policy.scaffold_dirs)) {
    const absPath = path.join(ROOT, dirName);
    const exists = fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();

    const row: AnyObj = {
      dir: dirName,
      classification,
      exists,
      path: dirName
    };

    if (classification === 'internal_only' && exists) {
      const targetRel = path.join(policy.internal_target_dir, `${dirName}_${Date.now()}`);
      const targetAbs = path.join(ROOT, targetRel);
      row.internal_target = targetRel.replace(/\\/g, '/');

      if (moveInternal) {
        safeMove(absPath, targetAbs);
        row.moved = true;
        moved.push({ from: dirName, to: row.internal_target });
      } else {
        row.moved = false;
        pendingInternalMoves.push({ dir: dirName, target: row.internal_target });
      }
    }

    entries.push(row);
  }

  const classCoverageOk = entries.every((row) => CLASSES.has(String(row.classification || '')));
  const internalPlacementOk = pendingInternalMoves.length === 0;

  const rootContract = runContractCheck(policy.root_contract_script);
  const docsContract = runContractCheck(policy.docs_contract_script);

  const scopeDoc = fs.existsSync(policy.data_scope_doc_path)
    ? String(fs.readFileSync(policy.data_scope_doc_path, 'utf8') || '')
    : '';
  const dataScopeReferenceOk = !policy.require_data_scope_reference
    || scopeDoc.includes(policy.require_data_scope_reference);

  const checks = {
    classification_complete: classCoverageOk,
    internal_only_moved_or_absent: internalPlacementOk,
    root_surface_contract_pass: rootContract.ok,
    docs_surface_contract_pass: docsContract.ok,
    data_scope_reference_present: dataScopeReferenceOk
  };

  const blockingChecks = Object.entries(checks).filter(([, ok]) => ok !== true).map(([id]) => id);
  const pass = blockingChecks.length === 0;

  return {
    ok: pass,
    pass,
    type: 'root_scaffolding_rationalization',
    lane_id: 'V4-CLEAN-004',
    ts: nowIso(),
    apply,
    move_internal: moveInternal,
    checks,
    blocking_checks: blockingChecks,
    entries,
    pending_internal_moves: pendingInternalMoves,
    moved,
    receipts: {
      root_contract: {
        ok: rootContract.ok,
        status: rootContract.status,
        script_path: rel(rootContract.script_path)
      },
      docs_contract: {
        ok: docsContract.ok,
        status: docsContract.status,
        script_path: rel(docsContract.script_path)
      }
    },
    rationalization_receipt_id: `root_scaffold_${stableHash(JSON.stringify({ entries, checks, moved }), 14)}`
  };
}

function cmdRun(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, true);
  const out = runRationalization(args, policy);

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    ok: out.ok,
    apply: out.apply,
    move_internal: out.move_internal,
    blocking_checks: out.blocking_checks,
    moved_count: Array.isArray(out.moved) ? out.moved.length : 0,
    pending_internal_moves: Array.isArray(out.pending_internal_moves) ? out.pending_internal_moves.length : 0
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
  emit({
    ok: true,
    type: 'root_scaffolding_rationalization_status',
    ts: nowIso(),
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

  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);

  usage();
  emit({ ok: false, error: `unknown_command:${cmd}` }, 2);
}

main();
