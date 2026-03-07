#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-SCI-003
 * Reasoning mirror lane contract for Phase-1 UI.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = process.env.REASONING_MIRROR_ROOT
  ? path.resolve(process.env.REASONING_MIRROR_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.REASONING_MIRROR_POLICY_PATH
  ? path.resolve(process.env.REASONING_MIRROR_POLICY_PATH)
  : path.join(ROOT, 'config', 'reasoning_mirror_policy.json');

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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableHash(v: unknown, len = 16) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    paths: {
      hypothesis_latest_path: 'state/science/hypothesis_forge/latest.json',
      loop_latest_path: 'state/science/loop/latest.json',
      latest_path: 'state/science/reasoning_mirror/latest.json',
      history_path: 'state/science/reasoning_mirror/history.jsonl',
      ui_contract_path: 'state/science/reasoning_mirror/ui_contract.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    paths: {
      hypothesis_latest_path: resolvePath(paths.hypothesis_latest_path, base.paths.hypothesis_latest_path),
      loop_latest_path: resolvePath(paths.loop_latest_path, base.paths.loop_latest_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path),
      ui_contract_path: resolvePath(paths.ui_contract_path, base.paths.ui_contract_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function confidenceIntervalFromScore(score: number) {
  const center = Number.isFinite(score) ? Math.max(0, Math.min(1, score)) : 0.5;
  const spread = 0.12;
  return {
    low: Number(Math.max(0, center - spread).toFixed(4)),
    high: Number(Math.min(1, center + spread).toFixed(4))
  };
}

function buildMirrorContract(forgeLatest: AnyObj, loopLatest: AnyObj) {
  const top = forgeLatest && forgeLatest.top_hypothesis && typeof forgeLatest.top_hypothesis === 'object'
    ? forgeLatest.top_hypothesis
    : (forgeLatest && Array.isArray(forgeLatest.ranked) && forgeLatest.ranked.length ? forgeLatest.ranked[0] : null);

  const analyzeStep = loopLatest && Array.isArray(loopLatest.steps)
    ? loopLatest.steps.find((s: AnyObj) => String(s && s.id) === 'analyze')
    : null;
  const iterateStep = loopLatest && Array.isArray(loopLatest.steps)
    ? loopLatest.steps.find((s: AnyObj) => String(s && s.id) === 'iterate')
    : null;
  const concludeStep = loopLatest && Array.isArray(loopLatest.steps)
    ? loopLatest.steps.find((s: AnyObj) => String(s && s.id) === 'conclude')
    : null;

  const score = Number(top && top.score);
  const confidenceInterval = confidenceIntervalFromScore(Number.isFinite(score) ? score : 0.5);
  const evidenceStrength = cleanText(
    concludeStep && concludeStep.output && concludeStep.output.evidence_strength
      ? concludeStep.output.evidence_strength
      : (score >= 0.6 ? 'moderate' : 'weak'),
    40
  ) || 'unknown';

  const disconfirmingTestsRun = Number(loopLatest && Array.isArray(loopLatest.steps)
    ? loopLatest.steps.filter((s: AnyObj) => String(s && s.id) === 'experiment').length
    : 0);

  const contract = {
    schema_id: 'reasoning_mirror_contract_v1',
    generated_at: nowIso(),
    active_hypothesis: {
      id: cleanText(top && top.id, 80) || null,
      text: cleanText(top && top.text, 2000) || null,
      score: Number.isFinite(score) ? Number(score.toFixed(6)) : null
    },
    confidence_interval: confidenceInterval,
    evidence_strength: evidenceStrength,
    key_statistical_outputs: {
      effect_size: Number(analyzeStep && analyzeStep.output && analyzeStep.output.effect_size || 0),
      p_value: Number(analyzeStep && analyzeStep.output && analyzeStep.output.p_value || 1),
      sample_size: Number(analyzeStep && analyzeStep.output && analyzeStep.output.sample_size || 0)
    },
    disconfirming_tests_run: disconfirmingTestsRun,
    next_experiment_suggestion: cleanText(iterateStep && iterateStep.output && iterateStep.output.next_experiment, 240)
      || 'collect_more_signal_and_refine_hypothesis',
    receipt_linkage: {
      source_receipt_ids: [
        cleanText(loopLatest && loopLatest.receipt_id, 120),
        cleanText(top && top.rank_receipt_id, 120)
      ].filter(Boolean),
      linkage_hash: stableHash(JSON.stringify({
        loop_receipt_id: cleanText(loopLatest && loopLatest.receipt_id, 120),
        hypothesis_receipt_id: cleanText(top && top.rank_receipt_id, 120)
      }), 20)
    }
  };

  return contract;
}

function cmdRender(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      result: 'disabled_by_policy',
      policy_path: rel(policy.policy_path)
    };
  }

  const hypothesisFile = cleanText(args['hypothesis-file'] || args.hypothesis_file, 520);
  const loopFile = cleanText(args['loop-file'] || args.loop_file, 520);
  const forgeLatest = readJson(hypothesisFile ? (path.isAbsolute(hypothesisFile) ? hypothesisFile : path.join(ROOT, hypothesisFile)) : policy.paths.hypothesis_latest_path, {});
  const loopLatest = readJson(loopFile ? (path.isAbsolute(loopFile) ? loopFile : path.join(ROOT, loopFile)) : policy.paths.loop_latest_path, {});

  const contract = buildMirrorContract(forgeLatest, loopLatest);
  const out = {
    ok: true,
    ts: nowIso(),
    type: 'reasoning_mirror_render',
    contract
  };

  writeJsonAtomic(policy.paths.ui_contract_path, contract);
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.history_path, {
    ts: out.ts,
    type: out.type,
    active_hypothesis_id: contract.active_hypothesis.id,
    source_receipt_ids: contract.receipt_linkage.source_receipt_ids
  });

  return {
    ...out,
    output_paths: {
      ui_contract_path: rel(policy.paths.ui_contract_path),
      latest_path: rel(policy.paths.latest_path)
    },
    policy_path: rel(policy.policy_path)
  };
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'reasoning_mirror_status',
    latest: readJson(policy.paths.latest_path, null),
    latest_path: rel(policy.paths.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/science/reasoning_mirror.js render [--hypothesis-file=<path>] [--loop-file=<path>] [--policy=<path>]');
  console.log('  node systems/science/reasoning_mirror.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || '', 80).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  try {
    const out = cmd === 'render'
      ? cmdRender(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
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
  buildMirrorContract,
  cmdRender,
  cmdStatus
};
