#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_STATE_ROOT = path.join(ROOT, 'state', 'security', 'soul_biometric');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolveStateRoot(raw: unknown) {
  const text = cleanText(raw, 320);
  if (!text) return DEFAULT_STATE_ROOT;
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function paths(stateRoot: string) {
  return {
    root: stateRoot,
    runtime_state_path: path.join(stateRoot, 'runtime_state.json'),
    revocations_path: path.join(stateRoot, 'revocations.jsonl'),
    latest_path: path.join(stateRoot, 'latest.json')
  };
}

function rotateTemplateId() {
  return `tpl_${crypto.randomBytes(8).toString('hex')}`;
}

function runRevocation(input: AnyObj = {}) {
  const stateRoot = resolveStateRoot(input.state_root);
  const p = paths(stateRoot);
  const runtime = readJson(p.runtime_state_path, {});
  const oldTemplateId = cleanText(runtime.template_id || '', 120) || null;
  const newTemplateId = rotateTemplateId();
  const reason = cleanText(input.reason || 'manual_revocation', 220) || 'manual_revocation';
  const ts = nowIso();
  const row = {
    ts,
    type: 'soul_revocation_ceremony',
    reason,
    prior_template_id: oldTemplateId,
    next_template_id: newTemplateId
  };
  appendJsonl(p.revocations_path, row);
  const nextRuntime = {
    ...runtime,
    template_id: newTemplateId,
    revoked_at: ts,
    revocation_reason: reason
  };
  writeJsonAtomic(p.runtime_state_path, nextRuntime);
  const latest = readJson(p.latest_path, {});
  if (latest && typeof latest === 'object') {
    writeJsonAtomic(p.latest_path, {
      ...latest,
      template_id: newTemplateId,
      revocation_pending_reenroll: true,
      revocation_reason: reason,
      revocation_ts: ts
    });
  }
  return {
    ok: true,
    type: 'soul_revocation_ceremony',
    ts,
    reason,
    prior_template_id: oldTemplateId,
    next_template_id: newTemplateId,
    state_root: relPath(p.root),
    revocations_path: relPath(p.revocations_path)
  };
}

function statusRevocation(input: AnyObj = {}) {
  const stateRoot = resolveStateRoot(input.state_root);
  const p = paths(stateRoot);
  const runtime = readJson(p.runtime_state_path, {});
  return {
    ok: true,
    type: 'soul_revocation_status',
    ts: nowIso(),
    state_root: relPath(p.root),
    template_id: cleanText(runtime.template_id || '', 120) || null,
    revoked_at: cleanText(runtime.revoked_at || '', 80) || null,
    revocation_reason: cleanText(runtime.revocation_reason || '', 220) || null
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/soul/revocation_ceremony.js revoke [--state-root=path] [--reason=text]');
  console.log('  node systems/soul/revocation_ceremony.js status [--state-root=path]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 24) || 'status';
  if (cmd === 'revoke') {
    const out = runRevocation({
      state_root: args['state-root'] || args.state_root,
      reason: args.reason
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  if (cmd === 'status') {
    const out = statusRevocation({
      state_root: args['state-root'] || args.state_root
    });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  usage();
  process.exitCode = 2;
}

if (require.main === module) {
  try {
    main();
  } catch (err: any) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'soul_revocation_ceremony',
      error: cleanText(err && err.message ? err.message : err || 'soul_revocation_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  runRevocation,
  statusRevocation
};

