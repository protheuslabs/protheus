#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(args, extraEnv = {}) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source',
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      ...extraEnv
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    payload: parseJson(out.stdout),
    errPayload: parseJson(out.stderr)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-assimilate-'));
  const sourcePath = path.join(tmp, 'source.md');
  fs.writeFileSync(
    sourcePath,
    [
      '# Candidate Requirements',
      '',
      'Requirements:',
      '- Add deterministic queue persistence using sqlite WAL mode.',
      '- Add a fail-closed sovereignty gate before apply.',
      '- Add one regression test for parse and one sovereignty test for gate behavior.',
      '4. Keep compatibility with existing CLI surface and wrappers.',
      '',
      'Acceptance Criteria:',
      '- Show full git diff and test output in proof bundle.'
    ].join('\n'),
    'utf8'
  );

  let out = run(['assimilate', sourcePath, '--dry-run=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.type === 'assimilate_result', 'should return assimilate_result payload');
  assert.strictEqual(out.payload.ok, true, 'assimilation should succeed for local file');
  assert.strictEqual(out.payload.dry_run, true, 'dry-run flag should be reflected');
  assert.ok(Array.isArray(out.payload.requirements) && out.payload.requirements.length >= 3, 'requirements should be extracted');
  assert.ok(typeof out.payload.sprint_prompt === 'string' && out.payload.sprint_prompt.includes('STRICT EXECUTION RULES ACTIVE'), 'should include codex sprint prompt');
  assert.ok(out.payload.core5_review && typeof out.payload.core5_review.ok === 'boolean', 'core5 review envelope should exist');
  assert.ok(out.payload.estimated_diff && out.payload.estimated_diff.files_touched_estimate >= 3, 'estimated diff should be computed');

  out = run(['assimilate', sourcePath, '--dry-run=1'], {
    PROTHEUS_ASSIMILATE_FORCE_COVENANT_VIOLATION: '1'
  });
  assert.notStrictEqual(out.status, 0, 'forced covenant violation should fail closed');
  assert.ok(out.stderr.includes('fail_closed'), 'stderr should include fail_closed marker');
  assert.ok(out.stderr.includes('covenant_violation_detected_for_assimilation'), 'stderr should include covenant violation reason');

  out = run(['assimilate', 'http://127.0.0.1:9999', '--dry-run=1']);
  assert.notStrictEqual(out.status, 0, 'blocked private host should fail closed');
  assert.ok(out.stderr.includes('blocked_domain:127.0.0.1'), 'private host should be blocked by policy');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('assimilate_cli.test.js: OK');
} catch (err) {
  console.error(`assimilate_cli.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
