#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  ensureDir,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const CLIENT_LOCAL_ROOT = path.join(ROOT, 'client', 'local');
const CORE_LOCAL_ROOT = path.join(ROOT, 'core', 'local');
const KEEP_NAMES = new Set(['.gitignore', '.gitkeep', 'README.md']);

const CLIENT_DIRS = [
  'adaptive',
  'memory',
  'logs',
  'secrets',
  'reports',
  'research',
  'patches',
  'config',
  'state',
  'private-lenses',
  'habits'
];

const CORE_DIRS = [
  'state',
  'logs',
  'memory',
  'config',
  'cache',
  'device'
];

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/local_runtime_partitioner.js init');
  console.log('  node systems/ops/local_runtime_partitioner.js status');
  console.log('  node systems/ops/local_runtime_partitioner.js reset --confirm=RESET_LOCAL');
}

function listBlueprint(rootDir: string, dirs: string[]) {
  return dirs.map((name) => path.join(rootDir, name));
}

function ensureLayout() {
  ensureDir(CLIENT_LOCAL_ROOT);
  ensureDir(CORE_LOCAL_ROOT);
  for (const dir of listBlueprint(CLIENT_LOCAL_ROOT, CLIENT_DIRS)) {
    ensureDir(dir);
    const keepPath = path.join(dir, '.gitkeep');
    if (!fs.existsSync(keepPath)) fs.writeFileSync(keepPath, '', 'utf8');
  }
  for (const dir of listBlueprint(CORE_LOCAL_ROOT, CORE_DIRS)) {
    ensureDir(dir);
    const keepPath = path.join(dir, '.gitkeep');
    if (!fs.existsSync(keepPath)) fs.writeFileSync(keepPath, '', 'utf8');
  }
}

function walkSummary(absRoot: string) {
  let files = 0;
  let dirs = 0;
  let bytes = 0;
  if (!fs.existsSync(absRoot)) return { exists: false, files, dirs, bytes };
  const stack = [absRoot];
  while (stack.length) {
    const cursor = stack.pop() as string;
    let entries: any[] = [];
    try { entries = fs.readdirSync(cursor, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const abs = path.join(cursor, entry.name);
      if (entry.isDirectory()) {
        dirs += 1;
        stack.push(abs);
      } else if (entry.isFile()) {
        files += 1;
        try { bytes += Number(fs.statSync(abs).size || 0); } catch {}
      }
    }
  }
  return { exists: true, files, dirs, bytes };
}

function cleanSubtree(absDir: string) {
  if (!fs.existsSync(absDir)) return;
  let entries: any[] = [];
  try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const abs = path.join(absDir, entry.name);
    if (entry.isDirectory()) {
      cleanSubtree(abs);
      try {
        const remainder = fs.readdirSync(abs);
        if (remainder.length === 0) fs.rmdirSync(abs);
      } catch {}
      continue;
    }
    if (entry.isFile() && !KEEP_NAMES.has(entry.name)) {
      try { fs.unlinkSync(abs); } catch {}
    }
  }
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function cmdInit() {
  ensureLayout();
  return {
    ok: true,
    type: 'local_runtime_partitioner',
    action: 'init',
    ts: nowIso(),
    roots: {
      client_local_root: rel(CLIENT_LOCAL_ROOT),
      core_local_root: rel(CORE_LOCAL_ROOT)
    }
  };
}

function cmdStatus() {
  ensureLayout();
  return {
    ok: true,
    type: 'local_runtime_partitioner',
    action: 'status',
    ts: nowIso(),
    roots: {
      client_local_root: rel(CLIENT_LOCAL_ROOT),
      core_local_root: rel(CORE_LOCAL_ROOT)
    },
    summary: {
      client: walkSummary(CLIENT_LOCAL_ROOT),
      core: walkSummary(CORE_LOCAL_ROOT)
    }
  };
}

function cmdReset(args: AnyObj) {
  const confirm = cleanText(args.confirm || '', 40);
  if (confirm !== 'RESET_LOCAL') {
    return {
      ok: false,
      type: 'local_runtime_partitioner',
      action: 'reset',
      ts: nowIso(),
      error: 'confirmation_required',
      expected_confirm: 'RESET_LOCAL'
    };
  }
  ensureLayout();
  cleanSubtree(CLIENT_LOCAL_ROOT);
  cleanSubtree(CORE_LOCAL_ROOT);
  ensureLayout();
  return {
    ok: true,
    type: 'local_runtime_partitioner',
    action: 'reset',
    ts: nowIso(),
    roots: {
      client_local_root: rel(CLIENT_LOCAL_ROOT),
      core_local_root: rel(CORE_LOCAL_ROOT)
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 60) || 'status';
  if (cmd === 'help' || args.help) {
    usage();
    return;
  }
  if (cmd === 'init') emit(cmdInit(), 0);
  if (cmd === 'status') emit(cmdStatus(), 0);
  if (cmd === 'reset') {
    const out = cmdReset(args);
    emit(out, out.ok ? 0 : 1);
  }
  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
