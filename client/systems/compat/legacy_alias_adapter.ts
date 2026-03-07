#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  stableHash,
  appendJsonl,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');

type AliasSpec = {
  alias_rel: string;
  target_rel: string;
};

function resolveStatePaths() {
  const receipts = process.env.LEGACY_ALIAS_ADAPTER_RECEIPTS_PATH
    ? path.resolve(process.env.LEGACY_ALIAS_ADAPTER_RECEIPTS_PATH)
    : path.join(ROOT, 'state', 'ops', 'legacy_path_alias_adapters', 'receipts.jsonl');
  const latest = process.env.LEGACY_ALIAS_ADAPTER_LATEST_PATH
    ? path.resolve(process.env.LEGACY_ALIAS_ADAPTER_LATEST_PATH)
    : path.join(ROOT, 'state', 'ops', 'legacy_path_alias_adapters', 'latest.json');
  return { receipts, latest };
}

function writeAliasReceipt(spec: AliasSpec, exitCode: number, targetExists: boolean, errorMessage = '') {
  const statePaths = resolveStatePaths();
  const row = {
    ts: nowIso(),
    type: 'legacy_path_alias_adapter',
    alias_path: spec.alias_rel,
    target_path: spec.target_rel,
    argv: process.argv.slice(2),
    exit_code: exitCode,
    target_exists: targetExists,
    deprecated: true,
    deprecation_reason: 'legacy_path_alias_adapter_forward',
    adapter_id: `alias_${stableHash(`${spec.alias_rel}|${spec.target_rel}`, 16)}`,
    error: String(errorMessage || '').slice(0, 600)
  };
  appendJsonl(statePaths.receipts, row);
  writeJsonAtomic(statePaths.latest, {
    schema_id: 'legacy_path_alias_adapter_latest',
    schema_version: '1.0',
    ...row
  });
}

function runLegacyAlias(spec: AliasSpec) {
  const targetAbs = path.join(ROOT, spec.target_rel);
  if (!fs.existsSync(targetAbs)) {
    writeAliasReceipt(spec, 1, false, 'target_missing');
    process.stdout.write(`${JSON.stringify({
      ok: false,
      error: 'legacy_alias_target_missing',
      alias_path: spec.alias_rel,
      target_path: spec.target_rel
    }, null, 2)}\n`);
    process.exit(1);
  }

  const proc = spawnSync('node', [targetAbs].concat(process.argv.slice(2)), {
    cwd: ROOT,
    env: process.env,
    encoding: 'utf8'
  });

  if (proc.stdout) process.stdout.write(String(proc.stdout));
  if (proc.stderr) process.stderr.write(String(proc.stderr));

  const exitCode = Number.isFinite(Number(proc.status)) ? Number(proc.status) : 1;
  const err = proc.error ? String(proc.error.message || proc.error) : '';
  writeAliasReceipt(spec, exitCode, true, err);
  process.exit(exitCode);
}

module.exports = {
  runLegacyAlias
};
