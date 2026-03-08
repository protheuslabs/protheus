#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { cleanText } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.BROWSER_SESSION_VAULT_POLICY_PATH
  ? path.resolve(process.env.BROWSER_SESSION_VAULT_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'browser', 'browser_session_vault_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/browser/browser_session_vault.js save --session=<id> --state-json=<json> [--apply=1]');
  console.log('  node systems/browser/browser_session_vault.js restore --session=<id>');
  console.log('  node systems/browser/browser_session_vault.js status');
}

function key(policy: any) {
  const seed = cleanText(process.env.BROWSER_SESSION_VAULT_KEY || policy.encryption_key || 'browser_session_vault_key', 200);
  return crypto.createHash('sha256').update(seed).digest();
}

function encrypt(policy: any, text: string) {
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key(policy), iv);
  const out = Buffer.concat([cipher.update(Buffer.from(text, 'utf8')), cipher.final()]);
  return { iv: iv.toString('hex'), data: out.toString('hex') };
}

function decrypt(policy: any, ivHex: string, dataHex: string) {
  const decipher = crypto.createDecipheriv('aes-256-cbc', key(policy), Buffer.from(ivHex, 'hex'));
  const out = Buffer.concat([decipher.update(Buffer.from(dataHex, 'hex')), decipher.final()]);
  return out.toString('utf8');
}

runStandardLane({
  lane_id: 'V6-BROWSER-003',
  script_rel: 'systems/browser/browser_session_vault.js',
  policy_path: POLICY_PATH,
  stream: 'browser.session_vault',
  paths: {
    memory_dir: 'client/local/state/browser/session_vault/memory',
    adaptive_index_path: 'client/local/adaptive/browser/session_vault/index.json',
    events_path: 'client/local/state/browser/session_vault/events.jsonl',
    latest_path: 'client/local/state/browser/session_vault/latest.json',
    receipts_path: 'client/local/state/browser/session_vault/receipts.jsonl',
    sessions_path: 'client/local/state/browser/session_vault/sessions.json'
  },
  usage,
  handlers: {
    save(policy: any, args: any, ctx: any) {
      const session = cleanText(args.session || '', 120);
      if (!session) return { ok: false, type: 'browser_session_vault', action: 'save', error: 'session_required' };
      const stateJson = cleanText(args['state-json'] || args.state_json || '{}', 120000);
      const sealed = encrypt(policy, stateJson);
      const sessionsPath = String(policy.paths.sessions_path || '');
      let all: any = {};
      if (fs.existsSync(sessionsPath)) {
        try { all = JSON.parse(String(fs.readFileSync(sessionsPath, 'utf8') || '{}')); } catch { all = {}; }
      }
      all[session] = { iv: sealed.iv, data: sealed.data, encrypted: true, ts: new Date().toISOString() };
      fs.mkdirSync(path.dirname(sessionsPath), { recursive: true });
      fs.writeFileSync(sessionsPath, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
      return ctx.cmdRecord(policy, { ...args, event: 'browser_session_save', payload_json: JSON.stringify({ ok: true, session, encrypted: true }) });
    },
    restore(policy: any, args: any, ctx: any) {
      const session = cleanText(args.session || '', 120);
      const sessionsPath = String(policy.paths.sessions_path || '');
      if (!session || !fs.existsSync(sessionsPath)) {
        return { ok: false, type: 'browser_session_vault', action: 'restore', error: 'session_not_found', fail_closed: true };
      }
      let all: any = {};
      try { all = JSON.parse(String(fs.readFileSync(sessionsPath, 'utf8') || '{}')); } catch { return { ok: false, type: 'browser_session_vault', action: 'restore', error: 'session_store_decode_failed', fail_closed: true }; }
      const row = all[session];
      if (!row || !row.iv || !row.data) {
        return { ok: false, type: 'browser_session_vault', action: 'restore', error: 'session_not_found', fail_closed: true };
      }
      try {
        const plain = decrypt(policy, String(row.iv), String(row.data));
        return ctx.cmdRecord(policy, { ...args, event: 'browser_session_restore', payload_json: JSON.stringify({ ok: true, session, state_json: plain }) });
      } catch {
        return { ok: false, type: 'browser_session_vault', action: 'restore', error: 'decrypt_failed', fail_closed: true };
      }
    }
  }
});
