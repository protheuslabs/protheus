const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const CACHE_DIR = process.env.EYES_COLLECTOR_CACHE_DIR
  ? path.resolve(process.env.EYES_COLLECTOR_CACHE_DIR)
  : path.join(ROOT, "state", "sensory", "eyes", "cache");
const DEFAULT_MAX_AGE_HOURS = Number(process.env.EYES_COLLECTOR_CACHE_MAX_AGE_HOURS || 12);

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function cachePath(id) {
  const safe = String(id || "collector")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "_");
  return path.join(CACHE_DIR, `${safe}.json`);
}

function loadCollectorCache(id, maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
  const fp = cachePath(id);
  if (!fs.existsSync(fp)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!raw || !Array.isArray(raw.items)) return null;
    const ts = Date.parse(String(raw.ts || ""));
    if (!Number.isFinite(ts)) return null;
    const ageMs = Date.now() - ts;
    const maxAgeMs = Math.max(1, Number(maxAgeHours || DEFAULT_MAX_AGE_HOURS)) * 60 * 60 * 1000;
    if (ageMs > maxAgeMs) return null;
    return {
      ts: raw.ts,
      age_ms: ageMs,
      items: raw.items
    };
  } catch {
    return null;
  }
}

function saveCollectorCache(id, items) {
  if (!Array.isArray(items) || !items.length) return;
  ensureDir(CACHE_DIR);
  const fp = cachePath(id);
  const payload = {
    ts: new Date().toISOString(),
    count: items.length,
    items
  };
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2));
}

module.exports = {
  loadCollectorCache,
  saveCollectorCache
};
