'use strict';

const path = require('path');
const { stableUid, randomUid, isAlnum } = require('../../../../lib/uid.js');
const {
  ADAPTIVE_ROOT,
  readJson,
  ensureJson,
  setJson,
  mutateJson
} = require('../../core/layer_store.js');

const DEFAULT_REL_PATH = 'sensory/eyes/catalog.json';
const DEFAULT_ABS_PATH = path.join(ADAPTIVE_ROOT, DEFAULT_REL_PATH);

function defaultCatalog() {
  return {
    version: '1.0',
    eyes: [],
    global_limits: {
      max_concurrent_runs: 3,
      global_max_requests_per_day: 50,
      global_max_bytes_per_day: 5242880
    },
    scoring: {
      ema_alpha: 0.3,
      score_threshold_high: 70,
      score_threshold_low: 30,
      score_threshold_dormant: 20,
      cadence_min_hours: 1,
      cadence_max_hours: 168
    }
  };
}

function nowIso() {
  return new Date().toISOString();
}

function normalizeEyeUid(eye, takenUids) {
  const candidate = String(eye && eye.uid || '').trim();
  if (candidate && isAlnum(candidate) && !takenUids.has(candidate)) {
    return candidate;
  }
  const idSeed = String(eye && eye.id || '').trim();
  const seeded = idSeed ? stableUid(`adaptive_eye|${idSeed}|v1`, { prefix: 'e', length: 24 }) : '';
  if (seeded && !takenUids.has(seeded)) return seeded;
  let uid = randomUid({ prefix: 'e', length: 24 });
  let attempts = 0;
  while (takenUids.has(uid) && attempts < 8) {
    uid = randomUid({ prefix: 'e', length: 24 });
    attempts++;
  }
  return uid;
}

function normalizeEyesArray(eyes) {
  const src = Array.isArray(eyes) ? eyes : [];
  const taken = new Set();
  const out = [];
  const ts = nowIso();
  for (const raw of src) {
    if (!raw || typeof raw !== 'object') continue;
    const eye = { ...raw };
    eye.uid = normalizeEyeUid(eye, taken);
    taken.add(eye.uid);
    eye.created_ts = String(eye.created_ts || ts);
    eye.updated_ts = String(ts);
    out.push(eye);
  }
  return out;
}

function normalizeCatalog(catalog, fallback = null) {
  const src = catalog && typeof catalog === 'object' ? { ...catalog } : fallback;
  if (!src || typeof src !== 'object') return fallback;
  src.eyes = normalizeEyesArray(src.eyes);
  return src;
}

function asCatalogPath(filePath) {
  const canonical = DEFAULT_ABS_PATH;
  const raw = String(filePath || '').trim();
  if (!raw) return canonical;
  const requested = path.resolve(raw);
  if (requested !== canonical) {
    throw new Error(`catalog_store: catalog path override denied (requested=${requested})`);
  }
  return canonical;
}

function readCatalog(filePath, fallback = null) {
  const abs = asCatalogPath(filePath);
  return normalizeCatalog(readJson(abs, fallback), fallback);
}

function ensureCatalog(filePath, meta = {}) {
  const abs = asCatalogPath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  return normalizeCatalog(
    ensureJson(abs, defaultCatalog, {
      ...m,
      source: m.source || 'systems/adaptive/sensory/eyes/catalog_store.js',
      reason: m.reason || 'ensure_catalog'
    }),
    defaultCatalog()
  );
}

function setCatalog(filePath, nextCatalog, meta = {}) {
  const abs = asCatalogPath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  const normalized = normalizeCatalog(nextCatalog, defaultCatalog());
  return normalizeCatalog(
    setJson(abs, normalized, {
      ...m,
      source: m.source || 'systems/adaptive/sensory/eyes/catalog_store.js',
      reason: m.reason || 'set_catalog'
    }),
    defaultCatalog()
  );
}

function mutateCatalog(filePath, mutator, meta = {}) {
  const abs = asCatalogPath(filePath);
  const m = (meta && typeof meta === 'object' ? meta : {}) as Record<string, any>;
  if (typeof mutator !== 'function') {
    throw new Error('catalog_store: mutator must be function');
  }
  return normalizeCatalog(
    mutateJson(
      abs,
      (current) => {
        const base = normalizeCatalog(current, defaultCatalog());
        const next = mutator({ ...base, eyes: Array.isArray(base.eyes) ? base.eyes.slice() : [] });
        return normalizeCatalog(next, base);
      },
      {
        ...m,
        source: m.source || 'systems/adaptive/sensory/eyes/catalog_store.js',
        reason: m.reason || 'mutate_catalog'
      }
    ),
    defaultCatalog()
  );
}

module.exports = {
  DEFAULT_REL_PATH,
  DEFAULT_ABS_PATH,
  defaultCatalog,
  readCatalog,
  ensureCatalog,
  setCatalog,
  mutateCatalog
};

export {};
