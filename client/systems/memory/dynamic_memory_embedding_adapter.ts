#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.DYNAMIC_MEMORY_EMBEDDING_POLICY_PATH
  ? path.resolve(process.env.DYNAMIC_MEMORY_EMBEDDING_POLICY_PATH)
  : path.join(ROOT, 'config', 'dynamic_memory_embedding_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 280) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 180) { return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, ''); }
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
    max_updates_per_session: 12,
    receipts_path: 'state/memory/dynamic_embedding_adapter/receipts.jsonl',
    sessions_path: 'state/memory/dynamic_embedding_adapter/sessions.json',
    latest_path: 'state/memory/dynamic_embedding_adapter/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    shadow_only: src.shadow_only !== false,
    max_updates_per_session: Number(src.max_updates_per_session != null ? src.max_updates_per_session : base.max_updates_per_session) || base.max_updates_per_session,
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    sessions_path: resolvePath(src.sessions_path || base.sessions_path, base.sessions_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function adapt(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'dynamic_memory_embedding_adapt', error: 'policy_disabled' };

  const sessionId = normalizeToken(args['session-id'] || args.session_id || `session_${Date.now()}`, 160);
  const text = cleanText(args.text || args.payload || '', 4000);
  if (!text) return { ok: false, type: 'dynamic_memory_embedding_adapt', error: 'text_required' };

  const sessions = readJson(policy.sessions_path, { schema_id: 'dynamic_embedding_sessions', schema_version: '1.0', sessions: {} });
  if (!sessions.sessions || typeof sessions.sessions !== 'object') sessions.sessions = {};
  const existing = sessions.sessions[sessionId] && typeof sessions.sessions[sessionId] === 'object'
    ? sessions.sessions[sessionId]
    : {
      session_id: sessionId,
      created_at: nowIso(),
      update_count: 0,
      updates: []
    };
  if (Number(existing.update_count || 0) >= Number(policy.max_updates_per_session || 12)) {
    return {
      ok: false,
      type: 'dynamic_memory_embedding_adapt',
      error: 'max_updates_per_session_exceeded',
      session_id: sessionId,
      update_count: Number(existing.update_count || 0)
    };
  }

  const embeddingCommit = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
  const rollbackToken = `rollback_${embeddingCommit.slice(0, 16)}`;
  const update = {
    ts: nowIso(),
    session_id: sessionId,
    embedding_commit: embeddingCommit,
    rollback_token: rollbackToken,
    payload_chars: text.length
  };

  existing.update_count = Number(existing.update_count || 0) + 1;
  existing.last_updated_at = update.ts;
  existing.updates = Array.isArray(existing.updates) ? existing.updates : [];
  existing.updates.push(update);
  sessions.updated_at = update.ts;
  sessions.sessions[sessionId] = existing;
  writeJsonAtomic(policy.sessions_path, sessions);

  const out = {
    ok: true,
    type: 'dynamic_memory_embedding_adapt',
    ts: nowIso(),
    session_id: sessionId,
    update_count: existing.update_count,
    embedding_commit: embeddingCommit,
    rollback_token: rollbackToken,
    shadow_only: policy.shadow_only === true
  };
  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const sessions = readJson(policy.sessions_path, { sessions: {} });
  const sessionRows = sessions && sessions.sessions && typeof sessions.sessions === 'object'
    ? Object.values(sessions.sessions)
    : [];
  const latest = readJson(policy.latest_path, null);
  return {
    ok: true,
    type: 'dynamic_memory_embedding_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only === true,
      max_updates_per_session: policy.max_updates_per_session
    },
    sessions: {
      total: sessionRows.length,
      updates: sessionRows.reduce((acc: number, row: AnyObj) => acc + Number(row && row.update_count || 0), 0)
    },
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        session_id: latest.session_id || null,
        update_count: Number(latest.update_count || 0)
      }
      : null,
    paths: {
      sessions_path: relPath(policy.sessions_path),
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/dynamic_memory_embedding_adapter.js adapt --session-id=<id> --text="..."');
  console.log('  node systems/memory/dynamic_memory_embedding_adapter.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) { usage(); process.exit(0); }
  if (cmd === 'adapt') out = adapt(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'dynamic_memory_embedding_adapter', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  adapt,
  status
};
