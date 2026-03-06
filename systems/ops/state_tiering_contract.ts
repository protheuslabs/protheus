#!/usr/bin/env node
'use strict';
export {};

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

const DEFAULT_POLICY_PATH = process.env.STATE_TIER_MANIFEST_PATH
  ? path.resolve(process.env.STATE_TIER_MANIFEST_PATH)
  : path.join(ROOT, 'config', 'state_tier_manifest.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/state_tiering_contract.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/state_tiering_contract.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    hot_runtime: [],
    audit_mirror: [],
    paths: {
      latest_path: 'state/ops/state_tiering_contract/latest.json',
      receipts_path: 'state/ops/state_tiering_contract/receipts.jsonl'
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
    hot_runtime: Array.isArray(raw.hot_runtime) ? raw.hot_runtime : base.hot_runtime,
    audit_mirror: Array.isArray(raw.audit_mirror) ? raw.audit_mirror : base.audit_mirror,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function isJsonArtifact(relPath: string) {
  return /\.(json|jsonl)$/i.test(relPath || '');
}

function hotLaneCheck(row: any) {
  const authorityRel = cleanText(row && row.authority, 260);
  const id = cleanText(row && row.id, 80);
  const paths = Array.isArray(row && row.paths) ? row.paths.map((v: unknown) => cleanText(v, 260)).filter(Boolean) : [];
  const authorityAbs = authorityRel ? path.join(ROOT, authorityRel) : '';
  const authorityExists = authorityAbs ? fs.existsSync(authorityAbs) : false;
  const artifactReadPaths = paths.filter((p: string) => isJsonArtifact(p));

  return {
    id,
    authority: authorityRel,
    authority_exists: authorityExists,
    paths,
    artifact_read_paths: artifactReadPaths,
    valid: authorityExists && artifactReadPaths.length === 0
  };
}

function auditLaneCheck(row: any) {
  const id = cleanText(row && row.id, 80);
  const paths = Array.isArray(row && row.paths) ? row.paths.map((v: unknown) => cleanText(v, 260)).filter(Boolean) : [];
  const missing: string[] = [];
  const nonAuditPath: string[] = [];

  for (const relPath of paths) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      missing.push(relPath);
      continue;
    }
    const stat = fs.statSync(abs);
    if (stat.isFile() && !/\.jsonl$/i.test(relPath)) {
      nonAuditPath.push(relPath);
    }
  }

  return {
    id,
    paths,
    missing,
    non_audit_path: nonAuditPath,
    valid: nonAuditPath.length === 0
  };
}

function runCheck(policy: any, strict: boolean) {
  const hotChecks = policy.hot_runtime.map(hotLaneCheck);
  const auditChecks = policy.audit_mirror.map(auditLaneCheck);

  const hotInvalid = hotChecks.filter((row: any) => row.valid !== true);
  const auditInvalid = auditChecks.filter((row: any) => row.valid !== true);

  const stateKernelLatest = readJson(path.join(ROOT, 'state', 'ops', 'state_kernel', 'latest.json'), null);
  const eventStreamExists = fs.existsSync(path.join(ROOT, 'state', 'events', 'event_stream.jsonl'));
  const replaySignal = {
    state_kernel_latest_exists: !!stateKernelLatest,
    event_stream_exists: eventStreamExists,
    parity_sample_available: !!stateKernelLatest && eventStreamExists
  };

  const checks = {
    hot_runtime_declared: hotChecks.length > 0,
    no_hot_runtime_artifact_reads: hotInvalid.length === 0,
    audit_paths_are_append_mirror: auditInvalid.length === 0,
    replay_signal_evaluated: true
  };

  const blocking = Object.entries(checks).filter(([, ok]) => ok !== true).map(([k]) => k);
  const pass = blocking.length === 0;
  const ok = strict ? pass : true;

  const out = {
    ok,
    pass,
    strict,
    type: 'state_tiering_contract',
    ts: nowIso(),
    checks,
    blocking_checks: blocking,
    counts: {
      hot_runtime: hotChecks.length,
      hot_invalid: hotInvalid.length,
      audit_mirror: auditChecks.length,
      audit_invalid: auditInvalid.length
    },
    replay_signal: replaySignal,
    advisories: {
      replay_signal_available: replaySignal.parity_sample_available
    },
    hot_invalid: hotInvalid,
    audit_invalid: auditInvalid
  };

  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'check').toLowerCase();

  if (args.help || cmd === 'help' || cmd === '--help') {
    usage();
    return emit({ ok: true, help: true }, 0);
  }

  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (cmd === 'status') {
    return emit(readJson(policy.paths.latest_path, {
      ok: true,
      type: 'state_tiering_contract',
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
