#!/usr/bin/env node
'use strict';
export {};

const { spawn, execSync } = require('child_process');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 300) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq >= 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = '1';
  }
  return out;
}

function toInt(v: unknown, fallback: number, lo: number, hi: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function etimeToSeconds(etime: string) {
  const raw = cleanText(etime, 40);
  if (!raw) return 0;
  let days = 0;
  let rest = raw;
  if (raw.includes('-')) {
    const [d, r] = raw.split('-', 2);
    days = Number(d) || 0;
    rest = r || '0:00';
  }
  const parts = rest.split(':').map((x) => Number(x) || 0);
  let h = 0; let m = 0; let s = 0;
  if (parts.length === 3) [h, m, s] = parts;
  else if (parts.length === 2) [m, s] = parts;
  else if (parts.length === 1) [s] = parts;
  return (days * 86400) + (h * 3600) + (m * 60) + s;
}

function listBuildScriptsForParent(parentPid: number) {
  const out = execSync('ps -axo pid,ppid,etime,command', { encoding: 'utf8' });
  return String(out || '')
    .split('\n')
    .slice(1)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) return null;
      return {
        pid: Number(match[1]),
        ppid: Number(match[2]),
        etime: match[3],
        age_sec: etimeToSeconds(match[3]),
        command: match[4]
      };
    })
    .filter((row) => !!row)
    .filter((row: any) => row.ppid === parentPid && String(row.command).includes('build-script-build')) as Array<{pid:number,ppid:number,etime:string,age_sec:number,command:string}>;
}

function profileToCargoArgs(profile: string) {
  const key = cleanText(profile, 64).toLowerCase();
  if (key === 'protheus_ops_attention') {
    return ['test', '-p', 'protheus-ops-core', 'attention_queue', '--', '--nocapture'];
  }
  if (key === 'execution_core_initiative') {
    return ['test', '-p', 'execution_core', 'initiative', '--', '--nocapture'];
  }
  throw new Error(`unsupported_profile:${key}`);
}

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runValidationAttempt(
  profile: string,
  cargoArgs: string[],
  staleAgeSec: number,
  checkIntervalMs: number,
  timeoutMs: number
) {
  const startedAt = Date.now();
  const child = spawn('cargo', cargoArgs, {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => { stdout += String(chunk || ''); process.stdout.write(chunk); });
  child.stderr.on('data', (chunk: Buffer) => { stderr += String(chunk || ''); process.stderr.write(chunk); });

  let staleDetected = null as any;
  let timeoutTriggered = false;
  while (true) {
    const finished = child.exitCode != null;
    if (finished) break;
    if ((Date.now() - startedAt) > timeoutMs) {
      timeoutTriggered = true;
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
      break;
    }
    const staleRows = listBuildScriptsForParent(child.pid);
    const stale = staleRows.find((row) => row.age_sec >= staleAgeSec);
    if (stale) {
      staleDetected = stale;
      try { process.kill(stale.pid, 'SIGTERM'); } catch {}
      try { process.kill(child.pid, 'SIGTERM'); } catch {}
      break;
    }
    await sleep(checkIntervalMs);
  }

  await sleep(250);
  const exitCode = Number.isFinite(child.exitCode) ? Number(child.exitCode) : (timeoutTriggered || staleDetected ? 124 : 1);
  const payload = {
    ok: exitCode === 0,
    type: 'host_rust_validation',
    ts: nowIso(),
    profile,
    command: ['cargo', ...cargoArgs],
    elapsed_ms: Date.now() - startedAt,
    stale_age_sec: staleAgeSec,
    timeout_ms: timeoutMs,
    stale_detected: !!staleDetected,
    stale_process: staleDetected
      ? { pid: staleDetected.pid, age_sec: staleDetected.age_sec, command: cleanText(staleDetected.command, 180) }
      : null,
    timeout_triggered: timeoutTriggered,
    exit_code: exitCode,
    reason_code: staleDetected
      ? 'stale_build_script_detected'
      : (timeoutTriggered ? 'validation_timeout' : (exitCode === 0 ? 'none' : 'validation_failed')),
    stderr_tail: cleanText(stderr.slice(-1000), 1000),
    stdout_tail: cleanText(stdout.slice(-1000), 1000)
  };
  return payload;
}

function reapStaleBuildScripts(maxAgeSec: number) {
  try {
    const cmd = `node client/systems/ops/host_build_stale_guard.js reap --kill=1 --max-age-sec=${Math.max(10, maxAgeSec)}`;
    execSync(cmd, { cwd: process.cwd(), stdio: ['ignore', 'ignore', 'ignore'] });
  } catch {
    // best-effort cleanup only
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'run', 20).toLowerCase();
  if (cmd !== 'run') {
    process.stdout.write(`${JSON.stringify({ ok: false, error: 'unsupported_command', command: cmd })}\n`);
    process.exit(2);
  }
  const profile = cleanText(args.profile || '', 80) || 'protheus_ops_attention';
  const cargoArgs = profileToCargoArgs(profile);
  const staleAgeSec = toInt(args['stale-age-sec'] || process.env.HOST_BUILD_STALE_MAX_AGE_SEC, 90, 20, 3600);
  const checkIntervalMs = toInt(args['check-interval-ms'] || 5000, 1000, 1000, 60000);
  const timeoutMs = toInt(args['timeout-ms'] || 20 * 60 * 1000, 10000, 10000, 2 * 60 * 60 * 1000);
  const maxRetries = toInt(args['max-retries'] || process.env.HOST_RUST_VALIDATION_MAX_RETRIES, 1, 0, 5);

  const attempts: Array<{ attempt: number, reason_code: string, exit_code: number }> = [];
  let payload = null as any;
  for (let attempt = 1; attempt <= (maxRetries + 1); attempt += 1) {
    payload = await runValidationAttempt(profile, cargoArgs, staleAgeSec, checkIntervalMs, timeoutMs);
    attempts.push({
      attempt,
      reason_code: cleanText(payload.reason_code, 120),
      exit_code: Number(payload.exit_code || 1)
    });
    if (payload.exit_code === 0) break;
    const canRetry = payload.reason_code === 'stale_build_script_detected' && attempt <= maxRetries;
    if (!canRetry) break;
    reapStaleBuildScripts(staleAgeSec);
    await sleep(1200);
  }

  payload.attempts = attempts;
  payload.retried = attempts.length > 1;
  payload.max_retries = maxRetries;
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(Number(payload.exit_code || 1));
}

run().catch((err: any) => {
  process.stderr.write(`host_rust_validation_error:${cleanText(err && err.message ? err.message : err, 300)}\n`);
  process.exit(1);
});
