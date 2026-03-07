#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'ip_posture_review.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), 'utf8');
}

function run(args) {
  const res = spawnSync('node', [SCRIPT, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-posture-'));
  const policyPath = path.join(tmp, 'config', 'ip_posture_review_policy.json');

  const paths = {
    latest_path: path.join(tmp, 'state', 'security', 'ip_posture_review', 'latest.json'),
    receipts_path: path.join(tmp, 'state', 'security', 'ip_posture_review', 'receipts.jsonl'),
    counsel_records_path: path.join(tmp, 'state', 'security', 'ip_posture_review', 'counsel_records.json'),
    evidence_pack_path: path.join(tmp, 'state', 'security', 'ip_posture_review', 'evidence_pack.json'),
    invention_register_path: path.join(tmp, 'state', 'security', 'ip_posture_review', 'invention_register.json'),
    strategy_doc_path: path.join(tmp, 'docs', 'IP_POSTURE_REVIEW.md')
  };

  writeText(paths.strategy_doc_path, '# ip posture\n');
  writeJson(paths.invention_register_path, {
    schema_id: 'ip_invention_register',
    schema_version: '1.0',
    inventions: [
      { id: 'inv1', area: 'security', strategy: 'trade_secret', description: 'x' }
    ]
  });

  writeJson(policyPath, {
    enabled: true,
    shadow_only: true,
    strict_default: false,
    min_approval_note_chars: 8,
    paths
  });

  let res = run(['draft', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, `draft should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.type, 'ip_posture_draft');

  res = run(['evidence-pack', `--policy=${policyPath}`, '--apply=1']);
  assert.strictEqual(res.status, 0, `evidence-pack should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.type, 'ip_posture_evidence_pack');

  res = run([
    'record-counsel',
    `--policy=${policyPath}`,
    '--counsel=outside_counsel',
    '--firm=alpha_legal',
    '--decision=approve',
    '--approval-note=initial counsel review complete',
    '--apply=1'
  ]);
  assert.strictEqual(res.status, 0, `record-counsel should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.type, 'ip_posture_record_counsel');

  res = run(['status', '--strict=1', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status strict should pass: ${res.stderr}`);
  assert.strictEqual(res.payload.ok, true);
  assert.strictEqual(res.payload.pass, true);

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('ip_posture_review.test.js: OK');
} catch (err) {
  console.error(`ip_posture_review.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
