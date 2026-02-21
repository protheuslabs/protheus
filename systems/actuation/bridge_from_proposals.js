#!/usr/bin/env node
'use strict';

/**
 * Deterministic bridge:
 * proposal metadata hints -> meta.actuation payload
 *
 * Usage:
 *   node systems/actuation/bridge_from_proposals.js run [YYYY-MM-DD] [--dry-run]
 *   node systems/actuation/bridge_from_proposals.js --help
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PROPOSALS_DIR = path.join(ROOT, 'state', 'sensory', 'proposals');

function todayStr() { return new Date().toISOString().slice(0, 10); }

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/bridge_from_proposals.js run [YYYY-MM-DD] [--dry-run]');
  console.log('  node systems/actuation/bridge_from_proposals.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const i = a.indexOf('=');
    if (i === -1) out[a.slice(2)] = true;
    else out[a.slice(2, i)] = a.slice(i + 1);
  }
  return out;
}

function readJson(fp) {
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

function writeJsonAtomic(fp, obj) {
  const tmp = `${fp}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, fp);
}

function inferKindFromTitle(title) {
  const m = String(title || '').match(/\[Actuation:([a-zA-Z0-9_-]+)\]/);
  return m ? m[1] : null;
}

function normalizeParams(v) {
  return v && typeof v === 'object' ? v : {};
}

function applyBridge(p) {
  if (!p || typeof p !== 'object') return { changed: false, proposal: p };
  const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
  if (meta.actuation && typeof meta.actuation === 'object' && String(meta.actuation.kind || '').trim()) {
    return { changed: false, proposal: p };
  }

  let kind = null;
  let params = {};

  // Rule 1: explicit hint object
  if (meta.actuation_hint && typeof meta.actuation_hint === 'object') {
    kind = String(meta.actuation_hint.kind || '').trim() || null;
    params = normalizeParams(meta.actuation_hint.params);
  }

  // Rule 2: actuation_task + title marker
  if (!kind && String(p.type || '') === 'actuation_task') {
    kind = inferKindFromTitle(p.title);
  }

  if (!kind) return { changed: false, proposal: p };

  const next = {
    ...p,
    meta: {
      ...meta,
      actuation: {
        kind,
        params
      }
    }
  };
  return { changed: true, proposal: next, kind };
}

function run(dateStr, dryRun) {
  const fp = path.join(PROPOSALS_DIR, `${dateStr}.json`);
  if (!fs.existsSync(fp)) {
    process.stdout.write(JSON.stringify({ ok: true, result: 'no_proposals_file', date: dateStr, path: fp }) + '\n');
    return;
  }
  const raw = readJson(fp);
  const proposals = Array.isArray(raw) ? raw : (raw && Array.isArray(raw.proposals) ? raw.proposals : []);
  if (!Array.isArray(proposals)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid proposals format', path: fp }) + '\n');
    process.exit(1);
  }

  let changed = 0;
  const byKind = {};
  const out = proposals.map((p) => {
    const r = applyBridge(p);
    if (r.changed) {
      changed += 1;
      byKind[r.kind] = (byKind[r.kind] || 0) + 1;
    }
    return r.proposal;
  });

  if (!dryRun && changed > 0) {
    if (Array.isArray(raw)) writeJsonAtomic(fp, out);
    else writeJsonAtomic(fp, { ...raw, proposals: out });
  }

  process.stdout.write(JSON.stringify({
    ok: true,
    result: dryRun ? 'dry_run' : 'bridged',
    date: dateStr,
    changed,
    by_kind: byKind,
    path: fp
  }) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || '';
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  const dateStr = args._[1] && /^\d{4}-\d{2}-\d{2}$/.test(args._[1]) ? args._[1] : todayStr();
  run(dateStr, args['dry-run'] === true);
}

main();
