#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'public_collaboration_surface_pack.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'public-collab-'));
  const policyPath = path.join(tmp, 'config', 'public_collaboration_surface_pack_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'public_collaboration_surface_pack', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'public_collaboration_surface_pack', 'history.jsonl');

  writeText(path.join(tmp, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'), 'labels: ["type:bug", "state:needs-repro", "priority:p2"]');
  writeText(path.join(tmp, '.github', 'ISSUE_TEMPLATE', 'feature_request.md'), 'labels: ["type:feature", "state:needs-design", "priority:p2"]');
  writeText(path.join(tmp, '.github', 'ISSUE_TEMPLATE', 'security_report.md'), 'labels: ["type:security", "priority:p0"]');
  writeText(path.join(tmp, '.github', 'ISSUE_TEMPLATE', 'config.yml'), 'blank_issues_enabled: false');
  writeText(path.join(tmp, 'docs', 'PUBLIC_COLLABORATION_TRIAGE.md'), [
    'type:bug',
    'type:feature',
    'type:security',
    'state:needs-repro',
    'state:needs-design',
    'priority:p0',
    'priority:p1',
    'priority:p2',
    '2 business days',
    '5 business days',
    '10 business days'
  ].join('\n'));
  writeText(path.join(tmp, 'docs', 'PUBLIC_COLLABORATION_SURFACE.md'), 'collaboration surface');
  writeText(path.join(tmp, 'CONTRIBUTING.md'), [
    '.github/ISSUE_TEMPLATE/bug_report.md',
    '.github/ISSUE_TEMPLATE/feature_request.md',
    '.github/ISSUE_TEMPLATE/security_report.md',
    'client/docs/PUBLIC_COLLABORATION_TRIAGE.md',
    'client/docs/CLAIM_EVIDENCE_POLICY.md',
    'client/docs/DOCUMENTATION_PROGRAM_GOVERNANCE.md'
  ].join('\n'));

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_files: [
      '.github/ISSUE_TEMPLATE/bug_report.md',
      '.github/ISSUE_TEMPLATE/feature_request.md',
      '.github/ISSUE_TEMPLATE/security_report.md',
      '.github/ISSUE_TEMPLATE/config.yml',
      'client/docs/PUBLIC_COLLABORATION_TRIAGE.md',
      'client/docs/PUBLIC_COLLABORATION_SURFACE.md'
    ],
    triage_doc: path.join(tmp, 'docs', 'PUBLIC_COLLABORATION_TRIAGE.md'),
    contributing_doc: path.join(tmp, 'CONTRIBUTING.md'),
    required_labels: [
      'type:bug',
      'type:feature',
      'type:security',
      'state:needs-repro',
      'state:needs-design',
      'priority:p0',
      'priority:p1',
      'priority:p2'
    ],
    required_sla_terms: [
      '2 business days',
      '5 business days',
      '10 business days'
    ],
    required_template_links: [
      '.github/ISSUE_TEMPLATE/bug_report.md',
      '.github/ISSUE_TEMPLATE/feature_request.md',
      '.github/ISSUE_TEMPLATE/security_report.md'
    ],
    required_governance_links: [
      'client/docs/PUBLIC_COLLABORATION_TRIAGE.md',
      'client/docs/CLAIM_EVIDENCE_POLICY.md',
      'client/docs/DOCUMENTATION_PROGRAM_GOVERNANCE.md'
    ],
    paths: {
      latest_path: latestPath,
      history_path: historyPath
    }
  });

  const out = run(['verify', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('public_collaboration_surface_pack.test.js: OK');
} catch (err) {
  console.error(`public_collaboration_surface_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
