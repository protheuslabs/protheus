#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-008 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, cleanText, normalizeToken, toBool,
  readJson, writeJsonAtomic, appendJsonl, resolvePath, stableHash, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.SOUL_VECTOR_SUBSTRATE_POLICY_PATH
  ? path.resolve(process.env.SOUL_VECTOR_SUBSTRATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'soul_vector_substrate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/symbiosis/soul_vector_substrate.js refresh');
  console.log('  node systems/symbiosis/soul_vector_substrate.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    paths: {
      substrate_path: 'state/symbiosis/soul_vector/substrate.json',
      latest_path: 'state/symbiosis/soul_vector/latest.json',
      receipts_path: 'state/symbiosis/soul_vector/receipts.jsonl',
      identity_path: 'IDENTITY.md',
      constitution_path: 'AGENT-CONSTITUTION.md'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    paths: {
      substrate_path: resolvePath(paths.substrate_path, base.paths.substrate_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      identity_path: resolvePath(paths.identity_path, base.paths.identity_path),
      constitution_path: resolvePath(paths.constitution_path, base.paths.constitution_path)
    }
  };
}

function readTextSafe(filePath: string) {
  try { return String(require('fs').readFileSync(filePath, 'utf8') || ''); } catch { return ''; }
}

function refresh(p: any) {
  const identity = readTextSafe(p.paths.identity_path);
  const constitution = readTextSafe(p.paths.constitution_path);
  const vector = {
    schema_version: '1.0',
    updated_at: nowIso(),
    identity_hash: stableHash(identity, 32),
    constitution_hash: stableHash(constitution, 32),
    continuity_fingerprint: stableHash(`${identity}|${constitution}`, 40),
    encrypted_payload_ref: 'local://state/symbiosis/soul_vector/encrypted_payload.bin',
    migration_compatible: true
  };
  writeJsonAtomic(p.paths.substrate_path, vector);
  const out = { ts: nowIso(), type: 'soul_vector_refresh', ok: true, shadow_only: p.shadow_only, ...vector };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'soul_vector_substrate_disabled' }, 1);
  if (cmd === 'refresh') emit(refresh(p));
  if (cmd === 'status') emit({ ok: true, type: 'soul_vector_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
