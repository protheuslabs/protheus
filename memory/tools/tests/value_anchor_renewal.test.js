#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
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

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'echo', 'value_anchor_renewal.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'value-anchor-renewal-'));
  const policyPath = path.join(tmp, 'config', 'value_anchor_renewal_policy.json');

  write(path.join(tmp, 'AGENT-CONSTITUTION.md'), '# Constitution\nPreserve user sovereignty and safety first.\n');
  appendJsonl(path.join(tmp, 'state', 'autonomy', 'inversion', 'first_principles.jsonl'), [
    { principle: 'protect user sovereignty under all conditions' },
    { principle: 'prefer reversible safe actions over irreversible actions' }
  ]);

  // Intentionally divergent current anchor to force explicit-review path.
  writeJson(path.join(tmp, 'state', 'autonomy', 'echo', 'value_anchor', 'current.json'), {
    anchor_id: 'anchor_old',
    derived_at: '2026-01-01T00:00:00.000Z',
    weights: [
      { token: 'maximize', weight: 0.5 },
      { token: 'throughput', weight: 0.5 }
    ]
  });

  writeJson(policyPath, {
    schema_id: 'value_anchor_renewal_policy',
    schema_version: '1.0',
    enabled: true,
    renewal_interval_days: 14,
    max_auto_shift: 0.05,
    high_impact_shift: 0.1,
    require_user_review_above_shift: true,
    constitution_path: path.join(tmp, 'AGENT-CONSTITUTION.md'),
    first_principles_path: path.join(tmp, 'state', 'autonomy', 'inversion', 'first_principles.jsonl'),
    current_anchor_path: path.join(tmp, 'state', 'autonomy', 'echo', 'value_anchor', 'current.json'),
    proposals_path: path.join(tmp, 'state', 'autonomy', 'echo', 'value_anchor', 'proposals.jsonl'),
    history_path: path.join(tmp, 'state', 'autonomy', 'echo', 'value_anchor', 'history.jsonl'),
    receipts_path: path.join(tmp, 'state', 'autonomy', 'echo', 'value_anchor', 'receipts.jsonl')
  });

  const env = {
    ...process.env,
    VALUE_ANCHOR_ROOT: tmp,
    VALUE_ANCHOR_POLICY_PATH: policyPath
  };

  const proposal = run(script, repoRoot, ['run', '--apply=0', `--policy=${policyPath}`], env);
  assert.strictEqual(proposal.status, 0, proposal.stderr || 'proposal run should pass');
  assert.ok(proposal.payload && proposal.payload.ok === true, 'proposal payload should be ok');
  assert.ok(Number(proposal.payload.drift_score || 0) >= 0, 'proposal should include drift score');

  const applyWithoutApproval = run(script, repoRoot, ['run', '--apply=1', `--policy=${policyPath}`], env);
  assert.notStrictEqual(applyWithoutApproval.status, 0, 'apply should fail when explicit review is required');
  assert.strictEqual(String(applyWithoutApproval.payload.reason || ''), 'explicit_review_required', 'expected explicit review gate');

  const applyWithApproval = run(script, repoRoot, [
    'run',
    '--apply=1',
    '--approved-by=operator',
    '--approval-note=reviewed_and_approved',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(applyWithApproval.status, 0, applyWithApproval.stderr || 'apply with approval should pass');
  assert.ok(applyWithApproval.payload && applyWithApproval.payload.ok === true, 'apply payload should be ok');

  const currentAnchor = JSON.parse(fs.readFileSync(path.join(tmp, 'state', 'autonomy', 'echo', 'value_anchor', 'current.json'), 'utf8'));
  assert.notStrictEqual(String(currentAnchor.anchor_id || ''), 'anchor_old', 'current anchor should be replaced');
  assert.ok(currentAnchor.previous_anchor && currentAnchor.previous_anchor.anchor_id === 'anchor_old', 'previous anchor snapshot should be retained for rollback');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.ok(Number(status.payload.proposal_count || 0) >= 1, 'status should include proposal history');

  console.log('value_anchor_renewal.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`value_anchor_renewal.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
