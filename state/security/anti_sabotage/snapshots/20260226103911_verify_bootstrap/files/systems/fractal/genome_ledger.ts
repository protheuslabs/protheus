#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/fractal/genome_ledger.js
 *
 * V2-026 Genome topology ledger + mutation journal.
 * Maintains schema-versioned snapshots and append-only hash-chained journal rows.
 *
 * Usage:
 *   node systems/fractal/genome_ledger.js snapshot [YYYY-MM-DD]
 *   node systems/fractal/genome_ledger.js status
 *   node systems/fractal/genome_ledger.js verify
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const GENOME_DIR = process.env.FRACTAL_GENOME_DIR
  ? path.resolve(process.env.FRACTAL_GENOME_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'genome');
const SNAPSHOT_DIR = path.join(GENOME_DIR, 'snapshots');
const LEDGER_PATH = path.join(GENOME_DIR, 'mutation_journal.jsonl');
const MORPH_PLAN_DIR = process.env.FRACTAL_MORPH_PLAN_DIR
  ? path.resolve(process.env.FRACTAL_MORPH_PLAN_DIR)
  : path.join(ROOT, 'state', 'autonomy', 'fractal', 'morph_plans');
const SYSTEMS_DIR = path.join(ROOT, 'systems');

const SCHEMA_ID = 'autonomy_genome_topology';
const SCHEMA_VERSION = '1.0.0';

function usage() {
  console.log('Usage:');
  console.log('  node systems/fractal/genome_ledger.js snapshot [YYYY-MM-DD]');
  console.log('  node systems/fractal/genome_ledger.js status');
  console.log('  node systems/fractal/genome_ledger.js verify');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const tok of argv) out._.push(String(tok || ''));
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function dateArgOrToday(v) {
  const s = String(v || '').trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  return nowIso().slice(0, 10);
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    const out = [];
    const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        if (row && typeof row === 'object') out.push(row);
      } catch {
        // ignore malformed lines
      }
    }
    return out;
  } catch {
    return [];
  }
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function stableStringify(value) {
  if (value == null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

function hashOf(value) {
  return crypto.createHash('sha256').update(stableStringify(value)).digest('hex');
}

function listTopLevelModules() {
  try {
    const entries = fs.readdirSync(SYSTEMS_DIR, { withFileTypes: true });
    return entries
      .filter((ent) => ent && ent.isDirectory())
      .map((ent) => String(ent.name || '').trim())
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function todayMorphPlan(dateStr) {
  const fp = path.join(MORPH_PLAN_DIR, `${dateStr}.json`);
  const plan = readJson(fp, null);
  if (!plan || typeof plan !== 'object') return null;
  const actions = Array.isArray(plan.actions) ? plan.actions : [];
  return {
    plan_id: String(plan.plan_id || '').trim() || null,
    objective_id: String(plan.objective_id || '').trim() || null,
    actions: actions.map((row) => ({
      id: String(row && row.id || '').trim() || null,
      kind: String(row && row.kind || '').trim() || 'unknown',
      target: String(row && row.target || '').trim() || null,
      risk: String(row && row.risk || '').trim() || 'unknown'
    })),
    action_count: actions.length
  };
}

function topologySnapshot(dateStr) {
  const modules = listTopLevelModules();
  const plan = todayMorphPlan(dateStr);
  const moduleWeights = {};
  for (const m of modules) {
    moduleWeights[m] = 1;
  }
  if (plan && Array.isArray(plan.actions)) {
    for (const action of plan.actions) {
      const target = String(action && action.target || '').trim().toLowerCase();
      const kind = String(action && action.kind || '').trim().toLowerCase();
      if (!target.startsWith('module:')) continue;
      const mod = target.slice('module:'.length);
      if (!mod) continue;
      const base = Number(moduleWeights[mod] || 1);
      if (kind === 'spawn') moduleWeights[mod] = base + 0.1;
      else if (kind === 'prune') moduleWeights[mod] = Math.max(0.5, base - 0.1);
      else if (kind === 'rewire') moduleWeights[mod] = base + 0.05;
    }
  }

  return {
    schema_id: SCHEMA_ID,
    schema_version: SCHEMA_VERSION,
    ts: nowIso(),
    date: dateStr,
    modules_total: modules.length,
    modules,
    module_weights: moduleWeights,
    morph_plan: plan
  };
}

function snapshotPath(dateStr) {
  return path.join(SNAPSHOT_DIR, `${dateStr}.json`);
}

function latestJournalRow() {
  const rows = readJsonl(LEDGER_PATH);
  if (!rows.length) return null;
  return rows[rows.length - 1];
}

function journalRowFromSnapshot(snapshot) {
  const prev = latestJournalRow();
  const prevHash = prev && typeof prev.hash === 'string' ? prev.hash : 'GENESIS';
  const snapshotHash = hashOf(snapshot);
  const payload = {
    schema_id: 'autonomy_genome_mutation_journal',
    schema_version: '1.0.0',
    ts: nowIso(),
    date: String(snapshot && snapshot.date || '').slice(0, 10),
    snapshot_hash: snapshotHash,
    prev_hash: prevHash,
    plan_id: snapshot && snapshot.morph_plan ? snapshot.morph_plan.plan_id || null : null,
    objective_id: snapshot && snapshot.morph_plan ? snapshot.morph_plan.objective_id || null : null,
    action_count: snapshot && snapshot.morph_plan ? Number(snapshot.morph_plan.action_count || 0) : 0
  };
  const rowHash = hashOf(payload);
  return { ...payload, hash: rowHash };
}

function cmdSnapshot(dateStr) {
  const snapshot = topologySnapshot(dateStr);
  const fp = snapshotPath(dateStr);
  writeJson(fp, snapshot);
  const row = journalRowFromSnapshot(snapshot);
  appendJsonl(LEDGER_PATH, row);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'fractal_genome_snapshot',
    date: dateStr,
    modules_total: snapshot.modules_total,
    plan_id: snapshot && snapshot.morph_plan ? snapshot.morph_plan.plan_id || null : null,
    action_count: row.action_count,
    snapshot_path: path.relative(ROOT, fp).replace(/\\/g, '/'),
    ledger_path: path.relative(ROOT, LEDGER_PATH).replace(/\\/g, '/'),
    hash: row.hash
  })}\n`);
}

function cmdStatus() {
  const row = latestJournalRow();
  if (!row) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'fractal_genome_status',
      error: 'journal_empty'
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'fractal_genome_status',
    date: row.date || null,
    plan_id: row.plan_id || null,
    action_count: Number(row.action_count || 0),
    hash: row.hash || null,
    prev_hash: row.prev_hash || null,
    ledger_path: path.relative(ROOT, LEDGER_PATH).replace(/\\/g, '/')
  })}\n`);
}

function verifyJournal() {
  const rows = readJsonl(LEDGER_PATH);
  if (!rows.length) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'fractal_genome_verify',
      rows: 0,
      valid: true
    })}\n`);
    return;
  }
  let prevHash = 'GENESIS';
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i] || {};
    const expected = hashOf({
      schema_id: row.schema_id,
      schema_version: row.schema_version,
      ts: row.ts,
      date: row.date,
      snapshot_hash: row.snapshot_hash,
      prev_hash: row.prev_hash,
      plan_id: row.plan_id,
      objective_id: row.objective_id,
      action_count: row.action_count
    });
    if (String(row.prev_hash || '') !== String(prevHash)) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        type: 'fractal_genome_verify',
        valid: false,
        error: 'prev_hash_mismatch',
        index: i
      })}\n`);
      process.exitCode = 1;
      return;
    }
    if (String(row.hash || '') !== expected) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        type: 'fractal_genome_verify',
        valid: false,
        error: 'hash_mismatch',
        index: i
      })}\n`);
      process.exitCode = 1;
      return;
    }
    prevHash = expected;
  }
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'fractal_genome_verify',
    rows: rows.length,
    valid: true
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'snapshot') {
    cmdSnapshot(dateArgOrToday(args._[1]));
    return;
  }
  if (cmd === 'status') {
    cmdStatus();
    return;
  }
  if (cmd === 'verify') {
    verifyJournal();
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  main();
}
