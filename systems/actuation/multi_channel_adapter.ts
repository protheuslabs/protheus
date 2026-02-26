#!/usr/bin/env node
'use strict';
export {};

/**
 * multi_channel_adapter.js
 *
 * Deterministic adapter pack for channel parity:
 * - http_request
 * - browser_task
 * - filesystem_task
 * - shell_task
 * - slack_message
 * - discord_message
 * - email_message
 * - upwork_message
 * - calendar_event
 * - payment_task
 * - git_task
 * - crm_record
 * - helpdesk_ticket
 *
 * External channels use outbox contracts for deterministic live behavior.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const OUTBOX_ROOT = process.env.ACTUATION_ADAPTER_OUTBOX_ROOT
  ? path.resolve(String(process.env.ACTUATION_ADAPTER_OUTBOX_ROOT))
  : path.join(ROOT, 'state', 'actuation', 'outbox');
const FS_ROOT = process.env.ACTUATION_FILESYSTEM_ROOT
  ? path.resolve(String(process.env.ACTUATION_FILESYSTEM_ROOT))
  : ROOT;
const DEFAULT_TIMEOUT_MS = Math.max(500, Math.min(30000, Number(process.env.ACTUATION_ADAPTER_TIMEOUT_MS || 5000) || 5000));

function nowIso() {
  return new Date().toISOString();
}

function dayStr() {
  return nowIso().slice(0, 10);
}

function clean(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function token(v: unknown, maxLen = 80) {
  return clean(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath: string, row: Record<string, any>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function shaShort(value: any) {
  return crypto.createHash('sha256').update(JSON.stringify(value || {})).digest('hex').slice(0, 16);
}

function resolveWithin(baseDir: string, relPath: string) {
  const abs = path.resolve(baseDir, relPath || '.');
  const normalizedBase = path.resolve(baseDir);
  if (abs !== normalizedBase && !abs.startsWith(`${normalizedBase}${path.sep}`)) {
    throw new Error('path_outside_allowed_root');
  }
  return abs;
}

function outboxWrite(kind: string, payload: Record<string, any>) {
  const channel = token(kind, 60) || 'unknown';
  const filePath = path.join(OUTBOX_ROOT, channel, `${dayStr()}.jsonl`);
  const row = {
    ts: nowIso(),
    channel,
    message_id: `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`,
    payload
  };
  appendJsonl(filePath, row);
  return {
    channel,
    outbox_path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
    message_id: row.message_id
  };
}

function allowCommand(cmd: string, args: string[]) {
  const c = token(cmd, 40);
  if (!c) return false;
  const allow = new Set(['echo', 'pwd', 'ls', 'date', 'whoami', 'uname', 'git']);
  if (!allow.has(c)) return false;
  if (c !== 'git') return true;
  const sub = token(args[0] || '', 40);
  return new Set(['status', 'log', 'rev-parse', 'branch']).has(sub);
}

function runSpawn(command: string, args: string[], cwd: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const proc = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: process.env
  });
  const code = Number(proc.status == null ? 1 : proc.status);
  return {
    ok: code === 0,
    code,
    stdout: clean(proc.stdout, 2000),
    stderr: clean(proc.stderr, 800)
  };
}

function summaryAllow(adapter: string, action: string, dryRun: boolean, verified: boolean, extra = {}) {
  return {
    decision: 'ACTUATE',
    gate_decision: 'ALLOW',
    executable: true,
    adapter,
    action,
    dry_run: dryRun === true,
    verified: verified === true,
    ...extra
  };
}

function deny(adapter: string, reason: string, code = 2) {
  return {
    ok: false,
    code,
    summary: {
      decision: 'ACTUATE',
      gate_decision: 'DENY',
      executable: false,
      adapter,
      verified: false,
      reason: clean(reason, 200) || 'invalid_params'
    },
    details: { reason: clean(reason, 200) || 'invalid_params' }
  };
}

function requiredString(params: Record<string, any>, key: string) {
  const value = clean(params && params[key], 800);
  return value || null;
}

function executeHttpRequest(params: Record<string, any>, dryRun: boolean) {
  const url = requiredString(params, 'url');
  if (!url) return deny('http_request', 'missing_url');
  const method = token(params.method || 'get', 16).toUpperCase() || 'GET';
  const payload = {
    method,
    url: clean(url, 1200),
    headers: params.headers && typeof params.headers === 'object' ? params.headers : {},
    body: params.body != null ? params.body : null,
    timeout_ms: Math.max(250, Math.min(30000, Number(params.timeout_ms || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS))
  };
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('http_request', 'queue_http_request', true, false),
      details: { preview: payload, fingerprint: shaShort(payload) }
    };
  }
  const row = outboxWrite('http_request', payload);
  return {
    ok: true,
    code: 0,
    summary: summaryAllow('http_request', 'queue_http_request', false, true, { outbox_channel: row.channel }),
    details: { queued: true, ...row, fingerprint: shaShort(payload) }
  };
}

function executeBrowserTask(params: Record<string, any>, dryRun: boolean) {
  const url = requiredString(params, 'url');
  const intent = requiredString(params, 'intent') || 'navigate';
  if (!url) return deny('browser_task', 'missing_url');
  const payload = {
    url: clean(url, 1200),
    intent: clean(intent, 120),
    selector: clean(params.selector || '', 240) || null,
    action: clean(params.action || '', 80) || null
  };
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('browser_task', 'queue_browser_task', true, false),
      details: { preview: payload, fingerprint: shaShort(payload) }
    };
  }
  const row = outboxWrite('browser_task', payload);
  return {
    ok: true,
    code: 0,
    summary: summaryAllow('browser_task', 'queue_browser_task', false, true, { outbox_channel: row.channel }),
    details: { queued: true, ...row, fingerprint: shaShort(payload) }
  };
}

function executeFilesystemTask(params: Record<string, any>, dryRun: boolean) {
  const action = token(params.action || 'write_file', 40);
  const rel = clean(params.path || '', 320);
  if (!rel) return deny('filesystem_task', 'missing_path');
  let targetAbs = null;
  try {
    targetAbs = resolveWithin(FS_ROOT, rel);
  } catch {
    return deny('filesystem_task', 'path_outside_allowed_root');
  }
  const targetRel = path.relative(ROOT, targetAbs).replace(/\\/g, '/');
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('filesystem_task', action || 'filesystem', true, false),
      details: { preview: { action, path: targetRel } }
    };
  }
  if (action === 'write_file') {
    const content = String(params.content == null ? '' : params.content);
    ensureDir(path.dirname(targetAbs));
    fs.writeFileSync(targetAbs, content, 'utf8');
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('filesystem_task', 'write_file', false, true),
      details: { path: targetRel, bytes_written: Buffer.byteLength(content, 'utf8') }
    };
  }
  if (action === 'read_file') {
    const text = fs.existsSync(targetAbs) ? fs.readFileSync(targetAbs, 'utf8') : '';
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('filesystem_task', 'read_file', false, true),
      details: { path: targetRel, bytes_read: Buffer.byteLength(text, 'utf8'), content_preview: clean(text, 400) }
    };
  }
  if (action === 'list_dir') {
    const rows = fs.existsSync(targetAbs) ? fs.readdirSync(targetAbs).slice(0, 200) : [];
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('filesystem_task', 'list_dir', false, true),
      details: { path: targetRel, items: rows }
    };
  }
  return deny('filesystem_task', `unsupported_action:${action || 'unknown'}`);
}

function executeShellTask(params: Record<string, any>, dryRun: boolean) {
  const command = clean(params.command || '', 80);
  const args = Array.isArray(params.args) ? params.args.map((v) => clean(v, 120)).filter(Boolean) : [];
  if (!command) return deny('shell_task', 'missing_command');
  if (!allowCommand(command, args)) return deny('shell_task', 'command_not_allowlisted');
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('shell_task', 'exec_shell_command', true, false),
      details: { preview: { command, args } }
    };
  }
  const run = runSpawn(command, args, ROOT, Math.max(500, Math.min(15000, Number(params.timeout_ms || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)));
  if (!run.ok) return deny('shell_task', run.stderr || `exit_${run.code}`, run.code || 1);
  return {
    ok: true,
    code: 0,
    summary: summaryAllow('shell_task', 'exec_shell_command', false, true),
    details: { command, args, stdout: run.stdout }
  };
}

function queueMessageAdapter(adapter: string, action: string, required: string[], params: Record<string, any>, dryRun: boolean) {
  const payload: Record<string, any> = {};
  for (const key of required) {
    const v = requiredString(params, key);
    if (!v) return deny(adapter, `missing_${key}`);
    payload[key] = v;
  }
  for (const [k, v] of Object.entries(params || {})) {
    if (payload[k] != null) continue;
    payload[k] = v;
  }
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      summary: summaryAllow(adapter, action, true, false),
      details: { preview: payload, fingerprint: shaShort(payload) }
    };
  }
  const row = outboxWrite(adapter, payload);
  return {
    ok: true,
    code: 0,
    summary: summaryAllow(adapter, action, false, true, { outbox_channel: row.channel }),
    details: { queued: true, ...row, fingerprint: shaShort(payload) }
  };
}

function executePaymentTask(params: Record<string, any>, dryRun: boolean) {
  const amount = Number(params.amount);
  const currency = requiredString(params, 'currency');
  const payee = requiredString(params, 'payee');
  if (!Number.isFinite(amount) || amount <= 0) return deny('payment_task', 'invalid_amount');
  if (!currency) return deny('payment_task', 'missing_currency');
  if (!payee) return deny('payment_task', 'missing_payee');
  const payload = {
    amount: Number(amount.toFixed(2)),
    currency: token(currency, 12).toUpperCase(),
    payee: clean(payee, 120),
    memo: clean(params.memo || '', 240) || null,
    reference_id: clean(params.reference_id || '', 80) || null
  };
  if (dryRun) {
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('payment_task', 'queue_payment', true, false),
      details: { preview: payload, fingerprint: shaShort(payload) }
    };
  }
  const row = outboxWrite('payment_task', payload);
  return {
    ok: true,
    code: 0,
    summary: summaryAllow('payment_task', 'queue_payment', false, true, { outbox_channel: row.channel }),
    details: { queued: true, ...row, fingerprint: shaShort(payload) }
  };
}

function executeGitTask(params: Record<string, any>, dryRun: boolean) {
  const action = token(params.action || 'status', 40);
  let gitArgs = ['status', '--short'];
  if (action === 'status') gitArgs = ['status', '--short'];
  else if (action === 'log') gitArgs = ['log', '--oneline', '-n', String(Math.max(1, Math.min(20, Number(params.limit || 5) || 5)))];
  else if (action === 'rev_parse') gitArgs = ['rev-parse', '--short', 'HEAD'];
  else return deny('git_task', `unsupported_action:${action}`);

  if (dryRun) {
    return {
      ok: true,
      code: 0,
      summary: summaryAllow('git_task', `git_${action}`, true, false),
      details: { preview: { git_args: gitArgs } }
    };
  }
  const run = runSpawn('git', gitArgs, ROOT, Math.max(500, Math.min(15000, Number(params.timeout_ms || DEFAULT_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)));
  if (!run.ok) return deny('git_task', run.stderr || `git_exit_${run.code}`, run.code || 1);
  return {
    ok: true,
    code: 0,
    summary: summaryAllow('git_task', `git_${action}`, false, true),
    details: { git_args: gitArgs, stdout: run.stdout }
  };
}

function executeByKind(kind: string, params: Record<string, any>, dryRun: boolean) {
  if (kind === 'http_request') return executeHttpRequest(params, dryRun);
  if (kind === 'browser_task') return executeBrowserTask(params, dryRun);
  if (kind === 'filesystem_task') return executeFilesystemTask(params, dryRun);
  if (kind === 'shell_task') return executeShellTask(params, dryRun);
  if (kind === 'slack_message') return queueMessageAdapter('slack_message', 'queue_slack_message', ['channel', 'text'], params, dryRun);
  if (kind === 'discord_message') return queueMessageAdapter('discord_message', 'queue_discord_message', ['channel_id', 'content'], params, dryRun);
  if (kind === 'email_message') return queueMessageAdapter('email_message', 'queue_email_message', ['to', 'subject', 'body'], params, dryRun);
  if (kind === 'upwork_message') return queueMessageAdapter('upwork_message', 'queue_upwork_message', ['thread_id', 'body'], params, dryRun);
  if (kind === 'calendar_event') return queueMessageAdapter('calendar_event', 'queue_calendar_event', ['title', 'start', 'end'], params, dryRun);
  if (kind === 'payment_task') return executePaymentTask(params, dryRun);
  if (kind === 'git_task') return executeGitTask(params, dryRun);
  if (kind === 'crm_record') return queueMessageAdapter('crm_record', 'queue_crm_record', ['entity', 'record_id'], params, dryRun);
  if (kind === 'helpdesk_ticket') return queueMessageAdapter('helpdesk_ticket', 'queue_helpdesk_ticket', ['subject', 'description'], params, dryRun);
  return deny(kind || 'unknown', 'unsupported_adapter_kind');
}

async function execute({ params, dryRun, kind }) {
  const adapterKind = token(kind || '', 80);
  if (!adapterKind) return deny('unknown', 'missing_adapter_kind');
  const p = params && typeof params === 'object' ? params : {};
  return executeByKind(adapterKind, p, dryRun === true);
}

module.exports = {
  id: 'multi_channel_adapter',
  description: 'Deterministic multi-channel adapter pack for top practical channels.',
  execute
};
