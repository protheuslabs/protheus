#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-SCI-001
 * Scientific method core primitive.
 *
 * observe -> question -> hypothesize -> predict -> experiment -> analyze -> conclude -> iterate
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.SCI_LOOP_ROOT
  ? path.resolve(process.env.SCI_LOOP_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SCI_LOOP_POLICY_PATH
  ? path.resolve(process.env.SCI_LOOP_POLICY_PATH)
  : path.join(ROOT, 'config', 'scientific_method_loop_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 400) {
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

function parseJsonArg(raw: unknown, fallback: any = null) {
  const txt = String(raw == null ? '' : raw).trim();
  if (!txt) return fallback;
  try { return JSON.parse(txt); } catch { return fallback; }
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableHash(v: unknown, len = 24) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_contracts: true,
    minimum_lengths: {
      observation: 10,
      question: 8,
      hypothesis: 8,
      prediction: 8
    },
    paths: {
      latest_path: 'state/science/loop/latest.json',
      history_path: 'state/science/loop/history.jsonl',
      runs_dir: 'state/science/loop/runs',
      replay_latest_path: 'state/science/loop/replay_latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const minRaw = raw.minimum_lengths && typeof raw.minimum_lengths === 'object' ? raw.minimum_lengths : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    strict_contracts: raw.strict_contracts !== false,
    minimum_lengths: {
      observation: Math.max(1, Number(minRaw.observation || base.minimum_lengths.observation)),
      question: Math.max(1, Number(minRaw.question || base.minimum_lengths.question)),
      hypothesis: Math.max(1, Number(minRaw.hypothesis || base.minimum_lengths.hypothesis)),
      prediction: Math.max(1, Number(minRaw.prediction || base.minimum_lengths.prediction))
    },
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      runs_dir: resolvePath(paths.runs_dir, base.paths.runs_dir),
      replay_latest_path: resolvePath(paths.replay_latest_path, base.paths.replay_latest_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function validateInputs(input: AnyObj, policy: AnyObj) {
  const obs = cleanText(input.observation, 4000);
  const q = cleanText(input.question, 4000);
  const h = cleanText(input.hypothesis, 4000);
  const p = cleanText(input.prediction, 4000);
  const errors: string[] = [];

  if (obs.length < Number(policy.minimum_lengths.observation || 1)) errors.push('observation_too_short');
  if (q.length < Number(policy.minimum_lengths.question || 1)) errors.push('question_too_short');
  if (h.length < Number(policy.minimum_lengths.hypothesis || 1)) errors.push('hypothesis_too_short');
  if (p.length < Number(policy.minimum_lengths.prediction || 1)) errors.push('prediction_too_short');

  return {
    ok: errors.length === 0,
    errors,
    normalized: {
      observation: obs,
      question: q,
      hypothesis: h,
      prediction: p,
      experiment: input.experiment && typeof input.experiment === 'object' ? input.experiment : {},
      observed_outcome: input.observed_outcome && typeof input.observed_outcome === 'object' ? input.observed_outcome : {}
    }
  };
}

function runScientificLoop(input: AnyObj, policy: AnyObj) {
  const v = validateInputs(input, policy);
  if (!v.ok && policy.strict_contracts === true) {
    return {
      ok: false,
      error: 'contract_validation_failed',
      contract_errors: v.errors
    };
  }

  const n = v.normalized;
  const runId = `sci_${nowIso().replace(/[-:.TZ]/g, '').slice(0, 14)}_${stableHash(`${n.observation}|${n.question}`, 8)}`;
  const ts = nowIso();
  const steps = [
    { id: 'observe', input: { observation: n.observation }, output: { signal_count: Math.max(1, n.observation.split(' ').length) } },
    { id: 'question', input: { question: n.question }, output: { question_type: /why|how/i.test(n.question) ? 'causal' : 'descriptive' } },
    { id: 'hypothesize', input: { hypothesis: n.hypothesis }, output: { falsifiable: /if|then|because|will/i.test(n.hypothesis) } },
    { id: 'predict', input: { prediction: n.prediction }, output: { confidence: 0.62 } },
    { id: 'experiment', input: n.experiment, output: { experiment_defined: Object.keys(n.experiment).length > 0 } },
    { id: 'analyze', input: n.observed_outcome, output: { effect_size: Number(n.observed_outcome.effect_size || 0), p_value: Number(n.observed_outcome.p_value || 0.5) } },
    {
      id: 'conclude',
      input: {},
      output: {
        supported: Number(n.observed_outcome.effect_size || 0) > 0 && Number(n.observed_outcome.p_value || 1) <= 0.05,
        evidence_strength: Number(n.observed_outcome.p_value || 1) <= 0.05 ? 'strong' : 'weak'
      }
    },
    {
      id: 'iterate',
      input: {},
      output: {
        next_experiment: n.observed_outcome.p_value && Number(n.observed_outcome.p_value) <= 0.05
          ? 'replicate_with_new_sample'
          : 'collect_more_signal_and_refine_hypothesis'
      }
    }
  ];

  const signatureBase = JSON.stringify({ run_id: runId, ts, steps });
  const receiptId = `sci_rcpt_${stableHash(signatureBase, 18)}`;
  const signature = stableHash(`${receiptId}:${signatureBase}`, 32);

  const payload = {
    ok: true,
    ts,
    type: 'scientific_method_loop',
    run_id: runId,
    receipt_id: receiptId,
    signature,
    contract_errors: v.errors,
    strict_contracts: policy.strict_contracts === true,
    steps
  };

  return payload;
}

function writeRunArtifacts(payload: AnyObj, policy: AnyObj) {
  const runPath = path.join(policy.paths.runs_dir, `${payload.run_id}.json`);
  writeJsonAtomic(runPath, payload);
  writeJsonAtomic(policy.paths.latest_path, {
    ...payload,
    run_path: rel(runPath)
  });
  appendJsonl(policy.paths.history_path, {
    ts: payload.ts,
    type: payload.type,
    run_id: payload.run_id,
    receipt_id: payload.receipt_id,
    signature: payload.signature,
    ok: payload.ok,
    run_path: rel(runPath)
  });
  return runPath;
}

function cmdRun(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const input = {
    observation: args.observation,
    question: args.question,
    hypothesis: args.hypothesis,
    prediction: args.prediction,
    experiment: parseJsonArg(args['experiment-json'] || args.experiment_json, {}),
    observed_outcome: parseJsonArg(args['outcome-json'] || args.outcome_json, {})
  };

  const payload = runScientificLoop(input, policy);
  if (payload.ok !== true) return payload;
  const runPath = writeRunArtifacts(payload, policy);
  return {
    ...payload,
    run_path: rel(runPath),
    policy_path: rel(policy.policy_path)
  };
}

function cmdReplay(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const runPathRaw = cleanText(args['run-file'] || args.run_file, 520);
  if (!runPathRaw) {
    return { ok: false, error: 'missing --run-file' };
  }
  const runPath = path.isAbsolute(runPathRaw) ? runPathRaw : path.join(ROOT, runPathRaw);
  const payload = readJson(runPath, null);
  if (!payload || typeof payload !== 'object') return { ok: false, error: 'run_file_missing_or_invalid' };

  const signatureBase = JSON.stringify({ run_id: payload.run_id, ts: payload.ts, steps: payload.steps });
  const expectedReceiptId = `sci_rcpt_${stableHash(signatureBase, 18)}`;
  const expectedSignature = stableHash(`${expectedReceiptId}:${signatureBase}`, 32);
  const ok = expectedReceiptId === String(payload.receipt_id || '') && expectedSignature === String(payload.signature || '');

  const out = {
    ok,
    ts: nowIso(),
    type: 'scientific_method_replay_check',
    run_file: rel(runPath),
    expected_receipt_id: expectedReceiptId,
    expected_signature: expectedSignature,
    actual_receipt_id: String(payload.receipt_id || null),
    actual_signature: String(payload.signature || null)
  };

  writeJsonAtomic(policy.paths.replay_latest_path, out);
  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'scientific_method_loop_status',
    latest: readJson(policy.paths.latest_path, null),
    latest_path: rel(policy.paths.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/science/scientific_method_loop.js run --observation="..." --question="..." --hypothesis="..." --prediction="..." [--experiment-json="{}"] [--outcome-json="{}"] [--policy=<path>]');
  console.log('  node systems/science/scientific_method_loop.js replay --run-file=<path> [--policy=<path>]');
  console.log('  node systems/science/scientific_method_loop.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'run'
      ? cmdRun(args)
      : cmd === 'replay'
        ? cmdReplay(args)
        : cmd === 'status'
          ? cmdStatus(args)
          : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (cmd === 'replay' && out.ok !== true) process.exit(1);
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText(err && err.message ? err.message : err, 420) }, null, 2)}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runScientificLoop,
  validateInputs,
  cmdRun,
  cmdReplay,
  cmdStatus
};
