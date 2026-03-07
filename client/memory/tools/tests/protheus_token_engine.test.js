#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TOKEN_SCRIPT = path.join(ROOT, 'systems', 'economy', 'protheus_token_engine.js');
const FUND_SCRIPT = path.join(ROOT, 'systems', 'economy', 'global_directive_fund.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-token-'));
  const prefDir = path.join(tmp, 'memory', 'economy', 'preferences');
  const adaptiveIndex = path.join(tmp, 'adaptive', 'economy', 'preferences', 'index.json');
  const tokenPolicy = path.join(tmp, 'config', 'protheus_token_engine_policy.json');
  const fundPolicy = path.join(tmp, 'config', 'global_directive_fund_policy.json');

  writeJson(tokenPolicy, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    paths: {
      memory_preferences_dir: prefDir,
      adaptive_index_path: adaptiveIndex,
      balances_path: path.join(tmp, 'state', 'economy', 'protheus_token_balances.json'),
      ledger_path: path.join(tmp, 'state', 'economy', 'protheus_token_ledger.jsonl'),
      bridge_receipts_path: path.join(tmp, 'state', 'blockchain', 'protheus_token_bridge.jsonl'),
      latest_path: path.join(tmp, 'state', 'economy', 'protheus_token_engine', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'economy', 'protheus_token_engine', 'receipts.jsonl')
    }
  });

  writeJson(fundPolicy, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    paths: {
      memory_preferences_dir: prefDir,
      adaptive_index_path: adaptiveIndex,
      objectives_path: path.join(tmp, 'state', 'economy', 'global_directive_fund', 'objectives.json'),
      votes_path: path.join(tmp, 'state', 'economy', 'global_directive_fund', 'votes.jsonl'),
      latest_path: path.join(tmp, 'state', 'economy', 'global_directive_fund', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'economy', 'global_directive_fund', 'receipts.jsonl')
    }
  });

  let out = run(TOKEN_SCRIPT, [
    'configure',
    '--owner=jay',
    '--allocation-pct=0.15',
    '--objective=ai_safety_research',
    '--strict=1',
    `--policy=${tokenPolicy}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'token configure should pass');

  out = run(TOKEN_SCRIPT, [
    'mint',
    '--owner=jay',
    '--amount=250',
    '--reason=genesis',
    '--strict=1',
    `--policy=${tokenPolicy}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.balance_after === 250, 'mint should increase balance');

  out = run(FUND_SCRIPT, [
    'allocate',
    '--owner=jay',
    '--allocation-pct=0.2',
    '--objective=open_source_ai_safety',
    '--strict=1',
    `--policy=${fundPolicy}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'fund allocate should pass');

  out = run(FUND_SCRIPT, [
    'vote',
    '--owner=jay',
    '--objective=open_source_ai_safety',
    '--choice=approve',
    '--weight=3',
    '--strict=1',
    `--policy=${fundPolicy}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'fund vote should pass');

  out = run(TOKEN_SCRIPT, [
    'status',
    '--owner=jay',
    '--strict=1',
    `--policy=${tokenPolicy}`
  ]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.balance === 250, 'status should show balance');

  const prefFile = path.join(prefDir, 'jay.json');
  assert.ok(fs.existsSync(prefFile), 'user preference should be written in client/memory/');
  const adaptivePayload = JSON.parse(fs.readFileSync(adaptiveIndex, 'utf8'));
  assert.ok(Array.isArray(adaptivePayload.preferences) && adaptivePayload.preferences.length > 0, 'adaptive index should be written');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('protheus_token_engine.test.js: OK');
} catch (err) {
  console.error(`protheus_token_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
