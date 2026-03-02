#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-SCI-004
 * Scientific mode integration + launch-safe feature flag.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sciLoop = require('./scientific_method_loop.js');
const forge = require('./hypothesis_forge.js');
const mirror = require('./reasoning_mirror.js');

type AnyObj = Record<string, any>;

const ROOT = process.env.SCI_MODE_V4_ROOT
  ? path.resolve(process.env.SCI_MODE_V4_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.SCI_MODE_V4_POLICY_PATH
  ? path.resolve(process.env.SCI_MODE_V4_POLICY_PATH)
  : path.join(ROOT, 'config', 'scientific_mode_v4_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 360) {
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

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function stableHash(v: unknown, len = 18) {
  return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    scientific_mode_v4: false,
    gates: {
      research: true,
      weaver: true,
      redteam: true
    },
    strict_gate_enforcement: true,
    fallback_mode: 'legacy_research_lane',
    paths: {
      latest_path: 'state/science/scientific_mode_v4/latest.json',
      history_path: 'state/science/scientific_mode_v4/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const gatesRaw = raw.gates && typeof raw.gates === 'object' ? raw.gates : {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    scientific_mode_v4: raw.scientific_mode_v4 === true,
    gates: {
      research: gatesRaw.research !== false,
      weaver: gatesRaw.weaver !== false,
      redteam: gatesRaw.redteam !== false
    },
    strict_gate_enforcement: raw.strict_gate_enforcement !== false,
    fallback_mode: cleanText(raw.fallback_mode || base.fallback_mode, 120) || base.fallback_mode,
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      history_path: resolvePath(paths.history_path, base.paths.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function evaluateGates(policy: AnyObj) {
  const checks = [
    { id: 'research', pass: policy.gates.research === true },
    { id: 'weaver', pass: policy.gates.weaver === true },
    { id: 'redteam', pass: policy.gates.redteam === true }
  ];
  return {
    checks,
    failed: checks.filter((c) => !c.pass).map((c) => c.id),
    ok: checks.every((c) => c.pass)
  };
}

function runIntegratedScientificMode(input: AnyObj, policy: AnyObj) {
  if (policy.scientific_mode_v4 !== true) {
    return {
      ok: true,
      type: 'scientific_mode_v4_run',
      result: 'flag_disabled_fallback',
      fallback_mode: policy.fallback_mode,
      scientific_mode_v4: false,
      receipts: []
    };
  }

  const gates = evaluateGates(policy);
  if (policy.strict_gate_enforcement === true && gates.ok !== true) {
    return {
      ok: false,
      type: 'scientific_mode_v4_run',
      error: 'integration_gates_failed',
      failed_gates: gates.failed,
      scientific_mode_v4: true
    };
  }

  const loopPolicy = sciLoop.loadPolicy();
  const loopPayload = sciLoop.runScientificLoop(input, loopPolicy);
  if (!loopPayload || loopPayload.ok !== true) {
    return {
      ok: false,
      type: 'scientific_mode_v4_run',
      error: 'scientific_loop_failed',
      details: loopPayload
    };
  }

  const forgePolicy = forge.loadPolicy();
  const ranked = forge.rankHypotheses([
    {
      id: `hyp_${stableHash(loopPayload.run_id, 8)}`,
      text: cleanText(input.hypothesis, 2000),
      prior: 0.6,
      voi: 0.7,
      disconfirm_value: 0.65,
      risk: 0.25
    }
  ], forgePolicy);
  const forgePayload = {
    ok: true,
    type: 'hypothesis_forge_rank',
    ts: nowIso(),
    count: ranked.length,
    top_hypothesis: ranked.length ? ranked[0] : null,
    ranked
  };

  const mirrorContract = mirror.buildMirrorContract(forgePayload, loopPayload);
  const runReceiptId = `sci_mode_${stableHash(JSON.stringify({ loop: loopPayload.receipt_id, mirror: mirrorContract.receipt_linkage }), 14)}`;

  return {
    ok: true,
    type: 'scientific_mode_v4_run',
    ts: nowIso(),
    scientific_mode_v4: true,
    result: 'integrated_scientific_flow_executed',
    gates,
    receipts: [loopPayload.receipt_id, ranked[0] ? ranked[0].rank_receipt_id : null].filter(Boolean),
    run_receipt_id: runReceiptId,
    loop: loopPayload,
    forge: forgePayload,
    mirror: mirrorContract
  };
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
    observation: cleanText(args.observation, 2200),
    question: cleanText(args.question, 2200),
    hypothesis: cleanText(args.hypothesis, 2200),
    prediction: cleanText(args.prediction, 2200),
    experiment: {},
    observed_outcome: {
      effect_size: Number(args.effect_size || 0),
      p_value: Number(args.p_value || 0.5),
      sample_size: Number(args.sample_size || 0)
    }
  };

  const out = runIntegratedScientificMode(input, policy);
  const payload = {
    ...out,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.paths.latest_path, payload);
  appendJsonl(policy.paths.history_path, {
    ts: nowIso(),
    type: 'scientific_mode_v4_run',
    ok: payload.ok === true,
    scientific_mode_v4: payload.scientific_mode_v4 === true,
    result: cleanText(payload.result, 120) || null,
    run_receipt_id: cleanText(payload.run_receipt_id, 80) || null
  });

  return payload;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'scientific_mode_v4_status',
    latest: readJson(policy.paths.latest_path, null),
    latest_path: rel(policy.paths.latest_path),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/science/scientific_mode_v4.js run --observation="..." --question="..." --hypothesis="..." --prediction="..." [--effect_size=0.1 --p_value=0.04 --sample_size=200] [--policy=<path>]');
  console.log('  node systems/science/scientific_mode_v4.js status [--policy=<path>]');
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
      : cmd === 'status'
        ? cmdStatus(args)
        : null;
    if (!out) {
      usage();
      process.exit(2);
    }
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (cmd === 'run' && out.ok !== true) process.exit(1);
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
  evaluateGates,
  runIntegratedScientificMode,
  cmdRun,
  cmdStatus
};
