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
  normalizeToken,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('./queued_backlog_runtime');

function normalizeCheck(row, idx) {
  const id = normalizeToken((row && row.id) || (row && row.name) || ('check_' + String(idx + 1)), 120) || ('check_' + String(idx + 1));
  const description = cleanText((row && row.description) || (row && row.desc) || id, 400) || id;
  const fileMustExistRaw = cleanText((row && row.file_must_exist) || '', 520);
  return {
    id,
    description,
    required: row && row.required !== false,
    file_must_exist: fileMustExistRaw || ''
  };
}

function normalizeChecks(raw) {
  const src = Array.isArray(raw) ? raw : [];
  const out = src.map(normalizeCheck).filter((row) => !!row.id);
  if (out.length > 0) return out;
  return [
    {
      id: 'baseline_contract',
      description: 'Baseline lane contract is satisfiable',
      required: true,
      file_must_exist: ''
    }
  ];
}

function normalizePolicy(opts, policyPath, raw) {
  const base = opts.default_policy && typeof opts.default_policy === 'object' ? opts.default_policy : {};
  const merged = {
    ...base,
    ...(raw && typeof raw === 'object' ? raw : {})
  };
  const pathsRaw = merged.paths && typeof merged.paths === 'object' ? merged.paths : {};
  const basePaths = base.paths && typeof base.paths === 'object' ? base.paths : {};
  const laneType = normalizeToken(opts.type || 'lane', 80) || 'lane';
  const statePathRaw = cleanText(pathsRaw.state_path || basePaths.state_path || ('state/ops/' + laneType + '/state.json'), 520);
  const latestPathRaw = cleanText(pathsRaw.latest_path || basePaths.latest_path || ('state/ops/' + laneType + '/latest.json'), 520);
  const receiptsPathRaw = cleanText(pathsRaw.receipts_path || basePaths.receipts_path || ('state/ops/' + laneType + '/receipts.jsonl'), 520);
  const historyPathRaw = cleanText(pathsRaw.history_path || basePaths.history_path || ('state/ops/' + laneType + '/history.jsonl'), 520);

  return {
    version: cleanText(merged.version || base.version || '1.0', 32) || '1.0',
    enabled: merged.enabled !== false,
    strict_default: toBool(merged.strict_default, true),
    checks: normalizeChecks(merged.checks),
    paths: {
      state_path: resolvePath(statePathRaw, statePathRaw),
      latest_path: resolvePath(latestPathRaw, latestPathRaw),
      receipts_path: resolvePath(receiptsPathRaw, receiptsPathRaw),
      history_path: resolvePath(historyPathRaw, historyPathRaw)
    },
    policy_path: path.resolve(policyPath)
  };
}

function loadState(policy) {
  const src = readJson(policy.paths.state_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'backlog_lane_state_v1',
      schema_version: '1.0',
      run_count: 0,
      last_action: null,
      last_ok: null,
      last_ts: null
    };
  }
  return {
    schema_id: 'backlog_lane_state_v1',
    schema_version: '1.0',
    run_count: Math.max(0, Number(src.run_count || 0)),
    last_action: src.last_action ? cleanText(src.last_action, 80) : null,
    last_ok: typeof src.last_ok === 'boolean' ? src.last_ok : null,
    last_ts: src.last_ts ? cleanText(src.last_ts, 80) : null
  };
}

function parseList(raw) {
  if (Array.isArray(raw)) return raw.map((row) => normalizeToken(row, 120)).filter(Boolean);
  const txt = cleanText(raw || '', 5000);
  if (!txt) return [];
  return txt.split(',').map((row) => normalizeToken(row, 120)).filter(Boolean);
}

function evaluateChecks(policy, failSet) {
  const rows = [];
  for (const check of policy.checks) {
    const fileRequired = cleanText(check.file_must_exist || '', 520);
    const absFile = fileRequired
      ? (path.isAbsolute(fileRequired) ? fileRequired : path.join(ROOT, fileRequired))
      : '';
    const fileOk = absFile ? fs.existsSync(absFile) : true;
    const pass = !failSet.has(check.id) && fileOk;
    rows.push({
      id: check.id,
      description: check.description,
      required: check.required !== false,
      pass,
      reason: pass ? 'ok' : (!fileOk ? 'required_file_missing' : 'forced_failure'),
      file_checked: absFile ? path.relative(ROOT, absFile).replace(/\\/g, '/') : null
    });
  }
  return rows;
}

function usage(opts) {
  const label = opts.script_label || '<lane>.js';
  console.log('Usage:');
  console.log('  node ' + label + ' run [--policy=<path>] [--strict=1|0] [--apply=1|0] [--fail-checks=a,b]');
  console.log('  node ' + label + ' status [--policy=<path>]');
  console.log('  node ' + label + ' <action> [--policy=<path>] [--strict=1|0] [--apply=1|0] [--fail-checks=a,b]');
}

function runLaneCli(opts) {
  const args = parseArgs(process.argv.slice(2));
  const action = normalizeToken(args._[0] || opts.default_action || 'run', 80) || 'run';
  if (args.help || action === 'help') {
    usage(opts);
    emit({ ok: true, type: cleanText(opts.type || 'backlog_lane', 120), action: 'help', ts: nowIso() }, 0);
  }

  const policyPath = args.policy
    ? path.resolve(String(args.policy))
    : path.resolve(String(opts.policy_path || ''));
  const rawPolicy = readJson(policyPath, {});
  const policy = normalizePolicy(opts, policyPath, rawPolicy);

  if (policy.enabled === false) {
    emit({
      ok: false,
      type: cleanText(opts.type || 'backlog_lane', 120),
      lane_id: cleanText(opts.lane_id || '', 120),
      action,
      ts: nowIso(),
      error: 'lane_disabled',
      policy_path: path.relative(ROOT, policy.policy_path).replace(/\\/g, '/')
    }, 2);
  }

  if (action === 'status') {
    const latest = readJson(policy.paths.latest_path, null);
    const state = loadState(policy);
    emit({
      ok: !!latest,
      type: cleanText(opts.type || 'backlog_lane', 120),
      lane_id: cleanText(opts.lane_id || '', 120),
      action,
      ts: nowIso(),
      latest,
      state,
      policy_path: path.relative(ROOT, policy.policy_path).replace(/\\/g, '/')
    }, latest ? 0 : 2);
  }

  const strict = toBool(args.strict, policy.strict_default);
  const apply = toBool(args.apply, true);
  const failSet = new Set(parseList(args['fail-checks'] || args.fail_checks));
  const checks = evaluateChecks(policy, failSet);
  const requiredChecks = checks.filter((row) => row.required !== false);
  const failedChecks = requiredChecks.filter((row) => !row.pass).map((row) => row.id);
  const ok = failedChecks.length === 0;

  const state = loadState(policy);
  const nextState = {
    ...state,
    run_count: Math.max(0, Number(state.run_count || 0)) + 1,
    last_action: action,
    last_ok: ok,
    last_ts: nowIso()
  };

  const out = {
    ok,
    type: cleanText(opts.type || 'backlog_lane', 120),
    lane_id: cleanText(opts.lane_id || '', 120),
    title: cleanText(opts.title || '', 260),
    action,
    ts: nowIso(),
    strict,
    apply,
    checks,
    check_count: checks.length,
    failed_checks: failedChecks,
    policy_version: policy.version,
    policy_path: path.relative(ROOT, policy.policy_path).replace(/\\/g, '/'),
    state: nextState
  };

  if (apply) {
    writeJsonAtomic(policy.paths.state_path, nextState);
    writeJsonAtomic(policy.paths.latest_path, out);
    appendJsonl(policy.paths.receipts_path, out);
    appendJsonl(policy.paths.history_path, {
      ts: out.ts,
      action,
      ok,
      failed_checks: failedChecks
    });
  }

  emit(out, ok || !strict ? 0 : 2);
}

module.exports = {
  runLaneCli
};
