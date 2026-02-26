#!/usr/bin/env node
'use strict';
export {};

/**
 * personal_protheus_installer.js
 *
 * One-command bootstrap for a local "Personal Protheus" experience.
 * Installs config/state scaffolding without shipping model artifacts.
 *
 * Usage:
 *   node systems/ops/personal_protheus_installer.js install [--profile=personal_default] [--workspace=/abs/path] [--dry-run]
 *   node systems/ops/personal_protheus_installer.js status
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT_DIR = process.env.PERSONAL_PROTHEUS_STATE_DIR
  ? path.resolve(process.env.PERSONAL_PROTHEUS_STATE_DIR)
  : path.join(ROOT, 'state', 'ops', 'personal_protheus');
const MANIFEST_PATH = path.join(OUT_DIR, 'install_manifest.json');
const PROFILE_PATH = path.join(OUT_DIR, 'profile.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/personal_protheus_installer.js install [--profile=personal_default] [--workspace=/abs/path] [--dry-run]');
  console.log('  node systems/ops/personal_protheus_installer.js status');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const arg of argv) {
    if (!String(arg || '').startsWith('--')) {
      out._.push(String(arg || ''));
      continue;
    }
    const idx = arg.indexOf('=');
    if (idx === -1) out[String(arg || '').slice(2)] = true;
    else out[String(arg || '').slice(2, idx)] = String(arg || '').slice(idx + 1);
  }
  return out;
}

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v, maxLen = 180) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 80) {
  return String(v == null ? '' : v)
    .trim()
    .toLowerCase()
    .slice(0, maxLen)
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function boolFlag(v, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
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

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function relPath(filePath) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function checks(workspace) {
  const required = [
    'systems/spine/spine.js',
    'systems/autonomy/autonomy_controller.js',
    'systems/security/guard.js',
    'config/strategies/default.json',
    'package.json'
  ];
  const rows = required.map((relativePath) => ({
    path: relativePath,
    exists: fs.existsSync(path.join(workspace, relativePath))
  }));
  const passed = rows.every((row) => row.exists === true);
  return { passed, rows };
}

function profileTemplate(profileId, workspace) {
  return {
    schema_id: 'personal_protheus_profile',
    schema_version: '1.0.0',
    profile_id: profileId,
    workspace,
    user: process.env.USER || null,
    host: os.hostname(),
    created_at: nowIso(),
    startup: {
      command: 'node systems/spine/spine.js daily',
      notes: 'Use score_only until readiness + guard checks are green.'
    },
    defaults: {
      strategy_mode: 'score_only',
      workflow_layer_enabled: true,
      observer_mirror_enabled: true,
      collective_shadow_enabled: true
    }
  };
}

function installCmd(args) {
  const workspace = path.resolve(String(args.workspace || ROOT));
  const profileId = normalizeToken(args.profile || 'personal_default', 80) || 'personal_default';
  const dryRun = args['dry-run'] === true || boolFlag(args.dry_run, false);
  const preflight = checks(workspace);
  const manifest = {
    ok: preflight.passed,
    type: 'personal_protheus_install',
    ts: nowIso(),
    profile_id: profileId,
    workspace,
    dry_run: dryRun,
    preflight
  };

  if (!preflight.passed) {
    process.stdout.write(`${JSON.stringify({
      ...manifest,
      error: 'preflight_failed'
    })}\n`);
    process.exit(1);
  }

  if (!dryRun) {
    ensureDir(OUT_DIR);
    const profile = profileTemplate(profileId, workspace);
    writeJsonAtomic(PROFILE_PATH, profile);
    writeJsonAtomic(MANIFEST_PATH, {
      ...manifest,
      profile_path: relPath(PROFILE_PATH)
    });
  }

  process.stdout.write(`${JSON.stringify({
    ...manifest,
    profile_path: dryRun ? null : relPath(PROFILE_PATH),
    manifest_path: dryRun ? null : relPath(MANIFEST_PATH)
  })}\n`);
}

function statusCmd() {
  const profile = readJson(PROFILE_PATH, null);
  const manifest = readJson(MANIFEST_PATH, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'personal_protheus_status',
    installed: !!(profile && manifest),
    profile_id: profile ? profile.profile_id || null : null,
    workspace: profile ? profile.workspace || null : null,
    created_at: profile ? profile.created_at || null : null,
    manifest_ts: manifest ? manifest.ts || null : null
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'install') return installCmd(args);
  if (cmd === 'status') return statusCmd();
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'personal_protheus_installer',
      error: cleanText(err && err.message ? err.message : err || 'personal_protheus_installer_failed', 240)
    })}\n`);
    process.exit(1);
  }
}
