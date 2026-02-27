#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'repository_access_auditor.js');

function run(args, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-access-auditor-'));
  const artifactPath = path.join(tmp, 'latest.json');
  const historyPath = path.join(tmp, 'history.jsonl');
  const policyPath = path.join(tmp, 'policy.json');
  fs.writeFileSync(policyPath, JSON.stringify({
    enabled: true,
    repo: {
      owner: 'jakerslam',
      name: 'protheus',
      visibility_expected: 'private'
    },
    least_privilege: {
      default_role: 'read',
      max_admins: 2,
      restricted_admin_users: ['jay'],
      allowed_roles: ['read', 'triage', 'write', 'maintain', 'admin']
    },
    review: {
      interval_days: 90,
      next_review_due: '2026-05-27',
      artifact_path: artifactPath,
      history_path: historyPath
    }
  }, null, 2));

  const status = run(['status', '--strict=1', `--policy=${policyPath}`], {
    REPO_ACCESS_AUDITOR_SKIP_REMOTE: '1'
  });
  assert.strictEqual(status.status, 0, status.stderr || 'status strict should pass');
  const statusPayload = parseJson(status.stdout);
  assert.ok(statusPayload && statusPayload.ok === true, 'status payload should be ok');
  assert.ok(Array.isArray(statusPayload.checks), 'checks missing');
  assert.ok(statusPayload.checks.some((row) => row.id === 'policy:review_interval' && row.ok === true), 'review interval check missing');
  assert.ok(statusPayload.checks.some((row) => row.id === 'remote:availability' && row.ok === true), 'remote availability check missing');

  const review = run(['review-plan', '--apply=1', `--policy=${policyPath}`], {
    REPO_ACCESS_AUDITOR_SKIP_REMOTE: '1'
  });
  assert.strictEqual(review.status, 0, review.stderr || 'review-plan should pass');
  const reviewPayload = parseJson(review.stdout);
  assert.ok(reviewPayload && reviewPayload.ok === true && reviewPayload.applied === true, 'review-plan payload invalid');
  assert.ok(fs.existsSync(artifactPath), 'review artifact should exist');
  assert.ok(fs.existsSync(historyPath), 'review history should exist');

  const strictPolicyPath = path.join(tmp, 'policy_disabled.json');
  fs.writeFileSync(strictPolicyPath, JSON.stringify({
    enabled: false,
    review: {
      interval_days: 30,
      artifact_path: artifactPath,
      history_path: historyPath
    }
  }, null, 2));
  const strictFail = run(['status', '--strict=1', `--policy=${strictPolicyPath}`], {
    REPO_ACCESS_AUDITOR_SKIP_REMOTE: '1'
  });
  assert.notStrictEqual(strictFail.status, 0, 'strict status should fail when policy disabled');

  console.log('repository_access_auditor.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`repository_access_auditor.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
