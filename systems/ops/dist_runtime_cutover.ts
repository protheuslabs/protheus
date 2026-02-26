#!/usr/bin/env node
'use strict';

/**
 * dist_runtime_cutover.js
 *
 * V2-003 helper for source<->dist runtime mode.
 *
 * Usage:
 *   node systems/ops/dist_runtime_cutover.js status
 *   node systems/ops/dist_runtime_cutover.js set-mode --mode=dist|source
 *   node systems/ops/dist_runtime_cutover.js verify [--build=1|0] [--strict=1|0]
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MODE_STATE_PATH = process.env.PROTHEUS_RUNTIME_MODE_STATE_PATH
  ? path.resolve(process.env.PROTHEUS_RUNTIME_MODE_STATE_PATH)
  : path.join(ROOT, 'state', 'ops', 'runtime_mode.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) out[arg.slice(2)] = true;
    else out[arg.slice(2, eq)] = arg.slice(eq + 1);
  }
  return out;
}

function normalizeToken(v, maxLen = 32) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v, fallback = false) {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function modeFromState() {
  const payload = readJson(MODE_STATE_PATH, null);
  const mode = normalizeToken(payload && payload.mode || 'source');
  return mode === 'dist' ? 'dist' : 'source';
}

function effectiveMode() {
  const envMode = normalizeToken(process.env.PROTHEUS_RUNTIME_MODE || '');
  if (envMode === 'dist' || envMode === 'source') return envMode;
  return modeFromState();
}

function runCmd(name, command, args, env = {}) {
  const r = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
  return {
    name,
    ok: r.status === 0,
    status: Number(r.status || 0),
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim(),
    command: [command, ...args].join(' ')
  };
}

function walkFiles(dirPath, out = []) {
  if (!fs.existsSync(dirPath)) return out;
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return out;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const abs = path.join(dirPath, entry.name);
    if (entry.isDirectory()) walkFiles(abs, out);
    else if (entry.isFile()) out.push(abs);
  }
  return out;
}

function isTsBootstrapWrapper(jsAbsPath) {
  try {
    const text = fs.readFileSync(jsAbsPath, 'utf8');
    return /ts_bootstrap/.test(text) && /\.bootstrap\(__filename,\s*module\)/.test(text);
  } catch {
    return false;
  }
}

function legacyRuntimeJsPairs() {
  const roots = ['systems', 'lib'];
  const out = [];
  for (const relRoot of roots) {
    const absRoot = path.join(ROOT, relRoot);
    for (const absPath of walkFiles(absRoot, [])) {
      if (!absPath.endsWith('.js')) continue;
      const tsPath = absPath.slice(0, -3) + '.ts';
      if (!fs.existsSync(tsPath)) continue;
      if (isTsBootstrapWrapper(absPath)) continue;
      out.push(path.relative(ROOT, absPath).replace(/\\/g, '/'));
    }
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}

function cmdLegacyPairs(args) {
  const strict = toBool(args.strict, false);
  const pairs = legacyRuntimeJsPairs();
  const out = {
    ok: pairs.length === 0,
    type: 'dist_runtime_legacy_pairs',
    ts: nowIso(),
    legacy_pair_count: pairs.length,
    legacy_pairs: pairs
  };
  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (strict && !out.ok) process.exit(1);
}

function cmdStatus() {
  const state = readJson(MODE_STATE_PATH, null);
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'dist_runtime_status',
    ts: nowIso(),
    mode_state_path: path.relative(ROOT, MODE_STATE_PATH).replace(/\\/g, '/'),
    state_mode: modeFromState(),
    env_mode: normalizeToken(process.env.PROTHEUS_RUNTIME_MODE || '') || null,
    effective_mode: effectiveMode(),
    dist_exists: fs.existsSync(path.join(ROOT, 'dist')),
    state: state || null
  }) + '\n');
}

function cmdSetMode(args) {
  const mode = normalizeToken(args.mode || args['runtime-mode'] || '', 16);
  if (mode !== 'dist' && mode !== 'source') {
    process.stdout.write(JSON.stringify({ ok: false, error: 'mode_required_dist_or_source' }) + '\n');
    process.exit(2);
  }
  const payload = {
    schema_id: 'runtime_mode',
    schema_version: '1.0',
    ts: nowIso(),
    mode,
    source: 'dist_runtime_cutover'
  };
  writeJsonAtomic(MODE_STATE_PATH, payload);
  process.stdout.write(JSON.stringify({
    ok: true,
    type: 'dist_runtime_set_mode',
    ts: nowIso(),
    mode,
    mode_state_path: path.relative(ROOT, MODE_STATE_PATH).replace(/\\/g, '/')
  }) + '\n');
}

function cmdVerify(args) {
  const strict = toBool(args.strict, true);
  const withBuild = toBool(args.build, true);
  const deepDist = toBool(
    args['deep-dist'] != null ? args['deep-dist'] : process.env.PROTHEUS_RUNTIME_VERIFY_DEEP_DIST,
    false
  );
  const checks = [];

  if (withBuild) {
    checks.push(runCmd('build_systems_verify', 'npm', ['run', 'build:systems:verify']));
  }
  checks.push(runCmd(
    deepDist ? 'contract_check_dist' : 'contract_check',
    'node',
    ['systems/spine/contract_check.js'],
    deepDist
      ? {
          PROTHEUS_RUNTIME_MODE: 'dist',
          PROTHEUS_RUNTIME_DIST_REQUIRED: '1'
        }
      : {}
  ));
  checks.push(runCmd(
    deepDist ? 'schema_contract_check_dist' : 'schema_contract_check',
    'node',
    ['systems/security/schema_contract_check.js', 'run'],
    deepDist
      ? {
          PROTHEUS_RUNTIME_MODE: 'dist',
          PROTHEUS_RUNTIME_DIST_REQUIRED: '1'
        }
      : {}
  ));
  const legacyPairs = legacyRuntimeJsPairs();
  checks.push({
    name: 'legacy_runtime_js_pairs',
    ok: legacyPairs.length === 0,
    status: legacyPairs.length === 0 ? 0 : 1,
    stdout: legacyPairs.join('\n'),
    stderr: '',
    command: 'internal:legacy_runtime_js_pairs'
  });

  const failed = checks.filter((c) => !c.ok);
  const out = {
    ok: failed.length === 0,
    type: 'dist_runtime_verify',
    ts: nowIso(),
    strict,
    deep_dist: deepDist,
    build_step: withBuild,
    legacy_pair_count: legacyPairs.length,
    legacy_pairs: legacyPairs,
    checks: checks.map((c) => ({ name: c.name, ok: c.ok, status: c.status, command: c.command })),
    failed: failed.map((c) => ({
      name: c.name,
      status: c.status,
      stdout: c.stdout.split('\n').slice(0, 30).join('\n'),
      stderr: c.stderr.split('\n').slice(0, 30).join('\n')
    }))
  };

  process.stdout.write(JSON.stringify(out, null, 2) + '\n');
  if (strict && !out.ok) process.exit(1);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/dist_runtime_cutover.js status');
  console.log('  node systems/ops/dist_runtime_cutover.js set-mode --mode=dist|source');
  console.log('  node systems/ops/dist_runtime_cutover.js verify [--build=1|0] [--strict=1|0] [--deep-dist=1|0]');
  console.log('  node systems/ops/dist_runtime_cutover.js legacy-pairs [--strict=1|0]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0], 24);
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') return cmdStatus();
  if (cmd === 'set-mode') return cmdSetMode(args);
  if (cmd === 'verify') return cmdVerify(args);
  if (cmd === 'legacy-pairs') return cmdLegacyPairs(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  modeFromState,
  effectiveMode
};
export {};
