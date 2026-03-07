#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const PACKAGE_JSON = path.join(ROOT, 'package.json');
const CHANNEL_PATH = path.join(ROOT, 'config', 'protheus_release_channel.json');
const STATE_DIR = path.join(ROOT, 'state', 'ops', 'protheus_update_checker');
const STATE_PATH = path.join(STATE_DIR, 'state.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
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

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: any) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function parseSemver(value: string) {
  const m = String(value || '').trim().match(/^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function cmpSemver(a: string, b: string) {
  const av = parseSemver(a);
  const bv = parseSemver(b);
  if (!av || !bv) return 0;
  for (let i = 0; i < 3; i += 1) {
    if (av[i] > bv[i]) return 1;
    if (av[i] < bv[i]) return -1;
  }
  return 0;
}

function loadCurrentVersion() {
  const pkg = readJson(PACKAGE_JSON, {});
  return cleanText(pkg && pkg.version ? pkg.version : '0.0.0', 40) || '0.0.0';
}

function loadReleaseChannel() {
  const fallback = {
    channel: 'stable',
    latest_version: loadCurrentVersion(),
    released_at: nowIso().slice(0, 10),
    changelog_line: 'Latest stable release available.'
  };
  const raw = readJson(CHANNEL_PATH, fallback);
  return {
    channel: cleanText(raw.channel || fallback.channel, 40) || 'stable',
    latest_version: cleanText(raw.latest_version || fallback.latest_version, 40) || fallback.latest_version,
    released_at: cleanText(raw.released_at || fallback.released_at, 40) || fallback.released_at,
    changelog_line: cleanText(raw.changelog_line || fallback.changelog_line, 240) || fallback.changelog_line
  };
}

function computeStatus() {
  const current = loadCurrentVersion();
  const channel = loadReleaseChannel();
  const compare = cmpSemver(channel.latest_version, current);
  return {
    ok: true,
    type: 'protheus_version',
    ts: nowIso(),
    current_version: current,
    channel: channel.channel,
    latest_version: channel.latest_version,
    update_available: compare > 0,
    changelog_line: channel.changelog_line,
    released_at: channel.released_at
  };
}

function printStatus(payload: any, asJson: boolean) {
  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`protheus ${payload.current_version}\n`);
  if (payload.update_available) {
    process.stdout.write(`Update available: ${payload.latest_version} — ${payload.changelog_line}\n`);
    process.stdout.write('Run `protheus update` for details.\n');
  }
}

function cmdVersion(args: any) {
  const payload = computeStatus();
  const asJson = toBool(args.json ?? process.env.PROTHEUS_GLOBAL_JSON, false);
  printStatus(payload, asJson);
  return payload;
}

function cmdUpdate(args: any) {
  const payload = {
    ...computeStatus(),
    type: 'protheus_update'
  };
  const asJson = toBool(args.json ?? process.env.PROTHEUS_GLOBAL_JSON, false);
  const apply = toBool(args.apply, false);

  if (!asJson) {
    if (payload.update_available) {
      process.stdout.write(`Update available: ${payload.current_version} -> ${payload.latest_version}\n`);
      process.stdout.write(`${payload.changelog_line}\n`);
      if (apply) {
        process.stdout.write('Automatic updater is not enabled in this workspace. Pull latest changes and reinstall dependencies.\n');
      } else {
        process.stdout.write('Run `protheus update --apply=1` to acknowledge update instructions.\n');
      }
    } else {
      process.stdout.write('Already up to date.\n');
    }
  } else {
    payload['apply'] = apply;
    payload['apply_supported'] = false;
  }

  const state = readJson(STATE_PATH, {});
  writeJsonAtomic(STATE_PATH, {
    ...state,
    last_update_command_at: nowIso(),
    last_seen_version: payload.current_version,
    last_seen_latest: payload.latest_version,
    last_update_available: payload.update_available === true
  });

  if (asJson) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  }
  return payload;
}

function cmdQuietCheck(args: any) {
  const quiet = toBool(args.quiet ?? process.env.PROTHEUS_GLOBAL_QUIET, false);
  const state = readJson(STATE_PATH, {});
  const last = Date.parse(String(state.last_checked_at || ''));
  const now = Date.now();
  const maxAgeMs = 1000 * 60 * 60 * 24;
  const shouldCheck = !Number.isFinite(last) || (now - last) >= maxAgeMs || toBool(args.force, false);

  const payload = {
    ...computeStatus(),
    type: 'protheus_update_quiet_check',
    checked: shouldCheck,
    notified: false
  };

  if (!shouldCheck) {
    if (toBool(args.json, false)) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return payload;
  }

  writeJsonAtomic(STATE_PATH, {
    ...state,
    last_checked_at: nowIso(),
    last_seen_version: payload.current_version,
    last_seen_latest: payload.latest_version,
    last_update_available: payload.update_available === true
  });

  if (!quiet && payload.update_available) {
    process.stderr.write(`Update available (${payload.current_version} -> ${payload.latest_version}): ${payload.changelog_line}\n`);
    payload.notified = true;
  }

  if (toBool(args.json, false)) process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  return payload;
}

function usage() {
  console.log('Usage:');
  console.log('  protheus version');
  console.log('  protheus update [--apply=1]');
  console.log('  node systems/ops/protheus_version_cli.js check-quiet [--force=1] [--json=1]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'version', 40) || 'version';
  if (args.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  if (cmd === 'version' || cmd === 'status') {
    cmdVersion(args);
    return;
  }
  if (cmd === 'update') {
    cmdUpdate(args);
    return;
  }
  if (cmd === 'check-quiet') {
    cmdQuietCheck(args);
    return;
  }

  process.stderr.write(`${JSON.stringify({ ok: false, type: 'protheus_version', error: `unknown_command:${cmd}` }, null, 2)}\n`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  computeStatus,
  cmdVersion,
  cmdUpdate,
  cmdQuietCheck
};
