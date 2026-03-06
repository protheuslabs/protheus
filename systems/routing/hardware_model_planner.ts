#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-009
 * Hardware-aware local model planner.
 *
 * Usage:
 *   node systems/routing/hardware_model_planner.js plan [--apply=1|0] [--strict=1|0]
 *   node systems/routing/hardware_model_planner.js status
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.HARDWARE_MODEL_PLANNER_ROOT
  ? path.resolve(process.env.HARDWARE_MODEL_PLANNER_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.HARDWARE_MODEL_PLANNER_POLICY_PATH
  ? path.resolve(process.env.HARDWARE_MODEL_PLANNER_POLICY_PATH)
  : path.join(ROOT, 'config', 'hardware_model_planner_policy.json');

function nowIso() { return new Date().toISOString(); }

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch { return fallback; }
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

function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    tiers: {
      nano: {
        max_threads: 8,
        max_ram_gb: 12,
        max_vram_gb: 4,
        recommended_models: ['ollama/qwen3:4b'],
        notes: 'favor lightweight local models'
      },
      standard: {
        max_threads: 24,
        max_ram_gb: 48,
        max_vram_gb: 16,
        recommended_models: ['ollama/qwen3:8b', 'ollama/llama3.1:8b'],
        notes: 'balanced local routing'
      },
      high: {
        max_threads: 512,
        max_ram_gb: 4096,
        max_vram_gb: 512,
        recommended_models: ['ollama/qwen3:14b', 'ollama/llama3.3:70b'],
        notes: 'high-capacity local routing'
      }
    },
    outputs: {
      latest_path: 'state/routing/hardware_model_planner/latest.json',
      history_path: 'state/routing/hardware_model_planner/history.jsonl',
      plan_path: 'state/routing/hardware_model_planner/plan.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const tiersRaw = raw.tiers && typeof raw.tiers === 'object' ? raw.tiers : base.tiers;
  const tiers: AnyObj = {};
  for (const [id, cfg] of Object.entries(tiersRaw)) {
    const c = cfg && typeof cfg === 'object' ? cfg : {};
    tiers[id] = {
      max_threads: Math.max(1, Number(c.max_threads || 1)),
      max_ram_gb: Math.max(1, Number(c.max_ram_gb || 1)),
      max_vram_gb: Math.max(0, Number(c.max_vram_gb || 0)),
      recommended_models: Array.isArray(c.recommended_models) ? c.recommended_models.map((x: unknown) => cleanText(x, 120)).filter(Boolean) : [],
      notes: cleanText(c.notes || '', 220)
    };
  }
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    tiers,
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path),
      plan_path: resolvePath(outputs.plan_path, base.outputs.plan_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function detectHardware() {
  const threads = Math.max(1, Number(process.env.HW_PLANNER_CPU_THREADS || os.cpus().length || 1));
  const ramGb = clampNumber(
    process.env.HW_PLANNER_RAM_GB || (os.totalmem() / (1024 ** 3)),
    0.25,
    16384,
    1
  );
  const vramGb = clampNumber(process.env.HW_PLANNER_VRAM_GB || 0, 0, 16384, 0);
  return {
    cpu_threads: Number(threads),
    ram_gb: Number(ramGb.toFixed(3)),
    vram_gb: Number(vramGb.toFixed(3)),
    platform: os.platform(),
    arch: os.arch()
  };
}

function chooseTier(policy: AnyObj, hw: AnyObj) {
  const ordered = ['nano', 'standard', 'high'];
  for (const tierId of ordered) {
    const tier = policy.tiers[tierId];
    if (!tier) continue;
    if (hw.cpu_threads <= Number(tier.max_threads || 0)
      && hw.ram_gb <= Number(tier.max_ram_gb || 0)
      && hw.vram_gb <= Number(tier.max_vram_gb || 0)) {
      return tierId;
    }
  }
  return 'high';
}

function cmdPlan(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const apply = toBool(args.apply, false);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, apply, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const hw = detectHardware();
  const tierId = chooseTier(policy, hw);
  const tier = policy.tiers[tierId] || { recommended_models: [] };

  const out = {
    ok: true,
    ts: nowIso(),
    type: 'hardware_model_planner',
    strict,
    apply,
    hardware: hw,
    tier: tierId,
    recommended_models: Array.isArray(tier.recommended_models) ? tier.recommended_models : [],
    notes: tier.notes || null,
    policy_path: rel(policy.policy_path),
    plan_path: rel(policy.outputs.plan_path)
  };

  if (apply) {
    writeJsonAtomic(policy.outputs.plan_path, {
      ts: out.ts,
      tier: out.tier,
      hardware: hw,
      recommended_models: out.recommended_models,
      notes: out.notes
    });
  }

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    tier: out.tier,
    cpu_threads: hw.cpu_threads,
    ram_gb: hw.ram_gb,
    vram_gb: hw.vram_gb,
    recommended_models: out.recommended_models,
    apply,
    ok: true
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'hardware_model_planner_status',
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null),
    plan_path: rel(policy.outputs.plan_path),
    plan: readJson(policy.outputs.plan_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/routing/hardware_model_planner.js plan [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/routing/hardware_model_planner.js status [--policy=<path>]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'plan').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  try {
    const payload = cmd === 'plan'
      ? cmdPlan(args)
      : cmd === 'status'
        ? cmdStatus(args)
        : { ok: false, error: `unknown_command:${cmd}` };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
    if (payload.ok === false) process.exit(1);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'hardware_model_planner_failed', 260) })}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  detectHardware,
  chooseTier,
  cmdPlan,
  cmdStatus
};
