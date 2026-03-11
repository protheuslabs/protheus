'use strict';

// Layer ownership: core/layer1/storage via core/layer2/ops (authoritative)
// Thin TypeScript wrapper only.

const { createOpsLaneBridge } = require('../../../../../runtime/lib/rust_lane_bridge.ts');

const bridge = createOpsLaneBridge(__dirname, 'collector_cache', 'collector-cache');
const DEFAULT_MAX_AGE_HOURS = Number(process.env.EYES_COLLECTOR_CACHE_MAX_AGE_HOURS || 12);

function loadCollectorCache(id, maxAgeHours = DEFAULT_MAX_AGE_HOURS) {
  const out = bridge.run([
    'load',
    `--collector-id=${String(id || 'collector')}`,
    `--max-age-hours=${String(maxAgeHours)}`
  ]);
  if (!out || !out.payload || typeof out.payload !== 'object') return null;
  const cache = out.payload.cache;
  return cache && typeof cache === 'object' ? cache : null;
}

function saveCollectorCache(id, items) {
  if (!Array.isArray(items) || !items.length) return;
  bridge.run([
    'save',
    `--collector-id=${String(id || 'collector')}`,
    `--items-json=${JSON.stringify(items)}`
  ]);
}

module.exports = {
  loadCollectorCache,
  saveCollectorCache
};
