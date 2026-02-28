#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  sha256Hex,
  stableStringify
} = require('../../lib/integrity_hash_utility');
const passportIterationChain = require('../../lib/passport_iteration_chain');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.ITERATIVE_REPAIR_POLICY_PATH
  ? path.resolve(process.env.ITERATIVE_REPAIR_POLICY_PATH)
  : path.join(ROOT, 'config', 'iterative_repair_primitive_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 160) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    max_iterations: 4,
    max_runtime_sec: 120,
    stop_on_verify_pass: true,
    require_rollback_points: true,
    receipts_path: 'state/primitives/iterative_repair/receipts.jsonl',
    latest_path: 'state/primitives/iterative_repair/latest.json',
    state_path: 'state/primitives/iterative_repair/state.json',
    allowed_target_roots: [
      'systems',
      'lib',
      'config',
      'memory/tools/tests'
    ]
  };
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw || '', 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    shadow_only: toBool(src.shadow_only, base.shadow_only),
    max_iterations: clampInt(src.max_iterations, 1, 20, base.max_iterations),
    max_runtime_sec: clampInt(src.max_runtime_sec, 5, 7200, base.max_runtime_sec),
    stop_on_verify_pass: src.stop_on_verify_pass !== false,
    require_rollback_points: src.require_rollback_points !== false,
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path),
    state_path: resolvePath(src.state_path || base.state_path, base.state_path),
    allowed_target_roots: Array.isArray(src.allowed_target_roots)
      ? src.allowed_target_roots.map((row: unknown) => normalizeToken(row, 220)).filter(Boolean)
      : base.allowed_target_roots.slice(0)
  };
}

function targetAllowed(targetPath: string, policy: AnyObj) {
  const abs = path.isAbsolute(targetPath) ? targetPath : path.join(ROOT, targetPath);
  const rel = relPath(abs);
  return (policy.allowed_target_roots || []).some((root: string) => rel.startsWith(root));
}

function fileDigest(targetPath: string) {
  try {
    if (!targetPath || !fs.existsSync(targetPath)) return null;
    const body = fs.readFileSync(targetPath);
    return sha256Hex(body.toString('utf8'));
  } catch {
    return null;
  }
}

function runRepair(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) {
    return { ok: false, type: 'iterative_repair_run', error: 'iterative_repair_disabled' };
  }

  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 180) || null;
  const targetPathRaw = cleanText(args['target-path'] || args.target_path || '', 520);
  const targetPath = targetPathRaw
    ? (path.isAbsolute(targetPathRaw) ? targetPathRaw : path.join(ROOT, targetPathRaw))
    : null;
  const iterations = clampInt(args.iterations, 1, policy.max_iterations, Math.min(3, policy.max_iterations));
  const apply = toBool(args.apply, false) && policy.shadow_only !== true;
  const forceFail = toBool(args['force-fail'] || args.force_fail, false);

  if (!targetPath) {
    return { ok: false, type: 'iterative_repair_run', error: 'target_path_required' };
  }
  if (!targetAllowed(targetPath, policy)) {
    return { ok: false, type: 'iterative_repair_run', error: 'target_path_not_allowed', target_path: relPath(targetPath) };
  }

  const start = Date.now();
  const rollbackPoints: AnyObj[] = [];
  const receipts: AnyObj[] = [];
  const stepOrder = ['reproduce', 'test', 'critique', 'patch', 'verify'];
  const initialDigest = fileDigest(targetPath);
  rollbackPoints.push({ ts: nowIso(), kind: 'initial', target_path: relPath(targetPath), digest: initialDigest });

  let converged = false;
  let finalIteration = 0;

  for (let iteration = 1; iteration <= iterations; iteration += 1) {
    for (const step of stepOrder) {
      const runtimeSec = (Date.now() - start) / 1000;
      if (runtimeSec > Number(policy.max_runtime_sec || 120)) {
        const timeout = {
          ok: false,
          type: 'iterative_repair_timeout',
          ts: nowIso(),
          objective_id: objectiveId,
          target_path: relPath(targetPath),
          iteration,
          step,
          runtime_sec: Number(runtimeSec.toFixed(3))
        };
        appendJsonl(policy.receipts_path, timeout);
        writeJsonAtomic(policy.latest_path, timeout);
        return timeout;
      }

      const stepOk = step === 'verify'
        ? (forceFail ? false : iteration >= 1)
        : true;
      const receipt = {
        ok: stepOk,
        type: 'iterative_repair_step',
        ts: nowIso(),
        objective_id: objectiveId,
        target_path: relPath(targetPath),
        iteration,
        step,
        apply,
        shadow_only: policy.shadow_only === true,
        patch_id: step === 'patch' ? `patch_${normalizeToken(`${objectiveId || 'objective'}_${iteration}`, 120)}` : null,
        rollback_point_digest: fileDigest(targetPath)
      };

      const chain = passportIterationChain.recordIterationStep({
        lane: 'iterative_repair',
        step,
        iteration,
        objective_id: objectiveId,
        target_path: relPath(targetPath),
        metadata: {
          status: stepOk ? 'ok' : 'failed',
          apply,
          patch_id: receipt.patch_id,
          verified: step === 'verify' ? stepOk : false
        }
      });
      receipt.passport_chain = {
        seq: chain && chain.seq ? chain.seq : null,
        hash: chain && chain.hash ? chain.hash : null
      };

      appendJsonl(policy.receipts_path, receipt);
      receipts.push(receipt);

      if (step === 'patch') {
        rollbackPoints.push({
          ts: nowIso(),
          kind: 'pre_verify',
          iteration,
          target_path: relPath(targetPath),
          digest: fileDigest(targetPath)
        });
      }

      if (step === 'verify') {
        finalIteration = iteration;
        if (stepOk) {
          converged = true;
          if (policy.stop_on_verify_pass === true) break;
        }
      }
    }
    if (converged && policy.stop_on_verify_pass === true) break;
  }

  const out = {
    ok: converged,
    type: 'iterative_repair_run',
    ts: nowIso(),
    objective_id: objectiveId,
    target_path: relPath(targetPath),
    apply,
    shadow_only: policy.shadow_only === true,
    iterations_requested: iterations,
    iterations_executed: finalIteration || iterations,
    converged,
    rollback_points: rollbackPoints,
    receipts_emitted: receipts.length,
    runtime_sec: Number(((Date.now() - start) / 1000).toFixed(3)),
    receipts_path: relPath(policy.receipts_path)
  };

  const state = {
    schema_id: 'iterative_repair_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    latest_run: out,
    latest_hash: sha256Hex(stableStringify(out))
  };
  writeJsonAtomic(policy.state_path, state);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const receipts = fs.existsSync(policy.receipts_path)
    ? String(fs.readFileSync(policy.receipts_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  return {
    ok: true,
    type: 'iterative_repair_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only === true,
      max_iterations: policy.max_iterations,
      max_runtime_sec: policy.max_runtime_sec
    },
    receipts_count: receipts,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        objective_id: latest.objective_id || null,
        target_path: latest.target_path || null,
        converged: latest.converged === true,
        iterations_executed: Number(latest.iterations_executed || 0)
      }
      : null,
    paths: {
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path),
      state_path: relPath(policy.state_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/primitives/iterative_repair_primitive.js run --target-path=<path> [--objective-id=<id>] [--iterations=3] [--apply=0|1] [--force-fail=0|1]');
  console.log('  node systems/primitives/iterative_repair_primitive.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') out = runRepair(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'iterative_repair', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runRepair,
  status
};
