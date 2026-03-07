#!/usr/bin/env node
'use strict';

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'adaptive', 'rsi', 'rsi_integrity_chain_guard.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
}

function sha256Hex(raw) {
  return crypto.createHash('sha256').update(String(raw || ''), 'utf8').digest('hex');
}

function merkleRoot(hashes) {
  let level = hashes.slice(0);
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = level[i + 1] || left;
      next.push(sha256Hex(`${left}${right}`));
    }
    level = next;
  }
  return level[0] || null;
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rsi-integrity-'));
  const chainPath = path.join(tmp, 'state', 'adaptive', 'rsi', 'chain.jsonl');
  const merklePath = path.join(tmp, 'state', 'adaptive', 'rsi', 'merkle.json');
  const policyPath = path.join(tmp, 'config', 'rsi_integrity_chain_guard_policy.json');

  const row1 = { step_id: 's1', prev_hash: null, step_hash: sha256Hex('s1') };
  const row2 = { step_id: 's2', prev_hash: row1.step_hash, step_hash: sha256Hex('s2') };
  appendJsonl(chainPath, [row1, row2]);
  writeJson(merklePath, { merkle_root: merkleRoot([row1.step_hash, row2.step_hash]) });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    event_stream: { enabled: false, publish: false, stream: 'adaptive.rsi.integrity_chain_guard' },
    rsi_chain_path: chainPath,
    rsi_merkle_path: merklePath,
    reversion_script: path.join(ROOT, 'systems', 'autonomy', 'self_mod_reversion_drill.js'),
    continuity_script: path.join(ROOT, 'systems', 'continuity', 'resurrection_protocol.js'),
    paths: {
      memory_dir: path.join(tmp, 'memory', 'adaptive', 'rsi_integrity_chain_guard'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'rsi', 'integrity_chain_guard', 'index.json'),
      events_path: path.join(tmp, 'state', 'adaptive', 'rsi_integrity_chain_guard', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'adaptive', 'rsi_integrity_chain_guard', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'adaptive', 'rsi_integrity_chain_guard', 'receipts.jsonl'),
      integrity_state_path: path.join(tmp, 'state', 'adaptive', 'rsi_integrity_chain_guard', 'state.json')
    }
  });

  let out = run(['verify', '--owner=jay', '--strict=1', '--mock=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'rsi_integrity_chain_verify', 'verify should emit receipt');

  out = run(['rollback-drill', '--owner=jay', '--strict=1', '--mock=1', '--apply=1', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.event === 'rsi_integrity_chain_rollback_drill', 'rollback drill should emit receipt');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('rsi_integrity_chain_guard.test.js: OK');
} catch (err) {
  console.error(`rsi_integrity_chain_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
