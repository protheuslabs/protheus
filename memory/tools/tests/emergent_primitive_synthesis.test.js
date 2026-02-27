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

function run(script, root, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
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
  const script = path.join(repoRoot, 'systems', 'primitives', 'emergent_primitive_synthesis.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'emergent-synthesis-'));
  const policyPath = path.join(tmp, 'config', 'emergent_primitive_synthesis_policy.json');

  writeJson(policyPath, {
    schema_id: 'emergent_primitive_synthesis_policy',
    schema_version: '1.0',
    enabled: true,
    max_open_candidates: 8,
    require_nursery_pass: true,
    require_adversarial_pass: true,
    require_invariant_pass: true,
    require_human_approval: true,
    allow_auto_promotion: false,
    min_lesson_length: 8,
    allowed_sources: ['forge', 'inversion', 'research'],
    candidates_path: path.join(tmp, 'state', 'primitives', 'synthesis', 'candidates.json'),
    archive_path: path.join(tmp, 'state', 'primitives', 'synthesis', 'archive.jsonl'),
    promotions_path: path.join(tmp, 'state', 'primitives', 'synthesis', 'promotions.jsonl'),
    receipts_path: path.join(tmp, 'state', 'primitives', 'synthesis', 'receipts.jsonl'),
    invariant_check_command: ['node', 'systems/security/formal_invariant_engine.js', 'run', '--strict=1']
  });

  const envPass = {
    ...process.env,
    EMERGENT_SYNTHESIS_ROOT: tmp,
    EMERGENT_SYNTHESIS_POLICY_PATH: policyPath,
    EMERGENT_SYNTHESIS_MOCK_INVARIANT: 'pass'
  };

  const propose = run(script, repoRoot, [
    'propose',
    '--name=adaptive_reduce',
    '--intent=bounded primitive for safe compression',
    '--source=forge',
    '--objective-id=obj_123',
    `--policy=${policyPath}`
  ], envPass);
  assert.strictEqual(propose.status, 0, propose.stderr || 'propose should pass');
  assert.ok(propose.payload && propose.payload.ok === true, 'propose payload should be ok');
  const candidateId = String(propose.payload.candidate.candidate_id || '');
  assert.ok(candidateId.startsWith('synth_'), 'candidate id should be generated');

  const evaluatePass = run(script, repoRoot, [
    'evaluate',
    `--candidate-id=${candidateId}`,
    '--nursery-pass=1',
    '--adversarial-pass=1',
    `--policy=${policyPath}`
  ], envPass);
  assert.strictEqual(evaluatePass.status, 0, evaluatePass.stderr || 'evaluate should pass when all checks pass');
  assert.strictEqual(String(evaluatePass.payload.status || ''), 'awaiting_human_gate', 'candidate should await human gate');

  const approve = run(script, repoRoot, [
    'approve',
    `--candidate-id=${candidateId}`,
    '--approved-by=operator',
    '--approval-note=reviewed_and_approved',
    `--policy=${policyPath}`
  ], envPass);
  assert.strictEqual(approve.status, 0, approve.stderr || 'approve should pass');

  const promote = run(script, repoRoot, [
    'promote',
    `--candidate-id=${candidateId}`,
    '--apply=0',
    `--policy=${policyPath}`
  ], envPass);
  assert.strictEqual(promote.status, 0, promote.stderr || 'promote should pass');
  assert.strictEqual(String(promote.payload.status || ''), 'promotion_proposed', 'promotion should remain proposed without auto apply');

  const envFail = {
    ...envPass,
    EMERGENT_SYNTHESIS_MOCK_INVARIANT: 'fail'
  };
  const proposeFail = run(script, repoRoot, [
    'propose',
    '--name=unsafe_jump',
    '--intent=unsafe primitive candidate for rejection test',
    '--source=inversion',
    `--policy=${policyPath}`
  ], envFail);
  assert.strictEqual(proposeFail.status, 0, proposeFail.stderr || 'second propose should pass');
  const failId = String(proposeFail.payload.candidate.candidate_id || '');

  const evaluateFail = run(script, repoRoot, [
    'evaluate',
    `--candidate-id=${failId}`,
    '--nursery-pass=0',
    '--adversarial-pass=0',
    `--policy=${policyPath}`
  ], envFail);
  assert.notStrictEqual(evaluateFail.status, 0, 'evaluate should fail when checks fail');
  assert.strictEqual(String(evaluateFail.payload.status || ''), 'rejected', 'failed candidate should be rejected');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], envPass);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.ok(Number(status.payload.candidate_count || 0) >= 2, 'status should include candidates');

  const archivePath = path.join(tmp, 'state', 'primitives', 'synthesis', 'archive.jsonl');
  const archiveRows = fs.existsSync(archivePath)
    ? fs.readFileSync(archivePath, 'utf8').split('\n').filter(Boolean)
    : [];
  assert.ok(archiveRows.length >= 1, 'rejected candidate should be archived with lessons');

  console.log('emergent_primitive_synthesis.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`emergent_primitive_synthesis.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
