#!/usr/bin/env node
'use strict';
export {};

/**
 * Read-only vault watcher -> Obsidian ingest events (OBS-002).
 */

const fs = require('fs');
const path = require('path');
const { loadPolicy, ingestFileChange } = require('./obsidian_bridge');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const eq = tok.indexOf('=');
    if (eq >= 0) {
      out[tok.slice(2, eq)] = tok.slice(eq + 1);
      continue;
    }
    const key = tok.slice(2);
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
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function listFilesRecursively(root: string, allowedExt: string[], maxFiles = 100000) {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop() as string;
    let ents: fs.Dirent[] = [];
    try {
      ents = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of ents) {
      if (ent.isSymbolicLink()) continue;
      const abs = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const ext = path.extname(abs).toLowerCase();
      if (!allowedExt.includes(ext)) continue;
      out.push(abs);
      if (out.length >= maxFiles) return out;
    }
  }
  return out;
}

function baselineSnapshot(policy: AnyObj) {
  const seen: AnyObj = {};
  const exts = Array.isArray(policy.allowed_extensions) ? policy.allowed_extensions : ['.md', '.canvas'];
  for (const root of (Array.isArray(policy.vault_roots) ? policy.vault_roots : [])) {
    if (!fs.existsSync(root)) continue;
    const files = listFilesRecursively(root, exts);
    for (const fp of files) {
      try {
        const st = fs.statSync(fp);
        seen[fp] = { mtime_ms: st.mtimeMs, size: st.size };
      } catch {
        // ignore
      }
    }
  }
  return seen;
}

function detectChanges(prev: AnyObj, next: AnyObj) {
  const out: Array<{ file: string; action: string }> = [];
  for (const file of Object.keys(next)) {
    if (!prev[file]) {
      out.push({ file, action: 'create' });
      continue;
    }
    const a = prev[file];
    const b = next[file];
    if (Number(a.mtime_ms || 0) !== Number(b.mtime_ms || 0) || Number(a.size || 0) !== Number(b.size || 0)) {
      out.push({ file, action: 'edit' });
    }
  }
  for (const file of Object.keys(prev)) {
    if (!next[file]) out.push({ file, action: 'delete' });
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/obsidian/vault_watcher.js run [--policy=path] [--interval-ms=1500] [--once=1] [--clearance=1]');
}

function runWatcher(args: AnyObj) {
  const policy = loadPolicy(args.policy || process.env.OBSIDIAN_BRIDGE_POLICY);
  if (policy.enabled !== true) {
    return { ok: false, type: 'obsidian_vault_watcher', error: 'bridge_disabled' };
  }
  const intervalMs = Number.isFinite(Number(args['interval-ms'] || args.interval_ms))
    ? Math.max(200, Math.floor(Number(args['interval-ms'] || args.interval_ms)))
    : 1500;
  const clearance = Number.isFinite(Number(args.clearance)) ? Math.floor(Number(args.clearance)) : 1;
  const once = toBool(args.once, false);
  let last = baselineSnapshot(policy);
  let eventCount = 0;
  const tick = () => {
    const next = baselineSnapshot(policy);
    const changes = detectChanges(last, next);
    for (const ch of changes) {
      const row = ingestFileChange({
        file: ch.file,
        action: ch.action,
        source: 'obsidian_watcher',
        clearance
      }, policy);
      if (row && row.ok === true && row.skipped !== true) eventCount += 1;
    }
    last = next;
    return changes.length;
  };
  const changed = tick();
  if (once) {
    return {
      ok: true,
      type: 'obsidian_vault_watcher',
      ts: nowIso(),
      mode: 'once',
      changed_files: changed,
      ingested_events: eventCount,
      interval_ms: intervalMs
    };
  }
  const started = nowIso();
  let loops = 1;
  const timer = setInterval(() => {
    tick();
    loops += 1;
  }, intervalMs);
  const shutdown = () => {
    clearInterval(timer);
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'obsidian_vault_watcher',
      ts: nowIso(),
      mode: 'daemon',
      started_at: started,
      loops,
      ingested_events: eventCount,
      interval_ms: intervalMs
    })}\n`);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  return {
    ok: true,
    type: 'obsidian_vault_watcher',
    ts: nowIso(),
    mode: 'daemon_started',
    interval_ms: intervalMs
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd !== 'run') {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'obsidian_vault_watcher', error: `unknown_command:${cmd}` })}\n`);
    process.exit(1);
  }
  const out = runWatcher(args);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out && out.ok === false) process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  runWatcher
};
