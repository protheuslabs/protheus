#!/usr/bin/env node
'use strict';

/**
 * model_catalog_rollback.js — restore the latest routing config snapshot.
 *
 * Usage:
 *   node systems/autonomy/model_catalog_rollback.js latest --approval-note="..." [--break-glass=1]
 *   node systems/autonomy/model_catalog_rollback.js --help
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { stampGuardEnv } = require('../../lib/request_envelope.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROUTING_CONFIG = path.join(REPO_ROOT, 'config', 'agent_routing_rules.json');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_snapshots');
const AUDIT_PATH = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_audit.jsonl');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'systems', 'security', 'guard.js');

function nowIso() { return new Date().toISOString(); }
function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const i = a.indexOf('=');
    if (i === -1) out[a.slice(2)] = true;
    else out[a.slice(2, i)] = a.slice(i + 1);
  }
  return out;
}
function appendJsonl(fp, obj) {
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.appendFileSync(fp, JSON.stringify(obj) + '\n', 'utf8');
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/model_catalog_rollback.js latest --approval-note="..." [--break-glass=1]');
  console.log('  node systems/autonomy/model_catalog_rollback.js --help');
}

function latestSnapshot() {
  if (!fs.existsSync(SNAPSHOT_DIR)) return null;
  const files = fs.readdirSync(SNAPSHOT_DIR).filter(f => f.endsWith('.json')).sort();
  if (!files.length) return null;
  return path.join(SNAPSHOT_DIR, files[files.length - 1]);
}

function runGuard(approvalNote, breakGlass) {
  const rel = path.relative(REPO_ROOT, ROUTING_CONFIG).replace(/\\/g, '/');
  let env = {
    ...process.env,
    CLEARANCE: process.env.CLEARANCE || '2',
    APPROVAL_NOTE: approvalNote || '',
    BREAK_GLASS: breakGlass ? '1' : '0'
  };
  const source = String(env.REQUEST_SOURCE || 'local').trim() || 'local';
  const action = String(env.REQUEST_ACTION || 'apply').trim() || 'apply';
  env = stampGuardEnv(env, { source, action, files: [rel] });
  const r = spawnSync('node', [GUARD_SCRIPT, `--files=${rel}`], { cwd: REPO_ROOT, encoding: 'utf8', env });
  const line = String(r.stdout || '').split('\n').find(l => l.trim().startsWith('{')) || '{}';
  let payload = null;
  try { payload = JSON.parse(line); } catch {}
  return { ok: r.status === 0 && payload && payload.ok === true, payload, stderr: String(r.stderr || '').trim() };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || '';
  if (!cmd || args.help || cmd === 'help' || cmd === '--help') {
    usage();
    process.exit(0);
  }

  if (cmd !== 'latest') {
    process.stdout.write(JSON.stringify({ ok: false, error: `unknown command: ${cmd}` }) + '\n');
    process.exit(2);
  }

  const approvalNote = String(args['approval-note'] || '').trim();
  const breakGlass = String(args['break-glass'] || '0') === '1';
  if (!approvalNote) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing --approval-note' }) + '\n');
    process.exit(2);
  }

  const clearance = Number(process.env.CLEARANCE || 2);
  if (!Number.isFinite(clearance) || clearance < 3) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'rollback requires CLEARANCE>=3' }) + '\n');
    process.exit(1);
  }

  const snap = latestSnapshot();
  if (!snap || !fs.existsSync(snap)) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'no snapshot found' }) + '\n');
    process.exit(1);
  }

  const guard = runGuard(approvalNote, breakGlass);
  if (!guard.ok) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'guard_blocked', guard }) + '\n');
    process.exit(1);
  }

  fs.copyFileSync(snap, ROUTING_CONFIG);
  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'rollback_success',
    snapshot: snap,
    approval_note: approvalNote.slice(0, 240),
    break_glass: breakGlass
  });

  process.stdout.write(JSON.stringify({ ok: true, restored_from: snap }) + '\n');
}

main();
export {};
