#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.FULL_VIRTUAL_DESKTOP_CLAW_POLICY_PATH
  ? path.resolve(process.env.FULL_VIRTUAL_DESKTOP_CLAW_POLICY_PATH)
  : path.join(ROOT, 'config', 'full_virtual_desktop_claw_policy.json');
const SESSION_SCRIPT = path.join(ROOT, 'systems', 'primitives', 'interactive_desktop_session_primitive.js');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 260) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 160) { return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, ''); }
function toBool(v: unknown, fallback = false) { if (v == null) return fallback; const raw = String(v).trim().toLowerCase(); if (['1','true','yes','on'].includes(raw)) return true; if (['0','false','no','off'].includes(raw)) return false; return fallback; }
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any) { try { if (!fs.existsSync(filePath)) return fallback; const p = JSON.parse(fs.readFileSync(filePath, 'utf8')); return p == null ? fallback : p; } catch { return fallback; } }
function writeJsonAtomic(filePath: string, value: AnyObj) { ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath); }
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function relPath(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const idx = tok.indexOf('=');
    if (idx >= 0) { out[tok.slice(2, idx)] = tok.slice(idx + 1); continue; }
    const key = tok.slice(2); const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw || '', 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    human_veto_window_sec: 120,
    max_recovery_attempts: 1,
    receipts_path: 'state/actuation/full_virtual_desktop_claw/receipts.jsonl',
    latest_path: 'state/actuation/full_virtual_desktop_claw/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    shadow_only: toBool(src.shadow_only, base.shadow_only),
    human_veto_window_sec: Number(src.human_veto_window_sec != null ? src.human_veto_window_sec : base.human_veto_window_sec) || base.human_veto_window_sec,
    max_recovery_attempts: Number(src.max_recovery_attempts != null ? src.max_recovery_attempts : base.max_recovery_attempts) || base.max_recovery_attempts,
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function runLane(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'full_virtual_desktop_claw_run', error: 'policy_disabled' };

  const sessionId = normalizeToken(args['session-id'] || args.session_id || `desktop_${Date.now()}`, 140);
  const objectiveId = normalizeToken(args['objective-id'] || args.objective_id || '', 180) || null;
  const actionsJson = cleanText(args['actions-json'] || args.actions_json || '', 2000000) || '[{"opcode":"open","target":"about:blank"},{"opcode":"wait","ms":100},{"opcode":"capture","name":"desktop_capture"}]';
  const apply = toBool(args.apply, false) && policy.shadow_only !== true;
  const approved = toBool(args.approved, false);

  const child = spawnSync(
    process.execPath,
    [
      SESSION_SCRIPT,
      'run',
      `--session-id=${sessionId}`,
      objectiveId ? `--objective-id=${objectiveId}` : '--objective-id=virtual_desktop',
      '--risk-class=desktop_ui',
      `--actions-json=${actionsJson}`,
      apply ? '--apply=1' : '--apply=0',
      approved ? '--approved=1' : '--approved=0'
    ],
    {
      cwd: ROOT,
      encoding: 'utf8'
    }
  );

  let session = null;
  const stdout = String(child.stdout || '').trim();
  if (stdout) {
    try { session = JSON.parse(stdout); } catch {
      const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try { session = JSON.parse(lines[i]); break; } catch {}
      }
    }
  }

  const out = {
    ok: child.status === 0 && session && session.ok === true,
    type: 'full_virtual_desktop_claw_run',
    ts: nowIso(),
    session_id: sessionId,
    objective_id: objectiveId,
    apply,
    shadow_only: policy.shadow_only === true,
    approved,
    session: session || null,
    child_status: Number(child.status || 0),
    child_stderr: cleanText(child.stderr || '', 600),
    receipts_path: relPath(policy.receipts_path)
  };
  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const count = fs.existsSync(policy.receipts_path)
    ? String(fs.readFileSync(policy.receipts_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  return {
    ok: true,
    type: 'full_virtual_desktop_claw_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only === true,
      human_veto_window_sec: policy.human_veto_window_sec
    },
    receipts_count: count,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        ok: latest.ok === true,
        session_id: latest.session_id || null,
        objective_id: latest.objective_id || null
      }
      : null,
    paths: {
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/full_virtual_desktop_claw_lane.js run [--session-id=<id>] [--objective-id=<id>] [--actions-json=<json>] [--apply=0|1] [--approved=0|1]');
  console.log('  node systems/actuation/full_virtual_desktop_claw_lane.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') out = runLane(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'full_virtual_desktop_claw', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  runLane,
  status
};
