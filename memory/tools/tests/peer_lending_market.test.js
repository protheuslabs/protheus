#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'economy', 'peer_lending_market.js');

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

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'peer-lending-'));
  const policyPath = path.join(tmp, 'config', 'peer_lending_market_policy.json');
  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    risk: {
      default_tier: 2,
      require_explicit_approval_tier: 3
    },
    event_stream: {
      enabled: false,
      publish: false,
      stream: 'economy.peer_lending'
    },
    paths: {
      memory_dir: path.join(tmp, 'memory', 'economy', 'peer_lending'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'economy', 'peer_lending', 'index.json'),
      events_path: path.join(tmp, 'state', 'economy', 'peer_lending', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'economy', 'peer_lending', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'economy', 'peer_lending', 'receipts.jsonl'),
      peer_lending_events_path: path.join(tmp, 'state', 'economy', 'peer_lending', 'settlement_events.jsonl')
    }
  });

  let out = run([
    'configure',
    '--owner=jay',
    '--allowlist=alice,bob',
    '--min-credit=0.1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'configure should pass');

  out = run([
    'lend',
    '--lender=jay',
    '--borrower=alice',
    '--gpu-hours=12',
    '--credit-rate=4.5',
    '--risk-tier=2',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'lend should pass');

  out = run([
    'settle',
    '--lender=jay',
    '--borrower=alice',
    '--settlement-credit=54',
    '--risk-tier=2',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'settle should pass');

  assert.ok(fs.existsSync(path.join(tmp, 'memory', 'economy', 'peer_lending', 'jay.json')), 'memory preference should exist');
  assert.ok(fs.existsSync(path.join(tmp, 'adaptive', 'economy', 'peer_lending', 'index.json')), 'adaptive index should exist');
  assert.ok(fs.existsSync(path.join(tmp, 'state', 'economy', 'peer_lending', 'settlement_events.jsonl')), 'peer lending settlement log should exist');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('peer_lending_market.test.js: OK');
} catch (err) {
  console.error(`peer_lending_market.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
