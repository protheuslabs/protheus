#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'evidence_audit_dashboard.js');

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  const raw = String(out.stdout || '').trim();
  let payload = {};
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    const lines = raw.split(/\r?\n/).filter(Boolean);
    for (let idx = 0; idx < lines.length; idx += 1) {
      const candidate = lines.slice(idx).join('\n');
      try {
        payload = JSON.parse(candidate);
        break;
      } catch {
        // continue
      }
    }
  }
  return { status: out.status, payload, stderr: String(out.stderr || '') };
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-dash-'));
  const okEvidence = path.join(tmp, 'ok.json');
  const badEvidence = path.join(tmp, 'bad.json');
  fs.writeFileSync(okEvidence, JSON.stringify({ ok: true, type: 'sample_ok' }));
  fs.writeFileSync(badEvidence, JSON.stringify({ ok: false, type: 'sample_bad' }));

  const policyPath = path.join(tmp, 'config', 'evidence_audit_dashboard_policy.json');
  fs.mkdirSync(path.dirname(policyPath), { recursive: true });
  fs.writeFileSync(policyPath, JSON.stringify({
    version: '1.0',
    enabled: true,
    strict_default: true,
    owner_id: 'test',
    event_stream: { enabled: true, publish: true, stream: 'ops.test' },
    paths: {
      memory_dir: path.join(tmp, 'state', 'memory'),
      adaptive_index_path: path.join(tmp, 'adaptive', 'index.json'),
      events_path: path.join(tmp, 'state', 'events.jsonl'),
      latest_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl'),
      export_json_path: path.join(tmp, 'state', 'export.json'),
      export_md_path: path.join(tmp, 'state', 'export.md')
    },
    claims: [
      { id: 'claim_ok', evidence: [okEvidence] },
      { id: 'claim_bad', evidence: [badEvidence] }
    ]
  }, null, 2));

  const runRes = run(['run', `--policy=${policyPath}`]);
  assert.strictEqual(runRes.status, 0, runRes.stderr);
  assert.strictEqual(runRes.payload.ok, true);
  assert.strictEqual(runRes.payload.payload.summary.total, 2);
  assert.strictEqual(runRes.payload.payload.summary.failing, 1);

  const exportRes = run(['export', '--format=md', `--policy=${policyPath}`]);
  assert.strictEqual(exportRes.status, 0, exportRes.stderr);
  assert.strictEqual(exportRes.payload.ok, true);
  assert.strictEqual(fs.existsSync(path.join(tmp, 'state', 'export.md')), true);

  console.log('evidence_audit_dashboard.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`evidence_audit_dashboard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
