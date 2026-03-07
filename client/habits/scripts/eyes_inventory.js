#!/usr/bin/env node
'use strict';

/**
 * eyes_inventory.js
 *
 * Deterministic source of truth for sensory "eyes".
 * Eyes are passive signal collectors only. They do not execute actions.
 *
 * Usage:
 *   node client/habits/scripts/eyes_inventory.js
 *   node client/habits/scripts/eyes_inventory.js --json
 *   node client/habits/scripts/eyes_inventory.js --help
 */

const fs = require('fs');
const path = require('path');
const { resolveCatalogPath } = require('../../lib/eyes_catalog.js');

const ROOT = path.resolve(__dirname, '..', '..');
const CONFIG_PATH = resolveCatalogPath(ROOT);
const REGISTRY_PATH = path.join(ROOT, 'state', 'sensory', 'eyes', 'registry.json');

function usage() {
  console.log('Usage:');
  console.log('  node client/habits/scripts/eyes_inventory.js');
  console.log('  node client/habits/scripts/eyes_inventory.js --json');
  console.log('  node client/habits/scripts/eyes_inventory.js --help');
  console.log('');
  console.log('Definition:');
  console.log('  Eyes are passive sensory sources only (see/collect/score/evolve cadence).');
  console.log('  Eyes never perform external actions (post/comment/upvote/write side-effects).');
}

function readJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

function getRows() {
  const cfg = readJson(CONFIG_PATH, { eyes: [] });
  const reg = readJson(REGISTRY_PATH, { eyes: [] });
  const regById = new Map((reg.eyes || []).map((e) => [e.id, e]));

  return (cfg.eyes || []).map((eye) => {
    const r = regById.get(eye.id) || {};
    return {
      id: eye.id,
      name: eye.name,
      status: typeof r.status === 'string' ? r.status : eye.status,
      parser_type: eye.parser_type || 'unknown',
      cadence_hours: Number.isFinite(Number(r.cadence_hours)) ? Number(r.cadence_hours) : Number(eye.cadence_hours),
      score_ema: Number.isFinite(Number(r.score_ema)) ? Number(r.score_ema) : Number(eye.score_ema),
      allowed_domains: Array.isArray(eye.allowed_domains) ? eye.allowed_domains : [],
      topics: Array.isArray(eye.topics) ? eye.topics : [],
      run_count: Number(r.run_count || 0),
      last_run: r.last_run || null
    };
  });
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    // no-arg standard: print inventory and exit 0
  } else if (args.includes('--help')) {
    usage();
    return;
  }

  const rows = getRows();
  if (args.includes('--json')) {
    process.stdout.write(JSON.stringify({
      kind: 'sensory_eyes_inventory',
      definition: 'passive_signal_sources_only',
      count: rows.length,
      eyes: rows
    }) + '\n');
    return;
  }

  console.log('Sensory Eyes Inventory');
  console.log('Boundary: eyes are passive sources only; tools are not eyes.');
  if (!rows.length) {
    console.log('No eyes configured.');
    return;
  }
  for (const e of rows) {
    console.log(`- ${e.id} (${e.status})`);
    console.log(`  name=${e.name} parser=${e.parser_type} cadence=${e.cadence_hours}h score_ema=${e.score_ema}`);
    console.log(`  domains=${e.allowed_domains.join(',') || 'none'} topics=${e.topics.join(',') || 'none'} runs=${e.run_count}`);
  }
}

if (require.main === module) main();

module.exports = { getRows };
