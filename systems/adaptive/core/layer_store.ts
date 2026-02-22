'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { stableUid, isAlnum } = require('../../../lib/uid.js');
const { enforceMutationProvenance } = require('../../../lib/mutation_provenance.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ADAPTIVE_ROOT = path.join(REPO_ROOT, 'adaptive');
const MUTATION_LOG_PATH = path.join(REPO_ROOT, 'state', 'security', 'adaptive_mutations.jsonl');
const ADAPTIVE_POINTERS_PATH = path.join(REPO_ROOT, 'state', 'memory', 'adaptive_pointers.jsonl');
const ADAPTIVE_POINTER_INDEX_PATH = path.join(REPO_ROOT, 'state', 'memory', 'adaptive_pointer_index.json');
const WRITE_LOCK_TIMEOUT_MS = Number(process.env.ADAPTIVE_WRITE_LOCK_TIMEOUT_MS || 8000);
const WRITE_LOCK_RETRY_MS = Number(process.env.ADAPTIVE_WRITE_LOCK_RETRY_MS || 15);
const WRITE_LOCK_STALE_MS = Number(process.env.ADAPTIVE_WRITE_LOCK_STALE_MS || 30000);

function nowIso() {
  return new Date().toISOString();
}

function hash16(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex').slice(0, 16);
}

function normalizePathString(v) {
  return String(v || '').replace(/\\/g, '/');
}

function isWithinAdaptiveRoot(targetPath) {
  const abs = path.resolve(String(targetPath || ''));
  const rel = normalizePathString(path.relative(ADAPTIVE_ROOT, abs));
  if (!rel || rel === '') return true;
  return !rel.startsWith('../') && rel !== '..';
}

function resolveAdaptivePath(targetPath) {
  const raw = String(targetPath || '').trim();
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(ADAPTIVE_ROOT, raw);
  if (!isWithinAdaptiveRoot(abs)) {
    throw new Error(`adaptive_store: target outside adaptive root: ${abs}`);
  }
  const rel = normalizePathString(path.relative(ADAPTIVE_ROOT, abs));
  if (!rel || rel === '') {
    throw new Error('adaptive_store: target must be file path under adaptive/');
  }
  return { abs, rel };
}

function cloneJsonSafe(v) {
  return JSON.parse(JSON.stringify(v));
}

function sleepMs(ms) {
  const dur = Math.max(0, Number(ms) || 0);
  if (dur <= 0) return;
  try {
    const buf = new SharedArrayBuffer(4);
    const view = new Int32Array(buf);
    Atomics.wait(view, 0, 0, dur);
    return;
  } catch {
    const end = Date.now() + dur;
    while (Date.now() < end) {
      // busy wait fallback for runtimes without Atomics.wait
    }
  }
}

function lockPathFor(absPath) {
  return `${String(absPath)}.write.lock`;
}

function acquireWriteLock(absPath) {
  const lockPath = lockPathFor(absPath);
  const started = Date.now();
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try {
        const body = JSON.stringify({
          pid: process.pid,
          ts: nowIso(),
          path: absPath
        });
        fs.writeFileSync(fd, `${body}\n`, 'utf8');
        fs.fsyncSync(fd);
      } catch {
        // lock content best-effort only
      }
      return { fd, lockPath, waited_ms: Date.now() - started };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      let stale = false;
      try {
        const st = fs.statSync(lockPath);
        stale = (Date.now() - Number(st.mtimeMs || 0)) > WRITE_LOCK_STALE_MS;
      } catch {
        stale = false;
      }
      if (stale) {
        try {
          fs.rmSync(lockPath, { force: true });
          continue;
        } catch {
          // continue retrying
        }
      }
      if ((Date.now() - started) >= WRITE_LOCK_TIMEOUT_MS) {
        throw new Error(`adaptive_store: write lock timeout for ${absPath}`);
      }
      sleepMs(WRITE_LOCK_RETRY_MS);
    }
  }
}

function releaseWriteLock(lock) {
  if (!lock || typeof lock !== 'object') return;
  try {
    if (Number.isInteger(lock.fd)) fs.closeSync(lock.fd);
  } catch {
    // ignore
  }
  try {
    if (lock.lockPath) fs.rmSync(lock.lockPath, { force: true });
  } catch {
    // ignore
  }
}

function withSingleWriter(absPath, fn) {
  const lock = acquireWriteLock(absPath);
  try {
    return fn(lock);
  } finally {
    releaseWriteLock(lock);
  }
}

function appendMutationLog(event) {
  try {
    fs.mkdirSync(path.dirname(MUTATION_LOG_PATH), { recursive: true });
    fs.appendFileSync(MUTATION_LOG_PATH, JSON.stringify(event) + '\n', 'utf8');
  } catch {
    // Must never block caller.
  }
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeTag(v) {
  return String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
}

function cleanText(v, maxLen = 160) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function pointerIndexLoad() {
  const base = readJsonSafe(ADAPTIVE_POINTER_INDEX_PATH, { version: '1.0', pointers: {} });
  if (!base || typeof base !== 'object') return { version: '1.0', pointers: {} };
  if (!base.pointers || typeof base.pointers !== 'object') base.pointers = {};
  return base;
}

function pointerIndexSave(index) {
  fs.mkdirSync(path.dirname(ADAPTIVE_POINTER_INDEX_PATH), { recursive: true });
  fs.writeFileSync(ADAPTIVE_POINTER_INDEX_PATH, JSON.stringify({
    version: '1.0',
    updated_ts: nowIso(),
    pointers: index && index.pointers && typeof index.pointers === 'object' ? index.pointers : {}
  }, null, 2) + '\n', 'utf8');
}

function appendAdaptivePointerRows(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return { emitted: 0, skipped: 0 };
  const index = pointerIndexLoad();
  let emitted = 0;
  let skipped = 0;
  fs.mkdirSync(path.dirname(ADAPTIVE_POINTERS_PATH), { recursive: true });
  for (const row of rows) {
    const key = `${String(row.kind || '')}|${String(row.uid || '')}|${String(row.path_ref || '')}|${String(row.entity_id || '')}`;
    const hash = hash16(JSON.stringify({
      uid: row.uid,
      kind: row.kind,
      path_ref: row.path_ref,
      entity_id: row.entity_id || null,
      tags: row.tags || [],
      summary: row.summary || '',
      status: row.status || ''
    }));
    if (index.pointers[key] === hash) {
      skipped++;
      continue;
    }
    fs.appendFileSync(ADAPTIVE_POINTERS_PATH, JSON.stringify(row) + '\n', 'utf8');
    index.pointers[key] = hash;
    emitted++;
  }
  pointerIndexSave(index);
  return { emitted, skipped };
}

function projectAdaptivePointers(relPath, obj, op, meta = {}) {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  const ts = nowIso();
  const pathRef = `adaptive/${String(relPath || '').replace(/\\/g, '/')}`;
  const actor = String(m.actor || process.env.USER || 'unknown').slice(0, 80);
  const source = String(m.source || '').slice(0, 120);
  const reason = String(m.reason || '').slice(0, 160);
  const rows = [];

  if (String(relPath) === 'sensory/eyes/catalog.json' && obj && Array.isArray(obj.eyes)) {
    for (const eyeRaw of obj.eyes) {
      if (!eyeRaw || typeof eyeRaw !== 'object') continue;
      const eye = { ...eyeRaw };
      const eyeId = cleanText(eye.id, 64);
      const eyeUidCandidate = cleanText(eye.uid, 64);
      const eyeUid = eyeUidCandidate && isAlnum(eyeUidCandidate)
        ? eyeUidCandidate
        : stableUid(`adaptive_eye|${eyeId}|v1`, { prefix: 'e', length: 24 });
      const topicTags = Array.isArray(eye.topics)
        ? eye.topics.map((t) => normalizeTag(t)).filter(Boolean).slice(0, 8)
        : [];
      const tags = Array.from(new Set(['adaptive', 'sensory', 'eyes', normalizeTag(eye.status || 'active'), ...topicTags])).filter(Boolean);
      rows.push({
        ts,
        op,
        source: 'adaptive_layer_store',
        source_path: source || null,
        reason: reason || null,
        actor,
        kind: 'adaptive_eye',
        layer: 'sensory',
        uid: eyeUid,
        entity_id: eyeId || null,
        status: cleanText(eye.status || 'active', 24),
        tags,
        summary: cleanText(eye.name || eye.id || 'Adaptive eye'),
        path_ref: pathRef,
        created_ts: cleanText(eye.created_ts || ts, 40),
        updated_ts: ts
      });
    }
    return rows;
  }

  if (obj && typeof obj === 'object') {
    const uidCandidate = cleanText(obj.uid, 64);
    const uid = uidCandidate && isAlnum(uidCandidate)
      ? uidCandidate
      : stableUid(`adaptive_blob|${relPath}|v1`, { prefix: 'a', length: 24 });
    const segments = String(relPath || '').split('/').filter(Boolean);
    const layer = segments.length ? normalizeTag(segments[0]) : 'adaptive';
    const kind = `adaptive_${normalizeTag(segments.join('_') || 'blob')}`;
    const tags = ['adaptive', layer].filter(Boolean);
    rows.push({
      ts,
      op,
      source: 'adaptive_layer_store',
      source_path: source || null,
      reason: reason || null,
      actor,
      kind,
      layer,
      uid,
      entity_id: null,
      status: 'active',
      tags,
      summary: cleanText(`Adaptive record: ${relPath}`),
      path_ref: pathRef,
      created_ts: ts,
      updated_ts: ts
    });
  }
  return rows;
}

function emitAdaptivePointers(relPath, obj, op, meta = {}) {
  try {
    const rows = projectAdaptivePointers(relPath, obj, op, meta);
    return appendAdaptivePointerRows(rows);
  } catch {
    return { emitted: 0, skipped: 0 };
  }
}

function readJson(targetPath, fallback = null) {
  try {
    const { abs } = resolveAdaptivePath(targetPath);
    if (!fs.existsSync(abs)) return fallback;
    return JSON.parse(fs.readFileSync(abs, 'utf8'));
  } catch {
    return fallback;
  }
}

function atomicWriteJson(absPath, obj) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const body = JSON.stringify(obj, null, 2) + '\n';
  let fd = null;
  try {
    fd = fs.openSync(tmpPath, 'w', 0o600);
    fs.writeSync(fd, body, null, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    fs.renameSync(tmpPath, absPath);

    try {
      const outFd = fs.openSync(absPath, 'r');
      try { fs.fsyncSync(outFd); } finally { fs.closeSync(outFd); }
    } catch {
      // best-effort durability
    }
    try {
      const dirFd = fs.openSync(path.dirname(absPath), 'r');
      try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
    } catch {
      // best-effort durability
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try {
      if (fs.existsSync(tmpPath)) fs.rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
}

function setJson(targetPath, obj, meta = {}) {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  const { abs, rel } = resolveAdaptivePath(targetPath);
  const provenance = enforceMutationProvenance('adaptive', m, {
    fallbackSource: 'systems/adaptive/core/layer_store.js',
    defaultReason: 'adaptive_set',
    context: `adaptive/${rel}`
  });
  const pm = provenance.meta;
  return withSingleWriter(abs, (lock) => {
    atomicWriteJson(abs, obj);
    appendMutationLog({
      ts: nowIso(),
      op: 'set',
      rel_path: rel,
      actor: String(pm.actor || process.env.USER || 'unknown').slice(0, 80),
      source: String(pm.source || '').slice(0, 120),
      reason: String(pm.reason || 'unspecified').slice(0, 160),
      provenance_ok: provenance.ok,
      provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
      lock_wait_ms: Number(lock && lock.waited_ms || 0),
      value_hash: hash16(JSON.stringify(obj))
    });
    emitAdaptivePointers(rel, obj, 'set', pm);
    return obj;
  });
}

function ensureJson(targetPath, defaultValue, meta = {}) {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  const { abs, rel } = resolveAdaptivePath(targetPath);
  const provenance = enforceMutationProvenance('adaptive', m, {
    fallbackSource: 'systems/adaptive/core/layer_store.js',
    defaultReason: 'adaptive_ensure',
    context: `adaptive/${rel}`
  });
  const pm = provenance.meta;
  return withSingleWriter(abs, (lock) => {
    if (fs.existsSync(abs)) {
      try {
        return JSON.parse(fs.readFileSync(abs, 'utf8'));
      } catch {
        // fallthrough to rewrite deterministic default
      }
    }
    const next = typeof defaultValue === 'function' ? defaultValue() : defaultValue;
    atomicWriteJson(abs, next);
    appendMutationLog({
      ts: nowIso(),
      op: 'ensure',
      rel_path: rel,
      actor: String(pm.actor || process.env.USER || 'unknown').slice(0, 80),
      source: String(pm.source || '').slice(0, 120),
      reason: String(pm.reason || 'ensure_default').slice(0, 160),
      provenance_ok: provenance.ok,
      provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
      lock_wait_ms: Number(lock && lock.waited_ms || 0),
      value_hash: hash16(JSON.stringify(next))
    });
    emitAdaptivePointers(rel, next, 'ensure', pm);
    return next;
  });
}

function mutateJson(targetPath, mutator, meta = {}) {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  if (typeof mutator !== 'function') {
    throw new Error('adaptive_store: mutator must be function');
  }
  const { abs, rel } = resolveAdaptivePath(targetPath);
  const provenance = enforceMutationProvenance('adaptive', m, {
    fallbackSource: 'systems/adaptive/core/layer_store.js',
    defaultReason: 'adaptive_mutate',
    context: `adaptive/${rel}`
  });
  const pm = provenance.meta;
  return withSingleWriter(abs, (lock) => {
    const current = readJson(targetPath, null);
    const base = current == null ? {} : cloneJsonSafe(current);
    const mutated = mutator(base);
    if (mutated == null || typeof mutated !== 'object') {
      throw new Error('adaptive_store: mutator must return object');
    }
    atomicWriteJson(abs, mutated);
    appendMutationLog({
      ts: nowIso(),
      op: 'set',
      rel_path: rel,
      actor: String(pm.actor || process.env.USER || 'unknown').slice(0, 80),
      source: String(pm.source || '').slice(0, 120),
      reason: String(pm.reason || 'mutate').slice(0, 160),
      provenance_ok: provenance.ok,
      provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
      lock_wait_ms: Number(lock && lock.waited_ms || 0),
      value_hash: hash16(JSON.stringify(mutated))
    });
    emitAdaptivePointers(rel, mutated, 'set', pm);
    return mutated;
  });
}

function deletePath(targetPath, meta = {}) {
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  const { abs, rel } = resolveAdaptivePath(targetPath);
  const provenance = enforceMutationProvenance('adaptive', m, {
    fallbackSource: 'systems/adaptive/core/layer_store.js',
    defaultReason: 'adaptive_delete',
    context: `adaptive/${rel}`
  });
  const pm = provenance.meta;
  if (fs.existsSync(abs)) {
    fs.rmSync(abs, { force: true });
  }
  appendMutationLog({
    ts: nowIso(),
    op: 'delete',
    rel_path: rel,
    actor: String(pm.actor || process.env.USER || 'unknown').slice(0, 80),
    source: String(pm.source || '').slice(0, 120),
    reason: String(pm.reason || 'delete').slice(0, 160),
    provenance_ok: provenance.ok,
    provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : []
  });
  emitAdaptivePointers(rel, { uid: stableUid(`adaptive_blob|${rel}|v1`, { prefix: 'a', length: 24 }) }, 'delete', pm);
}

module.exports = {
  REPO_ROOT,
  ADAPTIVE_ROOT,
  MUTATION_LOG_PATH,
  ADAPTIVE_POINTERS_PATH,
  ADAPTIVE_POINTER_INDEX_PATH,
  isWithinAdaptiveRoot,
  resolveAdaptivePath,
  readJson,
  ensureJson,
  setJson,
  mutateJson,
  deletePath
};

export {};
