#!/usr/bin/env node
'use strict';
export {};

/**
 * opportunistic_offload_plane.js
 *
 * RM-127: opportunistic heavy-task offload with local fallback.
 *
 * Usage:
 *   node systems/hardware/opportunistic_offload_plane.js dispatch --job-id=<id> [--complexity=0.7] [--required-ram-gb=2] [--required-cpu-threads=2] [--strict=1|0]
 *   node systems/hardware/opportunistic_offload_plane.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.OPPORTUNISTIC_OFFLOAD_POLICY_PATH
  ? path.resolve(String(process.env.OPPORTUNISTIC_OFFLOAD_POLICY_PATH))
  : path.join(ROOT, 'config', 'opportunistic_offload_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return clean(v, maxLen)
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

function clampNum(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
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

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    local_execution_score_threshold: 0.45,
    local_max_complexity: 0.5,
    embodiment_snapshot_path: 'state/hardware/embodiment/latest.json',
    schedule_command: ['node', 'systems/hardware/attested_assimilation_plane.js', 'schedule'],
    latest_path: 'state/hardware/opportunistic_offload/latest.json',
    queue_path: 'state/hardware/opportunistic_offload/queue.jsonl',
    receipts_path: 'state/hardware/opportunistic_offload/receipts.jsonl'
  };
}

function normalizeCommand(raw: unknown, fallback: string[]) {
  const arr = Array.isArray(raw) ? raw : fallback;
  const cmd = arr.map((v) => clean(v, 240)).filter(Boolean);
  if (cmd.length < 2) return fallback.slice();
  return cmd;
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const rootPath = (v: unknown, fallback: string) => {
    const text = clean(v || fallback, 320);
    return path.isAbsolute(text) ? path.resolve(text) : path.join(ROOT, text);
  };
  return {
    version: clean(raw.version || base.version, 24) || base.version,
    enabled: raw.enabled !== false,
    strict_default: toBool(raw.strict_default, base.strict_default),
    local_execution_score_threshold: clampNum(raw.local_execution_score_threshold, 0, 1, base.local_execution_score_threshold),
    local_max_complexity: clampNum(raw.local_max_complexity, 0, 1, base.local_max_complexity),
    embodiment_snapshot_path: rootPath(raw.embodiment_snapshot_path, base.embodiment_snapshot_path),
    schedule_command: normalizeCommand(raw.schedule_command, base.schedule_command),
    latest_path: rootPath(raw.latest_path, base.latest_path),
    queue_path: rootPath(raw.queue_path, base.queue_path),
    receipts_path: rootPath(raw.receipts_path, base.receipts_path),
    policy_path: path.resolve(policyPath)
  };
}

function runSchedule(policy: AnyObj, jobId: string, requiredRamGb: number, requiredCpuThreads: number, leaseSec: number) {
  const cmd = policy.schedule_command.slice();
  const args = [
    ...cmd.slice(1),
    `--work-id=${jobId}`,
    `--required-ram-gb=${requiredRamGb}`,
    `--required-cpu-threads=${requiredCpuThreads}`,
    `--lease-sec=${leaseSec}`
  ];
  const proc = spawnSync(cmd[0], args, { cwd: ROOT, encoding: 'utf8' });
  const stdout = String(proc.stdout || '').trim();
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
    ok: proc.status === 0 && payload && payload.ok === true,
    status: Number(proc.status || 0),
    command: [cmd[0], ...args].join(' '),
    payload,
    stderr: String(proc.stderr || '').trim().slice(0, 800)
  };
}

function decideRoute(policy: AnyObj, complexity: number, surfaceScore: number) {
  const localAllowed = surfaceScore >= Number(policy.local_execution_score_threshold || 0)
    && complexity <= Number(policy.local_max_complexity || 0);
  return localAllowed ? 'local' : 'offload';
}

function cmdDispatch(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (!policy.enabled) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'opportunistic_offload_dispatch', error: 'policy_disabled' })}\n`);
    process.exit(1);
  }
  const strict = toBool(args.strict, policy.strict_default === true);
  const jobId = normalizeToken(args['job-id'] || args.job_id || '', 160);
  if (!jobId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'opportunistic_offload_dispatch', error: 'job_id_required' })}\n`);
    process.exit(1);
  }
  const complexity = clampNum(args.complexity, 0, 1, 0.5);
  const requiredRamGb = clampNum(args['required-ram-gb'] || args.required_ram_gb, 0.25, 65536, 2);
  const requiredCpuThreads = clampInt(args['required-cpu-threads'] || args.required_cpu_threads, 1, 8192, 2);
  const leaseSec = clampInt(args['lease-sec'] || args.lease_sec, 30, 86400, 1800);

  const embodiment = readJson(policy.embodiment_snapshot_path, {});
  const surfaceScore = clampNum(embodiment?.surface_budget?.score, 0, 1, 0);
  const route = decideRoute(policy, complexity, surfaceScore);
  let schedule = null;
  let effectiveRoute = route;
  let fallbackReason = null;

  if (route === 'offload') {
    schedule = runSchedule(policy, jobId, requiredRamGb, requiredCpuThreads, leaseSec);
    if (!schedule.ok) {
      effectiveRoute = 'local';
      fallbackReason = 'offload_schedule_failed_local_fallback';
    }
  }

  const out = {
    ok: true,
    type: 'opportunistic_offload_dispatch',
    ts: nowIso(),
    job_id: jobId,
    complexity,
    required_ram_gb: requiredRamGb,
    required_cpu_threads: requiredCpuThreads,
    lease_sec: leaseSec,
    surface_budget_score: surfaceScore,
    requested_route: route,
    effective_route: effectiveRoute,
    fallback_reason: fallbackReason,
    schedule,
    policy_path: rel(policy.policy_path)
  };
  writeJsonAtomic(policy.latest_path, out);
  appendJsonl(policy.queue_path, out);
  appendJsonl(policy.receipts_path, out);
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.ok !== true) process.exit(1);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const queueCount = fs.existsSync(policy.queue_path)
    ? String(fs.readFileSync(policy.queue_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'opportunistic_offload_status',
    ts: nowIso(),
    latest,
    queue_count: queueCount,
    policy: {
      path: rel(policy.policy_path),
      local_execution_score_threshold: policy.local_execution_score_threshold,
      local_max_complexity: policy.local_max_complexity
    },
    paths: {
      latest_path: rel(policy.latest_path),
      queue_path: rel(policy.queue_path),
      receipts_path: rel(policy.receipts_path)
    }
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/hardware/opportunistic_offload_plane.js dispatch --job-id=<id> [--complexity=0.7] [--required-ram-gb=2] [--required-cpu-threads=2] [--strict=1|0]');
  console.log('  node systems/hardware/opportunistic_offload_plane.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'dispatch') return cmdDispatch(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
