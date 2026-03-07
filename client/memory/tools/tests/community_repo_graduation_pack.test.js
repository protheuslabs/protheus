#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'migration', 'community_repo_graduation_pack.js');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, String(value), 'utf8');
}

function run(workspaceRoot, args) {
  const res = spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE: workspaceRoot
    }
  });
  let payload = null;
  try { payload = JSON.parse(String(res.stdout || '').trim()); } catch {}
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    payload,
    stderr: String(res.stderr || '')
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'community-grad-pack-'));
  const workspaceRoot = path.join(tmp, 'workspace');
  const policyPath = path.join(tmp, 'config', 'community_repo_graduation_pack_policy.json');

  writeText(path.join(workspaceRoot, 'README.md'), '# Legacy Repo\n\nOld content.\n');

  const policy = {
    enabled: true,
    strict_default: false,
    defaults: {
      migration_guide_url: 'client/docs/CORE_MIGRATION_BRIDGE.md'
    },
    files: {
      legacy_readme_path: path.join(workspaceRoot, 'README.md'),
      banner_path: path.join(workspaceRoot, 'docs', 'migration', 'community_repo_banner.md'),
      pinned_issue_path: path.join(workspaceRoot, 'docs', 'migration', 'pinned_migration_issue.md'),
      redirect_metadata_path: path.join(workspaceRoot, 'docs', 'migration', 'repo_redirect.json'),
      latest_path: path.join(tmp, 'state', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'receipts.jsonl')
    }
  };
  writeJson(policyPath, policy);

  let res = run(workspaceRoot, [
    'run',
    '--legacy-repo=https://github.com/old/repo',
    '--target-repo=https://github.com/new/repo',
    '--apply=1',
    '--strict=1',
    `--policy=${policyPath}`
  ]);
  assert.strictEqual(res.status, 0, `run should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.ok === true, 'payload should be ok');
  assert.strictEqual(res.payload.type, 'community_repo_graduation_pack_run');

  const readmeText = fs.readFileSync(path.join(workspaceRoot, 'README.md'), 'utf8');
  assert.ok(readmeText.includes('MIGRATION_BANNER_START'), 'readme should include migration banner marker');
  assert.ok(readmeText.includes('https://github.com/new/repo'), 'readme should include one-click destination');

  const redirect = JSON.parse(fs.readFileSync(path.join(workspaceRoot, 'docs', 'migration', 'repo_redirect.json'), 'utf8'));
  assert.strictEqual(redirect.one_click_upgrade_url, 'https://github.com/new/repo');

  res = run(workspaceRoot, ['status', `--policy=${policyPath}`]);
  assert.strictEqual(res.status, 0, `status should pass: ${res.stderr}`);
  assert.ok(res.payload && res.payload.type === 'community_repo_graduation_pack_status');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('community_repo_graduation_pack.test.js: OK');
} catch (err) {
  console.error(`community_repo_graduation_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
