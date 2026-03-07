#!/usr/bin/env node
'use strict';
export {};

/**
 * phone_seed_profile.js
 *
 * RM-124: bounded phone-seed viability gate.
 *
 * Usage:
 *   node systems/ops/phone_seed_profile.js run [--strict=1|0]
 *   node systems/ops/phone_seed_profile.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PHONE_SEED_PROFILE_POLICY_PATH
  ? path.resolve(String(process.env.PHONE_SEED_PROFILE_POLICY_PATH))
  : path.join(ROOT, 'config', 'phone_seed_profile_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok || '').slice(2)] = true;
    else out[String(tok || '').slice(2, idx)] = String(tok || '').slice(idx + 1);
  }
  return out;
}

function boolFlag(v: unknown, fallback = false) {
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

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function normalizeCommand(raw: unknown, fallback: string[]) {
  const src = Array.isArray(raw) ? raw : fallback;
  const cmd = src.map((v) => clean(v, 240)).filter(Boolean);
  if (cmd.length < 2) return fallback.slice();
  return cmd;
}

function percentile(values: number[], q: number) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const arr = values
    .map((v) => Number(v))
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!arr.length) return null;
  const idx = Math.max(0, Math.min(arr.length - 1, Math.ceil(q * arr.length) - 1));
  return Number(arr[idx].toFixed(3));
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: false,
    samples: 5,
    thresholds: {
      boot_ms_max: 800,
      idle_rss_mb_max: 180,
      workflow_latency_ms_max: 3000,
      memory_latency_ms_max: 3000
    },
    require_heavy_lanes_disabled: true,
    embodiment_snapshot_path: 'state/hardware/embodiment/latest.json',
    boot_probe_command: ['node', 'systems/ops/seed_boot_probe.js', 'run'],
    workflow_probe_command: ['node', 'systems/workflow/workflow_controller.js', 'status'],
    memory_probe_command: ['node', 'systems/memory/memory_federation_plane.js', 'status'],
    state_path: 'state/ops/phone_seed_profile/status.json',
    history_path: 'state/ops/phone_seed_profile/history.jsonl'
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  return {
    version: clean(raw.version || base.version, 32) || base.version,
    strict_default: boolFlag(raw.strict_default, base.strict_default),
    samples: clampInt(raw.samples, 1, 30, base.samples),
    thresholds: {
      boot_ms_max: clampNum(raw?.thresholds?.boot_ms_max, 1, 60000, base.thresholds.boot_ms_max),
      idle_rss_mb_max: clampNum(raw?.thresholds?.idle_rss_mb_max, 1, 65536, base.thresholds.idle_rss_mb_max),
      workflow_latency_ms_max: clampNum(raw?.thresholds?.workflow_latency_ms_max, 1, 60000, base.thresholds.workflow_latency_ms_max),
      memory_latency_ms_max: clampNum(raw?.thresholds?.memory_latency_ms_max, 1, 60000, base.thresholds.memory_latency_ms_max)
    },
    require_heavy_lanes_disabled: boolFlag(raw.require_heavy_lanes_disabled, base.require_heavy_lanes_disabled),
    embodiment_snapshot_path: path.isAbsolute(clean(raw.embodiment_snapshot_path || '', 320))
      ? path.resolve(clean(raw.embodiment_snapshot_path || '', 320))
      : path.join(ROOT, clean(raw.embodiment_snapshot_path || base.embodiment_snapshot_path, 320)),
    boot_probe_command: normalizeCommand(raw.boot_probe_command, base.boot_probe_command),
    workflow_probe_command: normalizeCommand(raw.workflow_probe_command, base.workflow_probe_command),
    memory_probe_command: normalizeCommand(raw.memory_probe_command, base.memory_probe_command),
    state_path: path.isAbsolute(clean(raw.state_path || '', 320))
      ? path.resolve(clean(raw.state_path || '', 320))
      : path.join(ROOT, clean(raw.state_path || base.state_path, 320)),
    history_path: path.isAbsolute(clean(raw.history_path || '', 320))
      ? path.resolve(clean(raw.history_path || '', 320))
      : path.join(ROOT, clean(raw.history_path || base.history_path, 320)),
    policy_path: path.resolve(policyPath)
  };
}

function runProbe(command: string[]) {
  const t0 = process.hrtime.bigint();
  const run = spawnSync(command[0], command.slice(1), {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const t1 = process.hrtime.bigint();
  const latencyMs = Number((Number(t1 - t0) / 1e6).toFixed(3));
  const stdout = String(run.stdout || '').trim();
  let payload: AnyObj = {};
  if (stdout) {
    const lines = stdout.split('\n');
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        const parsed = JSON.parse(lines[i]);
        if (parsed && typeof parsed === 'object') {
          payload = parsed;
          break;
        }
      } catch {}
    }
  }
  return {
    ok: run.status === 0,
    command: command.join(' '),
    status: Number(run.status || 0),
    latency_ms: latencyMs,
    payload,
    stderr: String(run.stderr || '').trim().slice(0, 800)
  };
}

function evaluate(policy: AnyObj) {
  const bootRuns: AnyObj[] = [];
  for (let i = 0; i < Number(policy.samples || 1); i += 1) {
    bootRuns.push(runProbe(policy.boot_probe_command));
  }
  const bootMsValues = bootRuns
    .map((row) => Number(row?.payload?.boot_ms))
    .filter((v) => Number.isFinite(v));
  const rssValues = bootRuns
    .map((row) => Number(row?.payload?.rss_mb))
    .filter((v) => Number.isFinite(v));
  const bootProbeOk = bootRuns.every((row) => row.ok === true);
  const bootMsP50 = percentile(bootMsValues, 0.5);
  const idleRssP50 = percentile(rssValues, 0.5);

  const workflowProbe = runProbe(policy.workflow_probe_command);
  const memoryProbe = runProbe(policy.memory_probe_command);

  const embodiment = readJson(policy.embodiment_snapshot_path, {});
  const heavyDisabled = embodiment
    && embodiment.capability_envelope
    && embodiment.capability_envelope.heavy_lanes_disabled === true;

  const checks = {
    boot_probe_ok: bootProbeOk,
    boot_ms_threshold: bootMsP50 != null && Number(bootMsP50) <= Number(policy.thresholds.boot_ms_max || 0),
    idle_rss_threshold: idleRssP50 != null && Number(idleRssP50) <= Number(policy.thresholds.idle_rss_mb_max || 0),
    workflow_latency_threshold: Number(workflowProbe.latency_ms || 0) <= Number(policy.thresholds.workflow_latency_ms_max || 0),
    memory_latency_threshold: Number(memoryProbe.latency_ms || 0) <= Number(policy.thresholds.memory_latency_ms_max || 0),
    heavy_lanes_disabled_by_policy: policy.require_heavy_lanes_disabled !== true ? true : heavyDisabled
  };
  const ok = Object.values(checks).every((v) => v === true);

  return {
    schema_id: 'phone_seed_profile',
    schema_version: '1.0',
    ts: nowIso(),
    ok,
    policy_path: rel(policy.policy_path),
    thresholds: policy.thresholds,
    checks,
    metrics: {
      boot_ms_p50: bootMsP50,
      idle_rss_mb_p50: idleRssP50,
      workflow_latency_ms: Number(workflowProbe.latency_ms.toFixed(3)),
      memory_latency_ms: Number(memoryProbe.latency_ms.toFixed(3))
    },
    probes: {
      boot_runs: bootRuns.map((row) => ({
        ok: row.ok,
        status: row.status,
        latency_ms: row.latency_ms,
        boot_ms: Number(row?.payload?.boot_ms),
        rss_mb: Number(row?.payload?.rss_mb),
        modules_ok: row?.payload?.modules_ok === true,
        files_ok: row?.payload?.files_ok === true
      })),
      workflow_probe: {
        ok: workflowProbe.ok,
        status: workflowProbe.status,
        latency_ms: workflowProbe.latency_ms,
        stderr: workflowProbe.stderr
      },
      memory_probe: {
        ok: memoryProbe.ok,
        status: memoryProbe.status,
        latency_ms: memoryProbe.latency_ms,
        stderr: memoryProbe.stderr
      }
    },
    embodiment_snapshot: {
      path: rel(policy.embodiment_snapshot_path),
      present: fs.existsSync(policy.embodiment_snapshot_path),
      profile_id: clean(embodiment.profile_id || '', 40) || null,
      heavy_lanes_disabled: heavyDisabled === true
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/phone_seed_profile.js run [--strict=1|0]');
  console.log('  node systems/ops/phone_seed_profile.js status');
}

function cmdRun(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const strict = boolFlag(args.strict, policy.strict_default === true);
  const payload = evaluate(policy);
  writeJsonAtomic(policy.state_path, payload);
  appendJsonl(policy.history_path, payload);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (strict && payload.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = fs.existsSync(policy.state_path) ? readJson(policy.state_path, null) : null;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'phone_seed_profile_status',
    ts: nowIso(),
    latest,
    policy: {
      path: rel(policy.policy_path),
      samples: Number(policy.samples || 0),
      require_heavy_lanes_disabled: policy.require_heavy_lanes_disabled === true,
      thresholds: policy.thresholds
    },
    paths: {
      state_path: rel(policy.state_path),
      history_path: rel(policy.history_path),
      embodiment_snapshot_path: rel(policy.embodiment_snapshot_path)
    }
  }, null, 2)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || '', 40).toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
