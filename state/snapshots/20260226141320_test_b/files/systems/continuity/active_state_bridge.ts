#!/usr/bin/env node
'use strict';

/**
 * active_state_bridge.js
 *
 * Cross-device active state continuity bridge with lease-based active writer control.
 *
 * Usage:
 *   node systems/continuity/active_state_bridge.js status
 *   node systems/continuity/active_state_bridge.js acquire --writer=<id> [--ttl-sec=N]
 *   node systems/continuity/active_state_bridge.js renew --writer=<id> [--ttl-sec=N]
 *   node systems/continuity/active_state_bridge.js release --writer=<id>
 *   node systems/continuity/active_state_bridge.js checkpoint --writer=<id> [--label=<name>]
 *   node systems/continuity/active_state_bridge.js replay --writer=<id> --checkpoint=<id> [--dry-run]
 *   node systems/continuity/active_state_bridge.js --help
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = process.env.CONTINUITY_ROOT
  ? path.resolve(process.env.CONTINUITY_ROOT)
  : path.resolve(__dirname, '..', '..');
const STATE_DIR = process.env.CONTINUITY_STATE_DIR
  ? path.resolve(process.env.CONTINUITY_STATE_DIR)
  : path.join(ROOT, 'state', 'continuity');
const LEASE_PATH = path.join(STATE_DIR, 'lease.json');
const CHECKPOINT_DIR = path.join(STATE_DIR, 'checkpoints');
const INDEX_PATH = path.join(CHECKPOINT_DIR, 'index.json');
const AUDIT_PATH = path.join(STATE_DIR, 'events.jsonl');

const DEFAULT_PATHS = [
  'state/autonomy/cooldowns.json',
  'state/routing/route_state.json',
  'state/spawn/allocations.json',
  'state/adaptive/strategy/outcome_fitness.json',
  'state/sensory/eyes/registry.json'
];

function usage() {
  console.log('Usage:');
  console.log('  node systems/continuity/active_state_bridge.js status');
  console.log('  node systems/continuity/active_state_bridge.js acquire --writer=<id> [--ttl-sec=N]');
  console.log('  node systems/continuity/active_state_bridge.js renew --writer=<id> [--ttl-sec=N]');
  console.log('  node systems/continuity/active_state_bridge.js release --writer=<id>');
  console.log('  node systems/continuity/active_state_bridge.js checkpoint --writer=<id> [--label=<name>]');
  console.log('  node systems/continuity/active_state_bridge.js replay --writer=<id> --checkpoint=<id> [--dry-run]');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function nowMs() {
  return Date.now();
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, obj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function normalizeWriter(v) {
  return String(v || '').trim().replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
}

function leaseState() {
  const raw = readJsonSafe(LEASE_PATH, {});
  return raw && typeof raw === 'object' ? raw : {};
}

function parseMs(value) {
  const n = Date.parse(String(value || ''));
  return Number.isFinite(n) ? n : null;
}

function leaseActive(lease) {
  const exp = parseMs(lease && lease.expires_at);
  return Number.isFinite(exp) && exp > nowMs();
}

function requiresOwner(args) {
  const writer = normalizeWriter(args.writer || '');
  if (!writer) throw new Error('missing --writer');
  return writer;
}

function ttlSec(args) {
  const raw = Number(args['ttl-sec'] || args.ttl_sec || 600);
  if (!Number.isFinite(raw)) return 600;
  return Math.max(60, Math.min(Math.round(raw), 86400));
}

function checkOwner(writer, allowExpiredTakeover) {
  const lease = leaseState();
  const active = leaseActive(lease);
  const owner = normalizeWriter(lease.writer || '');
  if (!owner || !active) {
    if (allowExpiredTakeover) return { ok: true, lease, active, owner };
    return { ok: false, reason: 'no_active_lease', lease, active, owner };
  }
  if (owner !== writer) {
    return { ok: false, reason: 'lease_owned_by_other_writer', lease, active, owner };
  }
  return { ok: true, lease, active, owner };
}

function loadIndex() {
  const raw = readJsonSafe(INDEX_PATH, { checkpoints: [] });
  if (!raw || typeof raw !== 'object') return { checkpoints: [] };
  if (!Array.isArray(raw.checkpoints)) raw.checkpoints = [];
  return raw;
}

function saveIndex(index) {
  writeJsonAtomic(INDEX_PATH, index && typeof index === 'object' ? index : { checkpoints: [] });
}

function sanitizeSecrets(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => sanitizeSecrets(v));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = String(k || '').toLowerCase();
    if (/(token|secret|password|credential|api[_-]?key|bearer|authorization)/.test(key)) {
      out[k] = '[REDACTED]';
      continue;
    }
    out[k] = sanitizeSecrets(v);
  }
  return out;
}

function normalizeRelPath(p) {
  return String(p || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function readCheckpointSources() {
  const docs = [];
  for (const relRaw of DEFAULT_PATHS) {
    const rel = normalizeRelPath(relRaw);
    if (!rel || rel.includes('..')) continue;
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const raw = readJsonSafe(abs, null);
    if (raw == null) continue;
    docs.push({ path: rel, value: sanitizeSecrets(raw) });
  }
  docs.sort((a, b) => a.path.localeCompare(b.path));
  return docs;
}

function checkpointId(writer) {
  const ts = nowIso().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const nonce = crypto.randomBytes(4).toString('hex');
  return `ckpt_${writer}_${ts}_${nonce}`;
}

function writeCheckpoint(writer, label) {
  const docs = readCheckpointSources();
  const index = loadIndex();
  const prev = index.checkpoints.length ? index.checkpoints[index.checkpoints.length - 1] : null;
  const prevMap = new Map((prev && Array.isArray(prev.docs) ? prev.docs : []).map((d) => [d.path, JSON.stringify(d.value)]));
  const deltas = docs.filter((d) => prevMap.get(d.path) !== JSON.stringify(d.value)).map((d) => d.path);

  const id = checkpointId(writer);
  const row = {
    id,
    ts: nowIso(),
    writer,
    label: String(label || '').trim().slice(0, 120) || null,
    docs,
    delta_paths: deltas
  };
  ensureDir(CHECKPOINT_DIR);
  writeJsonAtomic(path.join(CHECKPOINT_DIR, `${id}.json`), row);

  index.checkpoints.push({
    id,
    ts: row.ts,
    writer,
    label: row.label,
    docs: docs.map((d) => ({ path: d.path, value: d.value })),
    delta_paths: deltas
  });
  index.checkpoints = index.checkpoints.slice(-200);
  saveIndex(index);

  return row;
}

function replayCheckpoint(checkpoint, dryRun) {
  const docs = Array.isArray(checkpoint && checkpoint.docs) ? checkpoint.docs : [];
  const applied = [];
  for (const doc of docs) {
    const rel = normalizeRelPath(doc && doc.path);
    if (!rel || rel.includes('..')) continue;
    const abs = path.join(ROOT, rel);
    if (dryRun) {
      applied.push({ path: rel, applied: false, dry_run: true });
      continue;
    }
    writeJsonAtomic(abs, doc.value);
    applied.push({ path: rel, applied: true, dry_run: false });
  }
  return applied;
}

function cmdStatus() {
  const lease = leaseState();
  const index = loadIndex();
  process.stdout.write(JSON.stringify({
    ok: true,
    ts: nowIso(),
    lease: {
      writer: normalizeWriter(lease.writer || ''),
      acquired_at: lease.acquired_at || null,
      expires_at: lease.expires_at || null,
      active: leaseActive(lease)
    },
    checkpoints: {
      total: index.checkpoints.length,
      latest_id: index.checkpoints.length ? index.checkpoints[index.checkpoints.length - 1].id : null
    }
  }) + '\n');
}

function cmdAcquire(args) {
  const writer = requiresOwner(args);
  const ttl = ttlSec(args);
  const check = checkOwner(writer, true);
  if (!check.ok && check.reason === 'lease_owned_by_other_writer') {
    process.stdout.write(JSON.stringify({ ok: false, reason: check.reason, owner: check.owner }) + '\n');
    process.exit(1);
    return;
  }

  const lease = {
    writer,
    acquired_at: nowIso(),
    expires_at: new Date(nowMs() + ttl * 1000).toISOString(),
    ttl_sec: ttl
  };
  writeJsonAtomic(LEASE_PATH, lease);
  appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'continuity_acquire', writer, ttl_sec: ttl });
  process.stdout.write(JSON.stringify({ ok: true, lease }) + '\n');
}

function cmdRenew(args) {
  const writer = requiresOwner(args);
  const ttl = ttlSec(args);
  const check = checkOwner(writer, false);
  if (!check.ok) {
    process.stdout.write(JSON.stringify({ ok: false, reason: check.reason, owner: check.owner || null }) + '\n');
    process.exit(1);
    return;
  }
  const lease = {
    writer,
    acquired_at: check.lease.acquired_at || nowIso(),
    expires_at: new Date(nowMs() + ttl * 1000).toISOString(),
    ttl_sec: ttl
  };
  writeJsonAtomic(LEASE_PATH, lease);
  appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'continuity_renew', writer, ttl_sec: ttl });
  process.stdout.write(JSON.stringify({ ok: true, lease }) + '\n');
}

function cmdRelease(args) {
  const writer = requiresOwner(args);
  const check = checkOwner(writer, false);
  if (!check.ok) {
    process.stdout.write(JSON.stringify({ ok: false, reason: check.reason, owner: check.owner || null }) + '\n');
    process.exit(1);
    return;
  }
  if (fs.existsSync(LEASE_PATH)) fs.rmSync(LEASE_PATH, { force: true });
  appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'continuity_release', writer });
  process.stdout.write(JSON.stringify({ ok: true, released: true, writer }) + '\n');
}

function cmdCheckpoint(args) {
  const writer = requiresOwner(args);
  const check = checkOwner(writer, false);
  if (!check.ok) {
    process.stdout.write(JSON.stringify({ ok: false, reason: check.reason, owner: check.owner || null }) + '\n');
    process.exit(1);
    return;
  }
  const row = writeCheckpoint(writer, args.label || '');
  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'continuity_checkpoint',
    writer,
    checkpoint_id: row.id,
    docs: row.docs.length,
    delta_paths: row.delta_paths.length
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    checkpoint_id: row.id,
    docs: row.docs.length,
    delta_paths: row.delta_paths,
    label: row.label
  }) + '\n');
}

function cmdReplay(args) {
  const writer = requiresOwner(args);
  const check = checkOwner(writer, false);
  if (!check.ok) {
    process.stdout.write(JSON.stringify({ ok: false, reason: check.reason, owner: check.owner || null }) + '\n');
    process.exit(1);
    return;
  }
  const checkpointId = String(args.checkpoint || '').trim();
  if (!checkpointId) {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'missing_checkpoint' }) + '\n');
    process.exit(2);
    return;
  }
  const checkpointPath = path.join(CHECKPOINT_DIR, `${checkpointId}.json`);
  const checkpoint = readJsonSafe(checkpointPath, null);
  if (!checkpoint || typeof checkpoint !== 'object') {
    process.stdout.write(JSON.stringify({ ok: false, reason: 'checkpoint_not_found', checkpoint_id: checkpointId }) + '\n');
    process.exit(1);
    return;
  }

  const dryRun = args['dry-run'] === true || args.dry_run === true;
  const applied = replayCheckpoint(checkpoint, dryRun);
  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'continuity_replay',
    writer,
    checkpoint_id: checkpointId,
    dry_run: dryRun,
    applied: applied.length
  });
  process.stdout.write(JSON.stringify({
    ok: true,
    checkpoint_id: checkpointId,
    dry_run: dryRun,
    applied
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help === true) {
    usage();
    return;
  }
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'acquire') return cmdAcquire(args);
  if (cmd === 'renew') return cmdRenew(args);
  if (cmd === 'release') return cmdRelease(args);
  if (cmd === 'checkpoint') return cmdCheckpoint(args);
  if (cmd === 'replay') return cmdReplay(args);
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, error: String(err && err.message || err || 'active_state_bridge_failed') }) + '\n');
    process.exit(1);
  }
}
export {};
