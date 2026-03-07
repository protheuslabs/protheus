#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'autonomy', 'proposal_admission_hygiene.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
function appendJsonl(filePath, row) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) {
  const t = String(stdout || '').trim(); if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const lines = t.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'proposal-hygiene-'));
  const policyPath = path.join(tmp, 'config', 'proposal_admission_hygiene_policy.json');
  const proposalsPath = path.join(tmp, 'state', 'autonomy', 'proposal_admission_hygiene', 'proposals.jsonl');
  appendJsonl(proposalsPath, { proposal_id: 'p1', title: 'Real task', eye_id: 'hn', status: 'queued' });
  appendJsonl(proposalsPath, { proposal_id: 'p1', title: 'Duplicate task', eye_id: 'hn', status: 'queued' });
  appendJsonl(proposalsPath, { proposal_id: 'p2', title: 'Stub placeholder', eye_id: 'hn', status: 'queued' });
  appendJsonl(proposalsPath, { proposal_id: 'p3', title: 'Unknown eye thing', eye_id: 'unknown', status: 'unknown' });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    inputs: { proposals_path: proposalsPath },
    static_gate: {
      unknown_eye_blocklist: ['unknown', 'stub'],
      title_stub_tokens: ['stub', 'placeholder']
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'autonomy', 'proposal_admission_hygiene', 'latest.json'),
      history_path: path.join(tmp, 'state', 'autonomy', 'proposal_admission_hygiene', 'history.jsonl'),
      accepted_path: path.join(tmp, 'state', 'autonomy', 'proposal_admission_hygiene', 'accepted.json'),
      filtered_path: path.join(tmp, 'state', 'autonomy', 'proposal_admission_hygiene', 'filtered.json')
    }
  });

  const env = { PROPOSAL_HYGIENE_ROOT: tmp, PROPOSAL_HYGIENE_POLICY_PATH: policyPath };
  const r = run(['run', '--apply=1', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'hygiene run should pass');
  const out = parseJson(r.stdout);
  assert.ok(out && out.counts && out.counts.accepted === 1, 'one proposal should be accepted');
  assert.ok(out.counts.filtered >= 3, 'stub/unknown/duplicate should be filtered');

  console.log('proposal_admission_hygiene.test.js: OK');
}

try { main(); } catch (err) { console.error(`proposal_admission_hygiene.test.js: FAIL: ${err.message}`); process.exit(1); }
