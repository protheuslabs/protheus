#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-005 + V3-OBS-002 implementation lane */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, normalizeToken, toBool, readJson, readJsonl,
  writeJsonAtomic, appendJsonl, resolvePath, stableHash, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.THOUGHT_ACTION_TRACE_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.THOUGHT_ACTION_TRACE_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'thought_action_trace_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/observability/thought_action_trace_contract.js append --trace_id=<id> --request_id=<id> --run_id=<id> --job_id=<id> --stage=<id> --outcome=<id>');
  console.log('  node systems/observability/thought_action_trace_contract.js verify [--strict=1]');
  console.log('  node systems/observability/thought_action_trace_contract.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    paths: {
      trace_path: 'state/observability/thought_action_trace.jsonl',
      latest_path: 'state/observability/thought_action_trace_latest.json',
      receipts_path: 'state/observability/thought_action_trace_receipts.jsonl'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    paths: {
      trace_path: resolvePath(paths.trace_path, base.paths.trace_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function appendTrace(args: any, p: any) {
  const traceId = normalizeToken(args.trace_id || `trace_${Date.now()}`, 120);
  const reqId = normalizeToken(args.request_id || `req_${Date.now()}`, 120);
  const runId = normalizeToken(args.run_id || `run_${Date.now()}`, 120);
  const jobId = normalizeToken(args.job_id || `job_${Date.now()}`, 120);
  const stage = normalizeToken(args.stage || 'intent', 80);
  const outcome = normalizeToken(args.outcome || 'ok', 80);

  const row = {
    ts: nowIso(),
    trace_id: traceId,
    request_id: reqId,
    run_id: runId,
    job_id: jobId,
    stage,
    outcome,
    signature: stableHash(`${traceId}|${reqId}|${runId}|${jobId}|${stage}|${outcome}`, 24)
  };
  appendJsonl(p.paths.trace_path, row);

  const out = { ts: nowIso(), type: 'thought_action_trace_append', ok: true, shadow_only: p.shadow_only, ...row };
  writeJsonAtomic(p.paths.latest_path, out);
  appendJsonl(p.paths.receipts_path, out);
  return out;
}

function verify(args: any, p: any) {
  const strict = toBool(args.strict, false);
  const rows = readJsonl(p.paths.trace_path).slice(-5000);
  const complete = rows.filter((row: any) => row.trace_id && row.request_id && row.run_id && row.job_id).length;
  const coverage = rows.length > 0 ? Number((complete / rows.length).toFixed(6)) : 0;
  const out = {
    ts: nowIso(),
    type: 'thought_action_trace_verify',
    ok: strict ? coverage >= 0.95 : true,
    strict,
    coverage,
    rows: rows.length,
    shadow_only: p.shadow_only
  };
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
  if (!p.enabled) emit({ ok: false, error: 'thought_action_trace_contract_disabled' }, 1);
  if (cmd === 'append') emit(appendTrace(args, p));
  if (cmd === 'verify') emit(verify(args, p));
  if (cmd === 'status') emit({ ok: true, type: 'thought_action_trace_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
