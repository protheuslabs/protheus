#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'assimilation', 'source_attestation_extension.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function parsePayload(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, env = {}) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
  return { status: Number(r.status || 0), payload: parsePayload(r.stdout), stderr: String(r.stderr || '') };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'source-attestation-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  writeJson(policyPath, {
    enabled: true,
    min_trust_score: 0.55,
    receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
    latest_path: path.join(tmp, 'state', 'latest.json')
  });
  const env = { SOURCE_ATTESTATION_EXTENSION_POLICY_PATH: policyPath };

  let r = run(['attest', '--source-id=doc_a', '--payload=important content', '--proof=signature_blob', '--trust-score=0.8'], env);
  assert.strictEqual(r.status, 0, `attest should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'attest should be accepted');
  assert.strictEqual(r.payload.routing_hint, 'normal_confidence', 'normal confidence hint expected');

  r = run(['status'], env);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  assert.ok(r.payload && r.payload.ok === true, 'status should be ok');

  console.log('source_attestation_extension.test.js: OK');
}

try { main(); } catch (err) {
  console.error(`source_attestation_extension.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
