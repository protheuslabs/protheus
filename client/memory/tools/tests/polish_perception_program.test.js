#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'polish_perception_program.js');

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
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'polish-perception-'));
  const policyPath = path.join(tmp, 'config', 'polish_perception_program_policy.json');
  const latestPath = path.join(tmp, 'state', 'ops', 'polish_perception_program', 'latest.json');
  const historyPath = path.join(tmp, 'state', 'ops', 'polish_perception_program', 'history.jsonl');
  const auditLatestPath = path.join(tmp, 'state', 'ops', 'polish_perception_program', 'audit_latest.json');
  const auditHistoryPath = path.join(tmp, 'state', 'ops', 'polish_perception_program', 'audit_history.jsonl');

  writeText(path.join(tmp, 'README.md'), 'See client/docs/ORG_CODE_FORMAT_STANDARD.md for style.');
  writeText(path.join(tmp, 'docs', 'README.md'), 'See ORG_CODE_FORMAT_STANDARD.md for docs style.');
  writeText(path.join(tmp, 'CONTRIBUTING.md'), 'Use client/docs/ORG_CODE_FORMAT_STANDARD.md before PR.');
  writeText(path.join(tmp, 'docs', 'ORG_CODE_FORMAT_STANDARD.md'), 'style guide');
  writeText(path.join(tmp, 'docs', 'PERCEPTION_AUDIT_PROGRAM.md'), 'monthly audit');
  writeText(path.join(tmp, 'docs', 'EMPTY_FORT_INTEGRITY_CHECKLIST.md'), 'checklist');

  writeText(path.join(tmp, '.github', 'workflows', 'ci.yml'), [
    'name: CI',
    'steps:',
    '- run: npm run ops:format:check',
    '- run: npm run lint'
  ].join('\n'));
  writeText(path.join(tmp, '.githooks', 'pre-commit'), [
    '#!/usr/bin/env bash',
    'npm run ops:format:check',
    'npm run lint'
  ].join('\n'));
  writeText(path.join(tmp, '.github', 'pull_request_template.md'), '## Summary\n## Roadmap\n## Validation\n## Risk');
  writeText(path.join(tmp, '.github', 'ISSUE_TEMPLATE', 'bug_report.md'), '## Summary\n## Reproduction Steps\n## Impact');
  writeText(path.join(tmp, '.github', 'ISSUE_TEMPLATE', 'feature_request.md'), '## Problem Statement\n## Acceptance Criteria\n## Risks and Tradeoffs');
  writeText(path.join(tmp, 'docs', 'release', 'templates', 'release_plan.md'), '# Release Plan\n- Scope\n- Risk\n- Rollback\n- Claim-Evidence Matrix');

  writeJson(path.join(tmp, 'package.json'), {
    scripts: {
      lint: 'echo lint',
      'ops:format:check': 'echo format'
    }
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    required_docs: [
      'client/docs/ORG_CODE_FORMAT_STANDARD.md',
      'client/docs/PERCEPTION_AUDIT_PROGRAM.md',
      'client/docs/EMPTY_FORT_INTEGRITY_CHECKLIST.md'
    ],
    package_json_path: path.join(tmp, 'package.json'),
    required_package_scripts: ['ops:format:check', 'lint'],
    ci_workflow_path: path.join(tmp, '.github', 'workflows', 'ci.yml'),
    ci_required_commands: ['npm run ops:format:check', 'npm run lint'],
    pre_commit_path: path.join(tmp, '.githooks', 'pre-commit'),
    pre_commit_required_commands: ['npm run ops:format:check', 'npm run lint'],
    templates: {
      '.github/pull_request_template.md': ['summary', 'roadmap', 'validation', 'risk'],
      '.github/ISSUE_TEMPLATE/bug_report.md': ['summary', 'reproduction steps', 'impact'],
      '.github/ISSUE_TEMPLATE/feature_request.md': ['problem statement', 'acceptance criteria', 'risks and tradeoffs'],
      'client/docs/release/templates/release_plan.md': ['scope', 'risk', 'rollback', 'claim-evidence matrix']
    },
    audit: {
      max_age_days: 31,
      min_score: 0.8
    },
    paths: {
      latest_path: latestPath,
      history_path: historyPath,
      audit_latest_path: auditLatestPath,
      audit_history_path: auditHistoryPath
    }
  });

  let out = run(['audit', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && Number(out.payload.score) >= 0.8, 'audit score should meet threshold');

  out = run(['verify', '--strict=1', `--policy=${policyPath}`], { OPENCLAW_WORKSPACE: tmp });
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.strictEqual(out.payload.ok, true, 'verify should pass');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('polish_perception_program.test.js: OK');
} catch (err) {
  console.error(`polish_perception_program.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
