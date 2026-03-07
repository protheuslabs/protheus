#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'empty_fort_integrity_guard.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
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

function run(args, env = {}) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fort-integrity-'));
  const policyPath = path.join(tmp, 'config', 'empty_fort_integrity_guard_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'empty_fort_integrity_guard', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'empty_fort_integrity_guard', 'history.jsonl');

  writeText(path.join(tmp, 'docs', 'CLAIM_EVIDENCE_POLICY.md'), [
    'measurable',
    'security-sensitive',
    'required evidence',
    'prohibited patterns',
    'review gate'
  ].join('\n'));
  writeText(path.join(tmp, 'docs', 'EMPTY_FORT_INTEGRITY_CHECKLIST.md'), [
    'claim class',
    'evidence link',
    'owner',
    'verification date',
    'status'
  ].join('\n'));
  writeText(path.join(tmp, 'docs', 'PUBLIC_COLLABORATION_TRIAGE.md'), 'triage');
  writeText(path.join(tmp, 'docs', 'RELEASE_DISCIPLINE_POLICY.md'), 'release');
  writeText(path.join(tmp, 'README.md'), 'Public claims include evidence links only.');
  writeText(path.join(tmp, 'docs', 'README.md'), 'Docs hub with receipts and evidence.');
  writeText(path.join(tmp, 'docs', 'PUBLIC_OPERATOR_PROFILE.md'), 'Profile summary.');
  writeText(path.join(tmp, 'docs', 'release', 'templates', 'release_plan.md'), 'Claim-Evidence Matrix\nEvidence link: client/docs/benchmarks.md');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_docs: [
      'client/docs/CLAIM_EVIDENCE_POLICY.md',
      'client/docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md',
      'client/docs/PUBLIC_COLLABORATION_TRIAGE.md',
      'client/docs/RELEASE_DISCIPLINE_POLICY.md'
    ],
    release_surfaces: [
      'README.md',
      'client/docs/README.md',
      'client/docs/PUBLIC_OPERATOR_PROFILE.md',
      'client/docs/release/templates/release_plan.md'
    ],
    claim_terms: ['proven at scale', 'fully autonomous', '99.9%'],
    evidence_terms: ['evidence', 'receipt', 'client/docs/'],
    required_policy_terms: ['measurable', 'security-sensitive', 'required evidence', 'prohibited patterns', 'review gate'],
    required_checklist_terms: ['claim class', 'evidence link', 'owner', 'verification date', 'status'],
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const out = run(['verify', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass');
  assert.ok(Array.isArray(out.payload.claim_evidence_findings) && out.payload.claim_evidence_findings.length === 0, 'should have no unsupported claim findings');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('empty_fort_integrity_guard.test.js: OK');
} catch (err) {
  console.error(`empty_fort_integrity_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
