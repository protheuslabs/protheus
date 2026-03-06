#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import path from 'path';
import { spawnSync } from 'child_process';

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const ORACLE_SCRIPT = path.join(ROOT, 'systems', 'ops', 'platform_oracle_hostprofile.js');
const CHANNEL_SCRIPT = path.join(ROOT, 'systems', 'ops', 'platform_adaptation_channel_runtime.js');
const MATRIX_SCRIPT = path.join(ROOT, 'systems', 'ops', 'platform_universal_abstraction_matrix.js');

const DEFAULT_POLICY_PATH = process.env.HOST_ADAPTATION_OPERATOR_SURFACE_POLICY_PATH
  ? path.resolve(process.env.HOST_ADAPTATION_OPERATOR_SURFACE_POLICY_PATH)
  : path.join(ROOT, 'config', 'host_adaptation_operator_surface_policy.json');

function nowIso(): string {
  return new Date().toISOString();
}

function rel(filePath: string): string {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function cleanText(v: unknown, maxLen = 240): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = String(tok).indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false): boolean {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}): AnyObj {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy(): AnyObj {
  return {
    schema_id: 'host_adaptation_operator_surface_policy',
    schema_version: '1.0',
    enabled: true,
    first_run_auto_adapt: true,
    state_path: 'state/ops/host_adaptation_operator_surface/latest.json',
    history_path: 'state/ops/host_adaptation_operator_surface/history.jsonl',
    oracle_state_path: 'state/ops/platform_oracle_hostprofile/latest.json',
    channel_state_path: 'state/ops/platform_adaptation_channel_runtime/latest.json',
    matrix_state_path: 'state/ops/platform_universal_abstraction_matrix/latest.json'
  };
}

function resolvePath(raw: unknown, fallbackRel: string): string {
  const txt = cleanText(raw, 320);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function loadPolicy(policyPath: string): AnyObj {
  const base = defaultPolicy();
  const raw = readJson(policyPath, base);
  return {
    schema_id: 'host_adaptation_operator_surface_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    enabled: raw.enabled !== false,
    first_run_auto_adapt: raw.first_run_auto_adapt !== false,
    state_path: resolvePath(raw.state_path || base.state_path, base.state_path),
    history_path: resolvePath(raw.history_path || base.history_path, base.history_path),
    oracle_state_path: resolvePath(raw.oracle_state_path || base.oracle_state_path, base.oracle_state_path),
    channel_state_path: resolvePath(raw.channel_state_path || base.channel_state_path, base.channel_state_path),
    matrix_state_path: resolvePath(raw.matrix_state_path || base.matrix_state_path, base.matrix_state_path)
  };
}

function runJson(scriptPath: string, args: string[]): AnyObj {
  const res = spawnSync('node', [scriptPath, ...args], { encoding: 'utf8', cwd: ROOT, timeout: 120000 });
  const stdout = String(res.stdout || '').trim();
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  let payload: AnyObj = {};
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      payload = JSON.parse(lines[i]);
      break;
    } catch {
      // continue
    }
  }
  return {
    ok: Number(res.status || 0) === 0,
    code: Number(res.status || 0),
    payload,
    stdout,
    stderr: String(res.stderr || '').trim()
  };
}

function runDetect(phase: string): AnyObj {
  return runJson(ORACLE_SCRIPT, ['run', `--phase=${phase}`]);
}

function runAdapt(dryRun: boolean): AnyObj {
  return runJson(CHANNEL_SCRIPT, ['activate', `--dry-run=${dryRun ? '1' : '0'}`]);
}

function runMatrix(): AnyObj {
  return runJson(MATRIX_SCRIPT, ['run']);
}

function status(policy: AnyObj): AnyObj {
  const oracle = readJson(policy.oracle_state_path, {});
  const channel = readJson(policy.channel_state_path, {});
  const matrix = readJson(policy.matrix_state_path, {});
  const activeChannelId = cleanText(channel.selected_channel && channel.selected_channel.id || '', 120) || null;
  return {
    ok: true,
    type: 'host_adaptation_operator_surface',
    ts: nowIso(),
    host_profile: oracle.host_profile || null,
    host_profile_confidence: oracle.active_confidence != null ? Number(oracle.active_confidence) : null,
    active_channel_id: activeChannelId,
    fallback_to_generic: channel.fallback_to_generic === true,
    matrix_revision: cleanText(matrix.revision || '', 80) || null,
    matrix_ok: matrix.ok === true,
    rollback_command: 'protheusctl host adapt --rollback=1',
    state_paths: {
      oracle_state_path: rel(policy.oracle_state_path),
      channel_state_path: rel(policy.channel_state_path),
      matrix_state_path: rel(policy.matrix_state_path)
    }
  };
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/host_adaptation_operator_surface.js detect [--phase=boot|promotion|periodic] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/host_adaptation_operator_surface.js adapt [--dry-run=1] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/host_adaptation_operator_surface.js status [--policy=<path>]');
  console.log('  node systems/ops/host_adaptation_operator_surface.js auto [--strict=1|0] [--policy=<path>]');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase();
  if (args.help || cmd === 'help') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy
    ? (path.isAbsolute(String(args.policy)) ? String(args.policy) : path.join(ROOT, String(args.policy)))
    : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);

  if (policy.enabled === false) {
    const payload = {
      ok: true,
      skipped: true,
      reason: 'disabled',
      type: 'host_adaptation_operator_surface',
      ts: nowIso(),
      policy_path: rel(policyPath)
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify(status(policy), null, 2)}\n`);
    return;
  }

  if (cmd === 'detect') {
    const phase = cleanText(args.phase || args._[1] || 'boot', 32).toLowerCase() || 'boot';
    const detect = runDetect(phase);
    const payload = {
      ok: detect.ok,
      type: 'host_adaptation_operator_surface',
      action: 'detect',
      ts: nowIso(),
      phase,
      oracle: detect
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (toBool(args.strict, false) && payload.ok !== true) process.exit(1);
    return;
  }

  if (cmd === 'adapt') {
    const dryRun = toBool(args['dry-run'], false);
    const detect = runDetect('promotion');
    const adapt = runAdapt(dryRun);
    const matrix = runMatrix();

    const payload = {
      ok: detect.ok && adapt.ok && matrix.ok,
      type: 'host_adaptation_operator_surface',
      action: 'adapt',
      ts: nowIso(),
      dry_run: dryRun,
      detect,
      adapt,
      matrix,
      rollback_command: 'protheusctl host adapt --rollback=1'
    };

    writeJsonAtomic(policy.state_path, payload);
    appendJsonl(policy.history_path, payload);

    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    if (toBool(args.strict, false) && payload.ok !== true) process.exit(1);
    return;
  }

  if (cmd === 'auto') {
    const firstRun = !fs.existsSync(policy.state_path);
    if (firstRun && policy.first_run_auto_adapt === true) {
      const detect = runDetect('boot');
      const adapt = runAdapt(false);
      const matrix = runMatrix();
      const payload = {
        ok: detect.ok && adapt.ok && matrix.ok,
        type: 'host_adaptation_operator_surface',
        action: 'auto',
        ts: nowIso(),
        first_run: true,
        detect,
        adapt,
        matrix
      };
      writeJsonAtomic(policy.state_path, payload);
      appendJsonl(policy.history_path, payload);
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      if (toBool(args.strict, false) && payload.ok !== true) process.exit(1);
      return;
    }
    const payload = {
      ok: true,
      type: 'host_adaptation_operator_surface',
      action: 'auto',
      ts: nowIso(),
      first_run: false,
      skipped: true,
      reason: 'already_initialized_or_auto_disabled'
    };
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) main();
