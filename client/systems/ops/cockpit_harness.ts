#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  runAttentionCommand,
  runSpineCommand,
  runPersonaAmbientCommand,
  runDopamineAmbientCommand,
  runMemoryAmbientCommand
} = require('../../lib/spine_conduit_bridge');

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9._:@-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 24).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function toInt(v: unknown, fallback: number, lo: number, hi: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(filePath: string, value: any) {
  ensureDir(filePath);
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath: string, value: any) {
  ensureDir(filePath);
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function stableHash(value: any) {
  const canonical = JSON.stringify(value, Object.keys(value || {}).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function resolveRoot(args: Record<string, any>) {
  const raw = cleanText(args.root || process.env.COCKPIT_HARNESS_ROOT || '', 500);
  return raw ? path.resolve(raw) : ROOT;
}

function resolvePaths(root: string, args: Record<string, any>) {
  const inboxDir = cleanText(args['inbox-dir'] || process.env.COCKPIT_INBOX_DIR || '', 500)
    ? path.resolve(String(args['inbox-dir'] || process.env.COCKPIT_INBOX_DIR))
    : path.join(root, 'state', 'cockpit', 'inbox');
  return {
    inboxDir,
    latestPath: path.join(inboxDir, 'latest.json'),
    historyPath: path.join(inboxDir, 'history.jsonl'),
    statePath: path.join(inboxDir, 'state.json')
  };
}

function dayToken() {
  return new Date().toISOString().slice(0, 10);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/cockpit_harness.js once [--consumer=<id>] [--limit=<n>] [--root=<path>] [--inbox-dir=<path>]');
  console.log('  node systems/ops/cockpit_harness.js watch [--consumer=<id>] [--limit=<n>] [--once=1|0] [--duration-sec=<n>] [--root=<path>] [--inbox-dir=<path>]');
  console.log('  node systems/ops/cockpit_harness.js status [--root=<path>] [--inbox-dir=<path>]');
}

function loadHarnessState(paths: { statePath: string }, consumerId: string) {
  const state = readJson(paths.statePath, {});
  return {
    schema_id: 'cockpit_harness_state',
    schema_version: '1.0',
    sequence: Number(state && state.sequence || 0),
    last_ingest_ts: state && state.last_ingest_ts || null,
    last_batch_count: Number(state && state.last_batch_count || 0),
    last_attention_receipt_hash: state && state.last_attention_receipt_hash || null,
    consumer_id: state && state.consumer_id || consumerId,
    root: state && state.root || null
  };
}

async function fetchAttentionBatch(root: string, consumerId: string, limit: number) {
  const args = [
    'drain',
    `--consumer=${consumerId}`,
    `--limit=${limit}`,
    '--run-context=cockpit_harness'
  ];
  const out = await runAttentionCommand(args, { cwdHint: root });
  const payload = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  return {
    ok: !!(out && out.ok && payload && payload.ok === true),
    status: Number.isFinite(out && out.status) ? Number(out.status) : 1,
    payload,
    stderr: cleanText(out && out.stderr || '', 400)
  };
}

async function fetchAmbientSnapshots(root: string) {
  const date = dayToken();
  const [spine, personas, dopamine, memory] = await Promise.all([
    runSpineCommand(['status', '--mode=daily', `--date=${date}`], { cwdHint: root }),
    runPersonaAmbientCommand(['status'], { cwdHint: root }),
    runDopamineAmbientCommand(['status', `--date=${date}`], { cwdHint: root }),
    runMemoryAmbientCommand(['status'], { cwdHint: root })
  ]);
  const parse = (row: any) => (row && row.payload && typeof row.payload === 'object')
    ? row.payload
    : { ok: false, type: 'missing_payload' };
  return {
    spine: parse(spine),
    personas: parse(personas),
    dopamine: parse(dopamine),
    memory: parse(memory)
  };
}

async function ingestOnce(args: Record<string, any>) {
  const root = resolveRoot(args);
  const paths = resolvePaths(root, args);
  const consumerId = normalizeToken(args.consumer || process.env.COCKPIT_CONSUMER_ID || 'cockpit_llm', 80) || 'cockpit_llm';
  const limit = toInt(args.limit || process.env.COCKPIT_BATCH_LIMIT, 12, 1, 256);
  const state = loadHarnessState(paths, consumerId);

  const attention = await fetchAttentionBatch(root, consumerId, limit);
  if (!attention.ok || !attention.payload) {
    const receipt = {
      ok: false,
      type: 'cockpit_harness_once_error',
      ts: nowIso(),
      reason: attention.payload && attention.payload.reason
        ? cleanText(attention.payload.reason, 160)
        : cleanText(attention.stderr || 'attention_drain_failed', 160),
      consumer_id: consumerId,
      root,
      limit
    };
    receipt.receipt_hash = stableHash(receipt);
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
    return { ok: false, status: attention.status || 1, payload: receipt };
  }

  const snapshots = await fetchAmbientSnapshots(root);
  const events = Array.isArray(attention.payload.events) ? attention.payload.events : [];
  const nextSequence = Number(state.sequence || 0) + 1;
  const envelope: any = {
    ok: true,
    type: 'cockpit_context_envelope',
    ts: nowIso(),
    sequence: nextSequence,
    consumer_id: consumerId,
    root,
    attention: {
      batch_count: Number(events.length || 0),
      queue_depth: Number(attention.payload.queue_depth || 0),
      cursor_offset: Number(attention.payload.cursor_offset || 0),
      cursor_offset_after: Number(attention.payload.cursor_offset_after || 0),
      acked: attention.payload.acked === true,
      events
    },
    spine_status: snapshots.spine,
    persona_status: snapshots.personas,
    dopamine_status: snapshots.dopamine,
    memory_status: snapshots.memory,
    source_receipts: {
      attention_receipt_hash: attention.payload.receipt_hash || null,
      spine_receipt_hash: snapshots.spine && snapshots.spine.receipt_hash || null,
      persona_receipt_hash: snapshots.personas && snapshots.personas.receipt_hash || null,
      dopamine_receipt_hash: snapshots.dopamine && snapshots.dopamine.receipt_hash || null,
      memory_receipt_hash: snapshots.memory && snapshots.memory.receipt_hash || null
    }
  };
  envelope.receipt_hash = stableHash({
    sequence: envelope.sequence,
    consumer_id: envelope.consumer_id,
    attention_batch_count: envelope.attention.batch_count,
    attention_cursor_after: envelope.attention.cursor_offset_after,
    source_receipts: envelope.source_receipts
  });

  writeJson(paths.latestPath, envelope);
  appendJsonl(paths.historyPath, envelope);
  writeJson(paths.statePath, {
    ...state,
    sequence: nextSequence,
    last_ingest_ts: envelope.ts,
    last_batch_count: Number(events.length || 0),
    last_attention_receipt_hash: attention.payload.receipt_hash || null,
    consumer_id: consumerId,
    root
  });

  process.stdout.write(`${JSON.stringify(envelope)}\n`);
  return { ok: true, status: 0, payload: envelope };
}

async function status(args: Record<string, any>) {
  const root = resolveRoot(args);
  const paths = resolvePaths(root, args);
  const latest = readJson(paths.latestPath, null);
  const state = readJson(paths.statePath, null);
  const out = {
    ok: !!latest,
    type: 'cockpit_harness_status',
    ts: nowIso(),
    root,
    paths,
    sequence: latest && Number(latest.sequence || 0) || 0,
    consumer_id: latest && latest.consumer_id || (state && state.consumer_id) || null,
    last_ingest_ts: latest && latest.ts || (state && state.last_ingest_ts) || null,
    last_batch_count: latest && latest.attention ? Number(latest.attention.batch_count || 0) : Number(state && state.last_batch_count || 0),
    receipt_hash: latest && latest.receipt_hash || null
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  return out.ok ? 0 : 1;
}

async function watch(args: Record<string, any>) {
  const root = resolveRoot(args);
  const durationSec = toInt(args['duration-sec'], 0, 0, 86400);
  const runOnceFirst = toBool(args.once, true);
  if (runOnceFirst) {
    const out = await ingestOnce(args);
    if (!out.ok) {
      process.exit(out.status || 1);
      return;
    }
  }

  const statusOut = await runAttentionCommand(['status'], { cwdHint: root });
  const payload = statusOut && statusOut.payload && typeof statusOut.payload === 'object'
    ? statusOut.payload
    : {};
  const queuePath = payload && payload.attention_contract && payload.attention_contract.queue_path
    ? String(payload.attention_contract.queue_path)
    : path.join(root, 'state', 'attention', 'queue.jsonl');
  const queueDir = path.dirname(queuePath);
  const queueFile = path.basename(queuePath);

  let ingesting = false;
  let scheduled = false;
  let closed = false;
  let timer: any = null;

  const scheduleIngest = () => {
    if (closed) return;
    if (ingesting) {
      scheduled = true;
      return;
    }
    ingesting = true;
    ingestOnce(args)
      .catch((err) => {
        const out = {
          ok: false,
          type: 'cockpit_harness_watch_error',
          ts: nowIso(),
          reason: cleanText(err && err.message ? err.message : err || 'watch_ingest_failed', 180)
        };
        process.stderr.write(`${JSON.stringify(out)}\n`);
      })
      .finally(() => {
        ingesting = false;
        if (scheduled) {
          scheduled = false;
          scheduleIngest();
        }
      });
  };

  const watcher = fs.watch(queueDir, (eventType: string, filename: string) => {
    if (!filename) return;
    if (String(filename) !== queueFile) return;
    if (eventType !== 'change' && eventType !== 'rename') return;
    scheduleIngest();
  });

  const close = () => {
    if (closed) return;
    closed = true;
    try { watcher.close(); } catch {}
    if (timer) clearTimeout(timer);
  };

  process.on('SIGINT', () => {
    close();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    close();
    process.exit(0);
  });

  const started = {
    ok: true,
    type: 'cockpit_harness_watch_started',
    ts: nowIso(),
    queue_path: queuePath,
    root
  };
  process.stdout.write(`${JSON.stringify(started)}\n`);

  if (durationSec > 0) {
    timer = setTimeout(() => {
      close();
      const out = {
        ok: true,
        type: 'cockpit_harness_watch_complete',
        ts: nowIso(),
        duration_sec: durationSec
      };
      process.stdout.write(`${JSON.stringify(out)}\n`);
      process.exit(0);
    }, durationSec * 1000);
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 40) || 'status';
  if (cmd === 'help' || cmd === 'h') {
    usage();
    return;
  }
  if (cmd === 'once') {
    const out = await ingestOnce(args);
    process.exit(out.ok ? 0 : (Number(out.status) || 1));
    return;
  }
  if (cmd === 'watch') {
    await watch(args);
    return;
  }
  if (cmd === 'status') {
    const code = await status(args);
    process.exit(code);
    return;
  }
  usage();
  process.exit(2);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      type: 'cockpit_harness',
      ts: nowIso(),
      error: cleanText(err && err.message ? err.message : err || 'cockpit_harness_failed', 180)
    })}\n`);
    process.exit(1);
  });
}

module.exports = {
  ingestOnce,
  status
};
