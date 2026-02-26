#!/usr/bin/env node
'use strict';
export {};

/**
 * runtime_efficiency_floor.js
 *
 * RM-122: runtime efficiency gates for desktop seed profile.
 * Measures:
 * - cold start p95 ms
 * - idle RSS p95 MB
 * - install artifact size MB
 *
 * Usage:
 *   node systems/ops/runtime_efficiency_floor.js run [--strict=1|0]
 *   node systems/ops/runtime_efficiency_floor.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.RUNTIME_EFFICIENCY_FLOOR_POLICY_PATH
  ? path.resolve(String(process.env.RUNTIME_EFFICIENCY_FLOOR_POLICY_PATH))
  : path.join(ROOT, 'config', 'runtime_efficiency_floor_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = String(arg || '').indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
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

function clean(v: unknown, maxLen = 160) {
  return String(v == null ? '' : v).trim().slice(0, maxLen);
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

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function percentile(values: number[], q: number) {
  if (!Array.isArray(values) || values.length === 0) return null;
  const arr = values.slice().sort((a, b) => a - b);
  const idx = Math.min(arr.length - 1, Math.max(0, Math.ceil(q * arr.length) - 1));
  return Number(arr[idx].toFixed(3));
}

function normalizeCmd(raw: unknown, fallback: string[]) {
  const arr = Array.isArray(raw) ? raw : fallback;
  const cmd = arr.map((v) => clean(v, 240)).filter(Boolean);
  if (cmd.length < 2) return fallback.slice();
  return cmd;
}

function defaultPolicy() {
  return {
    version: '1.0',
    strict_default: false,
    cold_start_probe: {
      command: ['node', 'systems/workflow/workflow_controller.js', 'status'],
      samples: 5,
      max_ms: 300
    },
    idle_rss_probe: {
      samples: 3,
      max_mb: 120,
      require_modules: []
    },
    install_artifact_probe: {
      max_mb: 60,
      paths: ['dist']
    },
    state_path: 'state/ops/runtime_efficiency_floor.json',
    history_path: 'state/ops/runtime_efficiency_floor_history.jsonl'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const coldRaw = raw.cold_start_probe && typeof raw.cold_start_probe === 'object'
    ? raw.cold_start_probe
    : {};
  const idleRaw = raw.idle_rss_probe && typeof raw.idle_rss_probe === 'object'
    ? raw.idle_rss_probe
    : {};
  const artifactRaw = raw.install_artifact_probe && typeof raw.install_artifact_probe === 'object'
    ? raw.install_artifact_probe
    : {};
  return {
    version: clean(raw.version || base.version, 32) || '1.0',
    strict_default: raw.strict_default !== false,
    cold_start_probe: {
      command: normalizeCmd(coldRaw.command, base.cold_start_probe.command),
      samples: clampInt(coldRaw.samples, 1, 30, base.cold_start_probe.samples),
      max_ms: clampNum(coldRaw.max_ms, 1, 30000, base.cold_start_probe.max_ms)
    },
    idle_rss_probe: {
      samples: clampInt(idleRaw.samples, 1, 20, base.idle_rss_probe.samples),
      max_mb: clampNum(idleRaw.max_mb, 1, 8192, base.idle_rss_probe.max_mb),
      require_modules: Array.from(new Set(
        (Array.isArray(idleRaw.require_modules) ? idleRaw.require_modules : base.idle_rss_probe.require_modules)
          .map((v: unknown) => clean(v, 240))
          .filter(Boolean)
      ))
    },
    install_artifact_probe: {
      max_mb: clampNum(artifactRaw.max_mb, 1, 8192, base.install_artifact_probe.max_mb),
      paths: Array.from(new Set(
        (Array.isArray(artifactRaw.paths) ? artifactRaw.paths : base.install_artifact_probe.paths)
          .map((v: unknown) => clean(v, 240))
          .filter(Boolean)
      ))
    },
    state_path: path.isAbsolute(String(raw.state_path || ''))
      ? path.resolve(String(raw.state_path))
      : path.join(ROOT, clean(raw.state_path || base.state_path, 240)),
    history_path: path.isAbsolute(String(raw.history_path || ''))
      ? path.resolve(String(raw.history_path))
      : path.join(ROOT, clean(raw.history_path || base.history_path, 240))
  };
}

function runColdStartProbe(policy: AnyObj) {
  const cmd = policy.cold_start_probe.command as string[];
  const samples = Number(policy.cold_start_probe.samples || 1);
  const msRows: number[] = [];
  let lastErr = '';
  for (let i = 0; i < samples; i += 1) {
    const started = Date.now();
    const run = spawnSync(cmd[0], cmd.slice(1), {
      cwd: ROOT,
      encoding: 'utf8'
    });
    const elapsed = Math.max(1, Date.now() - started);
    msRows.push(elapsed);
    if (run.status !== 0) {
      lastErr = String(run.stderr || run.stdout || `cold_start_probe_exit_${run.status}`).slice(0, 200);
    }
  }
  const p95Ms = percentile(msRows, 0.95);
  const pass = !!p95Ms && p95Ms <= Number(policy.cold_start_probe.max_ms || 300) && !lastErr;
  return {
    pass,
    samples,
    samples_ms: msRows,
    p95_ms: p95Ms,
    threshold_ms: Number(policy.cold_start_probe.max_ms || 300),
    command: cmd,
    error: lastErr || null
  };
}

function runIdleRssProbe(policy: AnyObj) {
  const samples = Number(policy.idle_rss_probe.samples || 1);
  const requireModules = Array.isArray(policy.idle_rss_probe.require_modules)
    ? policy.idle_rss_probe.require_modules
    : [];
  const rowsMb: number[] = [];
  let lastErr = '';

  const code = [
    'const path=require("path");',
    'const mods=JSON.parse(process.env.RUNTIME_EFF_IDLE_MODULES||"[]");',
    'for(const m of mods){',
    '  try{',
    '    const abs=path.isAbsolute(m)?m:path.join(process.cwd(), String(m));',
    '    require(abs);',
    '  }catch(_err){}',
    '}',
    'setTimeout(()=>{',
    '  const mb=Number((process.memoryUsage().rss/1024/1024).toFixed(3));',
    '  process.stdout.write(JSON.stringify({ok:true,rss_mb:mb})+"\\n");',
    '}, 5);'
  ].join('');

  for (let i = 0; i < samples; i += 1) {
    const run = spawnSync(process.execPath, ['-e', code], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        RUNTIME_EFF_IDLE_MODULES: JSON.stringify(requireModules)
      }
    });
    if (run.status !== 0) {
      lastErr = String(run.stderr || run.stdout || `idle_rss_probe_exit_${run.status}`).slice(0, 200);
      continue;
    }
    try {
      const payload = JSON.parse(String(run.stdout || '').trim());
      const rssMb = Number(payload && payload.rss_mb);
      if (Number.isFinite(rssMb) && rssMb > 0) rowsMb.push(rssMb);
    } catch {
      lastErr = 'idle_rss_probe_parse_error';
    }
  }

  const p95Mb = percentile(rowsMb, 0.95);
  const pass = !!p95Mb && p95Mb <= Number(policy.idle_rss_probe.max_mb || 120) && !lastErr;
  return {
    pass,
    samples,
    samples_mb: rowsMb,
    p95_mb: p95Mb,
    threshold_mb: Number(policy.idle_rss_probe.max_mb || 120),
    require_modules: requireModules,
    error: lastErr || null
  };
}

function sizeBytesOfPath(targetPath: string): number {
  try {
    const st = fs.statSync(targetPath);
    if (st.isFile()) return Number(st.size || 0);
    if (!st.isDirectory()) return 0;
  } catch {
    return 0;
  }
  let total = 0;
  const stack = [targetPath];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: any[] = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const abs = path.join(current, ent.name);
      if (ent.isDirectory()) stack.push(abs);
      else if (ent.isFile()) {
        try {
          total += Number(fs.statSync(abs).size || 0);
        } catch {
          // ignore transient file failures
        }
      }
    }
  }
  return total;
}

function runInstallArtifactProbe(policy: AnyObj) {
  const pathsRaw = Array.isArray(policy.install_artifact_probe.paths)
    ? policy.install_artifact_probe.paths
    : [];
  const rows: AnyObj[] = [];
  let totalBytes = 0;
  for (const rel of pathsRaw) {
    const cleanRel = clean(rel, 240);
    if (!cleanRel) continue;
    const abs = path.isAbsolute(cleanRel) ? cleanRel : path.join(ROOT, cleanRel);
    const bytes = sizeBytesOfPath(abs);
    totalBytes += bytes;
    rows.push({
      path: relPath(abs),
      bytes,
      mb: Number((bytes / 1024 / 1024).toFixed(3))
    });
  }
  const totalMb = Number((totalBytes / 1024 / 1024).toFixed(3));
  const pass = totalMb <= Number(policy.install_artifact_probe.max_mb || 60);
  return {
    pass,
    threshold_mb: Number(policy.install_artifact_probe.max_mb || 60),
    total_mb: totalMb,
    paths: rows
  };
}

function runCommand(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, policy.strict_default);

  const coldStart = runColdStartProbe(policy);
  const idleRss = runIdleRssProbe(policy);
  const installArtifact = runInstallArtifactProbe(policy);

  const checks = {
    cold_start: coldStart.pass === true,
    idle_rss: idleRss.pass === true,
    install_artifact: installArtifact.pass === true
  };
  const pass = checks.cold_start && checks.idle_rss && checks.install_artifact;
  const result = pass ? 'pass' : 'warn';

  const payload = {
    schema_id: 'runtime_efficiency_floor',
    schema_version: '1.0',
    updated_at: nowIso(),
    policy_version: policy.version,
    strict,
    checks,
    pass,
    result,
    metrics: {
      cold_start_p95_ms: coldStart.p95_ms,
      cold_start_threshold_ms: coldStart.threshold_ms,
      idle_rss_p95_mb: idleRss.p95_mb,
      idle_rss_threshold_mb: idleRss.threshold_mb,
      install_artifact_total_mb: installArtifact.total_mb,
      install_artifact_threshold_mb: installArtifact.threshold_mb
    },
    probes: {
      cold_start: coldStart,
      idle_rss: idleRss,
      install_artifact: installArtifact
    }
  };
  writeJsonAtomic(policy.state_path, payload);
  appendJsonl(policy.history_path, {
    ts: payload.updated_at,
    pass: payload.pass,
    result: payload.result,
    checks: payload.checks,
    metrics: payload.metrics
  });

  const out = {
    ok: true,
    type: 'runtime_efficiency_floor',
    ts: payload.updated_at,
    pass: payload.pass,
    result: payload.result,
    checks: payload.checks,
    metrics: payload.metrics,
    policy_path: relPath(policyPath),
    state_path: relPath(policy.state_path),
    history_path: relPath(policy.history_path)
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  if (strict && out.pass !== true) process.exit(1);
}

function statusCommand(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.state_path, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'runtime_efficiency_floor_status',
    ts: nowIso(),
    available: !!payload,
    policy_path: relPath(policyPath),
    state_path: relPath(policy.state_path),
    history_path: relPath(policy.history_path),
    payload
  }, null, 2)}\n`);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/runtime_efficiency_floor.js run [--strict=1|0]');
  console.log('  node systems/ops/runtime_efficiency_floor.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = clean(args._[0] || 'run', 40).toLowerCase();
  if (cmd === 'run') return runCommand(args);
  if (cmd === 'status') return statusCommand(args);
  usage();
  process.exit(1);
}

main();
