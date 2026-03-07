#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-020
 * Verify backup channels, then sync scoped memory snapshot ignore rules.
 *
 * Usage:
 *   node systems/ops/memory_snapshot_ignore_gate.js verify-and-sync [--apply=1|0] [--strict=1|0]
 *   node systems/ops/memory_snapshot_ignore_gate.js status
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.MEMORY_SNAPSHOT_IGNORE_GATE_ROOT
  ? path.resolve(process.env.MEMORY_SNAPSHOT_IGNORE_GATE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.MEMORY_SNAPSHOT_IGNORE_GATE_POLICY_PATH
  ? path.resolve(process.env.MEMORY_SNAPSHOT_IGNORE_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'memory_snapshot_ignore_gate_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
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
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try { if (!fs.existsSync(filePath)) return fallback; const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return parsed == null ? fallback : parsed; } catch { return fallback; }
}
function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    required_channels: ['state_backup', 'offsite_state_backup'],
    backup_integrity_script: 'systems/ops/backup_integrity_check.js',
    gitignore_path: '.gitignore',
    snapshot_patterns: [
      'memory/_snapshots/',
      'memory/*.backup.*',
      'state/memory/snapshots/*.json',
      'state/memory/snapshots/*.jsonl'
    ],
    outputs: {
      latest_path: 'state/ops/memory_snapshot_ignore_gate/latest.json',
      history_path: 'state/ops/memory_snapshot_ignore_gate/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const requiredChannels = Array.isArray(raw.required_channels)
    ? raw.required_channels.map((x: unknown) => cleanText(x, 80)).filter(Boolean)
    : base.required_channels;
  const snapshotPatterns = Array.isArray(raw.snapshot_patterns)
    ? raw.snapshot_patterns.map((x: unknown) => cleanText(x, 260)).filter(Boolean)
    : base.snapshot_patterns;
  const scriptRaw = cleanText(raw.backup_integrity_script || base.backup_integrity_script, 520) || base.backup_integrity_script;

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    required_channels: Array.from(new Set(requiredChannels)),
    backup_integrity_script: path.isAbsolute(scriptRaw) ? scriptRaw : path.join(ROOT, scriptRaw),
    gitignore_path: resolvePath(raw.gitignore_path || base.gitignore_path, base.gitignore_path),
    snapshot_patterns: Array.from(new Set(snapshotPatterns)),
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function runBackupChannel(scriptPath: string, channel: string) {
  const proc = spawnSync(process.execPath, [scriptPath, 'run', `--channel=${channel}`, '--strict'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const stdout = String(proc.stdout || '').trim();
  let payload = null;
  try { payload = JSON.parse(stdout); } catch {}
  return {
    channel,
    ok: proc.status === 0 && !!payload && payload.ok === true,
    status: Number(proc.status || 0),
    payload,
    stderr: cleanText(proc.stderr, 600)
  };
}

function ensureRuleBlock(gitignorePath: string, patterns: string[], apply: boolean) {
  const start = '# BL-020 memory snapshot ignore rules (backup-verified)';
  const end = '# /BL-020';
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';

  const block = `${start}\n${patterns.map((x) => String(x)).join('\n')}\n${end}`;
  const rx = new RegExp(`${start.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${end.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'm');

  let next = existing;
  if (rx.test(existing)) {
    next = existing.replace(rx, block);
  } else {
    next = `${existing.replace(/\s*$/, '')}\n\n${block}\n`;
  }

  const changed = next !== existing;
  if (changed && apply) {
    ensureDir(path.dirname(gitignorePath));
    fs.writeFileSync(gitignorePath, next, 'utf8');
  }

  return { changed, applied: changed && apply };
}

function cmdVerifyAndSync(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const apply = toBool(args.apply, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (!policy.enabled) {
    return {
      ok: true,
      ts: nowIso(),
      type: 'memory_snapshot_ignore_gate',
      result: 'disabled_by_policy',
      strict,
      apply,
      policy_path: rel(policy.policy_path)
    };
  }

  const channels = cleanText(args.channels, 1000)
    ? cleanText(args.channels, 1000).split(',').map((x) => cleanText(x, 80)).filter(Boolean)
    : policy.required_channels;

  const checks = channels.map((channel: string) => runBackupChannel(policy.backup_integrity_script, channel));
  const failed = checks.filter((row: AnyObj) => row.ok !== true);

  let syncResult = { changed: false, applied: false };
  if (failed.length === 0) {
    syncResult = ensureRuleBlock(policy.gitignore_path, policy.snapshot_patterns, apply);
  }

  const out = {
    ok: failed.length === 0,
    ts: nowIso(),
    type: 'memory_snapshot_ignore_gate',
    strict,
    apply,
    channels,
    checks,
    failed_channels: failed.map((row: AnyObj) => row.channel),
    gitignore_path: rel(policy.gitignore_path),
    sync: syncResult,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    channel_count: channels.length,
    failed_channels: out.failed_channels,
    sync: out.sync,
    ok: out.ok
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'memory_snapshot_ignore_gate_status',
    policy_path: rel(policy.policy_path),
    latest_path: rel(policy.outputs.latest_path),
    latest: readJson(policy.outputs.latest_path, null)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/memory_snapshot_ignore_gate.js verify-and-sync [--apply=1|0] [--strict=1|0]');
  console.log('  node systems/ops/memory_snapshot_ignore_gate.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  const payload = cmd === 'verify-and-sync' ? cmdVerifyAndSync(args)
    : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'memory_snapshot_ignore_gate_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdVerifyAndSync, cmdStatus, ensureRuleBlock };
