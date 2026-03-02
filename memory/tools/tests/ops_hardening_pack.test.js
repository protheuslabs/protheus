#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LEDGER = path.join(ROOT, 'systems', 'audit', 'hash_chain_ledger.js');
const SCHED = path.join(ROOT, 'systems', 'spine', 'background_hands_scheduler.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(script, args) {
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-hardening-'));
  const ledgerPolicy = path.join(tmp, 'config', 'hash_chain_ledger_policy.json');
  writeJson(ledgerPolicy, {
    version: '1.0-test',
    enabled: true,
    paths: {
      chain_path: path.join(tmp, 'state', 'audit', 'hash_chain_ledger', 'chain.jsonl'),
      latest_path: path.join(tmp, 'state', 'audit', 'hash_chain_ledger', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'audit', 'hash_chain_ledger', 'receipts.jsonl')
    }
  });
  let out = run(LEDGER, ['append', '--event=boot', '--payload_json={\"ok\":true}', `--policy=${ledgerPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(LEDGER, ['verify', '--strict=1', `--policy=${ledgerPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.pass, true);

  const schedPolicy = path.join(tmp, 'config', 'background_hands_scheduler_policy.json');
  writeJson(schedPolicy, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'spine.background_hands' },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'ops', 'preferences'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'ops', 'index.json'),
      events_path: path.join(tmp, 'state', 'spine', 'background_hands', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'spine', 'background_hands', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'spine', 'background_hands', 'receipts.jsonl')
    }
  });
  out = run(SCHED, ['configure', '--owner=jay', '--cadence=hourly', `--policy=${schedPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  out = run(SCHED, ['schedule', '--owner=jay', '--task=queue_gc', '--risk-tier=2', `--policy=${schedPolicy}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.event, 'background_hand_schedule');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ops_hardening_pack.test.js: OK');
} catch (err) {
  console.error(`ops_hardening_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
