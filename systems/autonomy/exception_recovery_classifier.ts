#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-037
 * Exception novelty classifier + deterministic recovery policy lane.
 *
 * Usage:
 *   node systems/autonomy/exception_recovery_classifier.js record --stage=<id> --error-code=<id> --error-message="..." [--context-json="{...}"] [--strict=1|0]
 *   node systems/autonomy/exception_recovery_classifier.js status
 */

const fs = require('fs');
const path = require('path');
const tier1 = require('./tier1_governance.js');

type AnyObj = Record<string, any>;

const ROOT = process.env.EXCEPTION_CLASSIFIER_ROOT
  ? path.resolve(process.env.EXCEPTION_CLASSIFIER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.EXCEPTION_CLASSIFIER_POLICY_PATH
  ? path.resolve(process.env.EXCEPTION_CLASSIFIER_POLICY_PATH)
  : path.join(ROOT, 'config', 'exception_recovery_classifier_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function countJsonlRows(filePath: string) {
  if (!fs.existsSync(filePath)) return 0;
  return String(fs.readFileSync(filePath, 'utf8') || '').split(/\r?\n/).filter(Boolean).length;
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseJsonArg(raw: unknown, fallback: any = null) {
  const txt = cleanText(raw, 20_000);
  if (!txt) return fallback;
  try {
    return JSON.parse(txt);
  } catch {
    return fallback;
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    recovery_policy_path: 'config/autonomy_exception_recovery_policy.json',
    memory_path: 'state/autonomy/exception_classifier/memory.json',
    telemetry_path: 'state/autonomy/exception_classifier/telemetry.jsonl',
    escalation_path: 'state/autonomy/human_escalation_queue.jsonl',
    outputs: {
      latest_path: 'state/autonomy/exception_classifier/latest.json',
      history_path: 'state/autonomy/exception_classifier/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    recovery_policy_path: resolvePath(raw.recovery_policy_path, base.recovery_policy_path),
    memory_path: resolvePath(raw.memory_path, base.memory_path),
    telemetry_path: resolvePath(raw.telemetry_path, base.telemetry_path),
    escalation_path: resolvePath(raw.escalation_path, base.escalation_path),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function cmdRecord(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      strict,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const stage = cleanText(args.stage || 'unknown', 80) || 'unknown';
  const errorCode = cleanText(args['error-code'] || args.error_code || 'unknown', 120) || 'unknown';
  const errorMessage = cleanText(args['error-message'] || args.error_message || 'unknown_error', 1200) || 'unknown_error';
  const context = parseJsonArg(args['context-json'] || args.context_json || '', {});

  const tracked = tier1.classifyAndRecordException({
    dateStr: nowIso().slice(0, 10),
    stage,
    errorCode,
    errorMessage,
    context,
    memoryPath: policy.memory_path,
    auditPath: policy.telemetry_path
  });

  const recovery = tier1.exceptionRecoveryDecision({
    tracked,
    policyPath: policy.recovery_policy_path
  });

  const telemetry = {
    ts: nowIso(),
    type: 'autonomy_exception_recovery',
    stage,
    error_code: errorCode,
    signature: tracked.signature || null,
    novel: tracked.novel === true,
    count: Number(tracked.count || 0),
    action: recovery.action,
    cooldown_hours: Number(recovery.cooldown_hours || 0),
    playbook: recovery.playbook,
    should_escalate: recovery.should_escalate === true,
    reason: recovery.reason,
    context: context && typeof context === 'object' ? context : {}
  };
  appendJsonl(policy.telemetry_path, telemetry);

  if (recovery.should_escalate === true) {
    appendJsonl(policy.escalation_path, {
      ts: telemetry.ts,
      type: 'autonomy_human_escalation',
      source: 'exception_recovery_classifier',
      signature: tracked.signature || null,
      stage,
      error_code: errorCode,
      playbook: recovery.playbook,
      cooldown_hours: Number(recovery.cooldown_hours || 0),
      reason: recovery.reason
    });
  }

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'exception_recovery_classifier',
    strict,
    tracked,
    recovery,
    telemetry,
    telemetry_path: rel(policy.telemetry_path),
    escalation_path: rel(policy.escalation_path),
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    stage,
    error_code: errorCode,
    novel: tracked.novel === true,
    action: recovery.action,
    cooldown_hours: Number(recovery.cooldown_hours || 0),
    playbook: recovery.playbook,
    should_escalate: recovery.should_escalate === true,
    ok: true
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const memory = readJson(policy.memory_path, { signatures: {} });
  const signatures = memory && memory.signatures && typeof memory.signatures === 'object' ? memory.signatures : {};
  return {
    ok: true,
    ts: nowIso(),
    type: 'exception_recovery_classifier_status',
    policy_path: rel(policy.policy_path),
    memory_path: rel(policy.memory_path),
    telemetry_path: rel(policy.telemetry_path),
    escalation_path: rel(policy.escalation_path),
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    summary: {
      signature_count: Object.keys(signatures).length,
      telemetry_rows: countJsonlRows(policy.telemetry_path),
      escalation_rows: countJsonlRows(policy.escalation_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/exception_recovery_classifier.js record --stage=<id> --error-code=<id> --error-message="..." [--context-json="{...}"] [--strict=1|0]');
  console.log('  node systems/autonomy/exception_recovery_classifier.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'record').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  try {
    const payload = cmd === 'record'
      ? cmdRecord(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'exception_recovery_classifier_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  cmdRecord,
  cmdStatus
};
