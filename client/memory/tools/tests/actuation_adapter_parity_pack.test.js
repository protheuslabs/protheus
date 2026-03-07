#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const EXECUTOR = path.join(ROOT, 'systems', 'actuation', 'actuation_executor.js');

function run(args, env) {
  const res = spawnSync(process.execPath, [EXECUTOR, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  return txt ? JSON.parse(txt) : {};
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'actuation-parity-'));
  const receiptsDir = path.join(tmp, 'receipts');
  const outboxRoot = path.join(tmp, 'outbox');
  const fsRoot = path.join(tmp, 'fs');
  fs.mkdirSync(fsRoot, { recursive: true });

  const env = {
    ACTUATION_RECEIPTS_DIR: receiptsDir,
    ACTUATION_ADAPTER_OUTBOX_ROOT: outboxRoot,
    ACTUATION_FILESYSTEM_ROOT: fsRoot
  };

  const cases = [
    { kind: 'http_request', params: { url: 'https://example.com/hook', method: 'POST', body: { ping: true } } },
    { kind: 'browser_task', params: { url: 'https://example.com', intent: 'snapshot' }, context: { human_approved: true } },
    { kind: 'filesystem_task', params: { action: 'write_file', path: 'notes/parity.txt', content: 'adapter parity live write' } },
    { kind: 'shell_task', params: { command: 'echo', args: ['adapter_pack_ok'] } },
    { kind: 'slack_message', params: { channel: '#ops', text: 'parity probe' } },
    { kind: 'email_message', params: { to: 'ops@example.com', subject: 'Parity', body: 'Probe complete.' } },
    { kind: 'calendar_event', params: { title: 'Parity Check', start: '2026-02-27T15:00:00Z', end: '2026-02-27T15:30:00Z' } },
    { kind: 'payment_task', params: { amount: 12.34, currency: 'USD', payee: 'vendor-1', memo: 'test' }, context: { human_approved: true } },
    { kind: 'git_task', params: { action: 'status' } },
    { kind: 'crm_record', params: { entity: 'lead', record_id: 'L-100', fields: { status: 'new' } } },
    { kind: 'helpdesk_ticket', params: { subject: 'Parity issue', description: 'deterministic test payload', priority: 'low' } }
  ];

  for (const row of cases) {
    const base = [
      'run',
      `--kind=${row.kind}`,
      `--params=${JSON.stringify(row.params || {})}`
    ];
    if (row.context) base.push(`--context=${JSON.stringify(row.context)}`);

    const dry = run([...base, '--dry-run'], env);
    assert.strictEqual(dry.status, 0, `dry-run failed for ${row.kind}: ${dry.stderr || dry.stdout}`);
    const dryPayload = parseJson(dry.stdout);
    assert.strictEqual(dryPayload.ok, true, `dry-run payload not ok for ${row.kind}`);
    assert.strictEqual(
      dryPayload.summary && dryPayload.summary.adapter,
      row.kind,
      `dry-run summary adapter mismatch for ${row.kind}`
    );

    const live = run(base, env);
    assert.strictEqual(live.status, 0, `live run failed for ${row.kind}: ${live.stderr || live.stdout}`);
    const livePayload = parseJson(live.stdout);
    assert.strictEqual(livePayload.ok, true, `live payload not ok for ${row.kind}`);
    assert.strictEqual(
      livePayload.summary && livePayload.summary.adapter,
      row.kind,
      `live summary adapter mismatch for ${row.kind}`
    );
  }

  const receiptPath = path.join(receiptsDir, `${todayUtc()}.jsonl`);
  const receipts = readJsonl(receiptPath);
  const byAdapter = new Map();
  for (const rec of receipts) {
    const key = String(rec && rec.adapter || '');
    if (!key) continue;
    byAdapter.set(key, (byAdapter.get(key) || 0) + 1);
  }
  for (const row of cases) {
    assert.ok((byAdapter.get(row.kind) || 0) >= 2, `expected >=2 receipts for ${row.kind}`);
  }

  const fileOut = path.join(fsRoot, 'notes', 'parity.txt');
  assert.ok(fs.existsSync(fileOut), 'filesystem_task should create target file');
  assert.ok(fs.readFileSync(fileOut, 'utf8').includes('adapter parity'), 'filesystem_task wrote expected content');

  const expectedOutboxChannels = [
    'http_request', 'browser_task', 'slack_message', 'email_message',
    'calendar_event', 'payment_task', 'crm_record', 'helpdesk_ticket'
  ];
  for (const channel of expectedOutboxChannels) {
    const outbox = path.join(outboxRoot, channel, `${todayUtc()}.jsonl`);
    assert.ok(fs.existsSync(outbox), `expected outbox file for ${channel}`);
    const rows = readJsonl(outbox);
    assert.ok(rows.length >= 1, `expected at least one outbox row for ${channel}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('actuation_adapter_parity_pack.test.js: OK');
} catch (err) {
  console.error(`actuation_adapter_parity_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

