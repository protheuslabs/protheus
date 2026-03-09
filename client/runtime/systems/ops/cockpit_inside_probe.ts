#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toInt(v: unknown, fallback: number, lo: number, hi: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
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

function parseJsonLines(raw: unknown) {
  const lines = String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const payloads: any[] = [];
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    try {
      payloads.push(JSON.parse(line));
    } catch {}
  }
  return payloads;
}

function runNodeScript(scriptRel: string, args: string[], env: Record<string, string>, timeoutMs: number) {
  const scriptAbs = path.join(ROOT, scriptRel);
  const run = spawnSync(process.execPath, [scriptAbs, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const stderr = cleanText(run.error ? String(run.error.message || run.error) : run.stderr, 1000);
  return {
    ok: run.status === 0,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    stdout: String(run.stdout || ''),
    stderr,
    payloads: parseJsonLines(run.stdout)
  };
}

function writeJson(filePath: string, payload: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath: string, payload: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function dominantReason(harness: any, subscribeBatch: any) {
  return (
    cleanText(
      harness && harness.attention && harness.attention.degraded_reason,
      180
    )
    || cleanText(subscribeBatch && subscribeBatch.bridge_fallback_reason, 180)
    || (subscribeBatch && subscribeBatch.degraded === true ? 'subscribe_degraded' : null)
    || null
  );
}

function feelGrade(status: any, harness: any, subscribeBatch: any) {
  const ambient = !!(status && status.ambient_mode && status.ambient_mode.active === true);
  const harnessHealthy = !!(harness && harness.degraded !== true);
  if (ambient && harnessHealthy) return 'mech_like';
  if (ambient) return 'partial';
  return 'manual';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const consumer = cleanText(args.consumer || process.env.COCKPIT_CONSUMER_ID || 'cockpit_llm', 80) || 'cockpit_llm';
  const limit = toInt(args.limit || process.env.COCKPIT_BATCH_LIMIT, 12, 1, 256);
  const waitMs = toInt(args['wait-ms'] || process.env.PROTHEUSD_SUBSCRIBE_WAIT_MS, 5000, 0, 300000);
  const subscribeWaitMs = Math.max(250, Math.min(waitMs, 2500));
  const timeoutMs = toInt(args['timeout-ms'] || process.env.COCKPIT_INSIDE_PROBE_TIMEOUT_MS, 60000, 5000, 300000);
  const commandTimeoutMs = toInt(
    args['command-timeout-ms'] || process.env.COCKPIT_INSIDE_PROBE_COMMAND_TIMEOUT_MS,
    20000,
    3000,
    120000
  );
  const conduitProbeMs = toInt(
    args['conduit-probe-timeout-ms'] || process.env.COCKPIT_CONDUIT_PROBE_TIMEOUT_MS,
    5000,
    2000,
    120000
  );
  const env = {
    COCKPIT_CONSUMER_ID: consumer,
    COCKPIT_BATCH_LIMIT: String(limit),
    COCKPIT_CONDUIT_PROBE_TIMEOUT_MS: String(conduitProbeMs),
    PROTHEUS_CONDUIT_STARTUP_PROBE_TIMEOUT_MS: String(Math.max(5000, conduitProbeMs))
  };

  const attachRun = runNodeScript(
    'systems/ops/protheusd.js',
    ['attach', '--autostart', `--consumer=${consumer}`, `--limit=${limit}`],
    env,
    commandTimeoutMs
  );
  const statusRun = runNodeScript(
    'systems/ops/protheusd.js',
    ['status', '--no-autostart'],
    env,
    commandTimeoutMs
  );
  const subscribeRun = runNodeScript(
    'systems/ops/protheusd.js',
    [
      'subscribe',
      `--consumer=${consumer}`,
      `--limit=${limit}`,
      '--once=1',
      '--transport=push',
      `--wait-ms=${subscribeWaitMs}`,
      `--push-heartbeat-ms=${Math.max(500, Math.min(2000, subscribeWaitMs))}`
    ],
    env,
    Math.max(commandTimeoutMs, subscribeWaitMs + 5000)
  );
  const harnessRun = runNodeScript(
    'systems/ops/cockpit_harness.js',
    ['once', `--consumer=${consumer}`, `--limit=${limit}`],
    env,
    commandTimeoutMs
  );

  const statusPayload = statusRun.payloads.find((row: any) => row && row.type === 'protheus_control_plane_status') || null;
  const subscribeBatch = subscribeRun.payloads.find((row: any) => row && row.type === 'protheus_daemon_subscribe_batch') || null;
  const harnessEnvelope = harnessRun.payloads.find((row: any) => row && row.type === 'cockpit_context_envelope') || null;
  const topAttention = Array.isArray(subscribeBatch && subscribeBatch.attention)
    ? subscribeBatch.attention
      .slice(0, 5)
      .map((row: any) => cleanText(row && row.summary || row && row.type || 'attention_event', 180))
    : [];

  const output: any = {
    ok: attachRun.ok && statusRun.ok && !!statusPayload,
    type: 'cockpit_inside_probe',
    ts: nowIso(),
    root: ROOT,
    consumer,
    limit,
    wait_ms: waitMs,
    commands: {
      attach: { ok: attachRun.ok, status: attachRun.status, stderr: attachRun.stderr || null },
      status: { ok: statusRun.ok, status: statusRun.status, stderr: statusRun.stderr || null },
      subscribe: { ok: subscribeRun.ok, status: subscribeRun.status, stderr: subscribeRun.stderr || null },
      harness_once: { ok: harnessRun.ok, status: harnessRun.status, stderr: harnessRun.stderr || null }
    },
    felt_state: {
      grade: feelGrade(statusPayload, harnessEnvelope, subscribeBatch),
      ambient_active: !!(statusPayload && statusPayload.ambient_mode && statusPayload.ambient_mode.active === true),
      ambient_configured: !!(statusPayload && statusPayload.ambient_mode && statusPayload.ambient_mode.configured === true),
      ambient_healthy: !!(statusPayload && statusPayload.ambient_mode && statusPayload.ambient_mode.healthy === true),
      queue_depth: Number(statusPayload && statusPayload.attention && statusPayload.attention.queue_depth || 0),
      subscribe_batch_count: Number(subscribeBatch && subscribeBatch.batch_count || 0),
      harness_degraded: !!(harnessEnvelope && harnessEnvelope.degraded === true),
      degraded_reason: dominantReason(harnessEnvelope, subscribeBatch),
      top_attention_summaries: topAttention,
      identity_hydration: statusPayload ? statusPayload.identity_hydration || null : null,
      resident_memory: statusPayload ? statusPayload.resident_memory || null : null
    },
    receipt_hash: null
  };

  output.receipt_hash = require('crypto')
    .createHash('sha256')
    .update(
      JSON.stringify({
        ts: output.ts,
        consumer: output.consumer,
        ambient_active: output.felt_state.ambient_active,
        batch_count: output.felt_state.subscribe_batch_count,
        degraded_reason: output.felt_state.degraded_reason,
        top_attention: output.felt_state.top_attention_summaries
      }),
      'utf8'
    )
    .digest('hex');

  const baseDir = path.join(ROOT, 'local', 'state', 'ops', 'cockpit_inside_probe');
  writeJson(path.join(baseDir, 'latest.json'), output);
  appendJsonl(path.join(baseDir, 'history.jsonl'), output);

  process.stdout.write(`${JSON.stringify(output)}\n`);
  process.exit(output.ok ? 0 : 1);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(
      `${JSON.stringify({
        ok: false,
        type: 'cockpit_inside_probe',
        ts: nowIso(),
        error: cleanText(err && err.message ? err.message : err || 'cockpit_inside_probe_failed', 180)
      })}\n`
    );
    process.exit(1);
  });
}
