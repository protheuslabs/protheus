#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'requirement_conformance_gate.js');

function writeText(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeJson(filePath, value) {
  writeText(filePath, `${JSON.stringify(value, null, 2)}\n`);
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

function run(args) {
  const proc = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? proc.status : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || ''),
    payload: parseJson(proc.stdout)
  };
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'req-conf-gate-'));
  const backlogPath = path.join(tmp, 'UPGRADE_BACKLOG.md');
  const matrixPath = path.join(tmp, 'matrix.json');
  const policyPath = path.join(tmp, 'policy.json');
  const outputsDir = path.join(tmp, 'state');

  writeText(backlogPath, [
    '# Test Backlog',
    '',
    '| ID | Class | Version | Status | Upgrade | Why | Exit Criteria | Depends On |',
    '|---|---|---|---|---|---|---|---|',
    '| V3-RACE-900 | hardening | V3 | done | Foo | Why | Exit | V3-RACE-001 |',
    '| V3-RACE-901 | extension | V3 | done | Bar | Why | Exit | V3-RACE-002 |',
    ''
  ].join('\n'));

  const anchorA = path.join(tmp, 'systems', 'foo.ts');
  const anchorB = path.join(tmp, 'systems', 'bar.ts');
  const evidenceA = path.join(tmp, 'tests', 'foo.test.js');
  const evidenceB = path.join(tmp, 'tests', 'bar.test.js');
  writeText(anchorA, 'export {};\n');
  writeText(anchorB, 'export {};\n');
  writeText(evidenceA, 'console.log("ok");\n');
  writeText(evidenceB, 'console.log("ok");\n');

  writeJson(matrixPath, {
    schema_id: 'requirement_conformance_matrix',
    schema_version: '1.0',
    requirements: [
      {
        external_requirement_id: 'ext_a',
        canonical_backlog_id: 'V3-RACE-900',
        file_anchors: [anchorA],
        evidence_tests: [evidenceA]
      },
      {
        external_requirement_id: 'ext_b',
        canonical_backlog_id: 'V3-RACE-901',
        file_anchors: [anchorB],
        evidence_tests: [evidenceB]
      }
    ]
  });

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    backlog_path: backlogPath,
    matrix_path: matrixPath,
    required_external_ids: ['ext_a', 'ext_b'],
    outputs: {
      latest_path: path.join(outputsDir, 'latest.json'),
      history_path: path.join(outputsDir, 'history.jsonl')
    }
  });

  let out = run(['run', `--policy=${policyPath}`, '--strict=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.ok === true, 'gate should pass with complete matrix');
  assert.strictEqual(out.payload.failed_requirements, 0);
  assert.strictEqual(out.payload.unmapped_required_external_ids.length, 0);

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    strict_default: true,
    backlog_path: backlogPath,
    matrix_path: matrixPath,
    required_external_ids: ['ext_a', 'ext_b', 'ext_missing'],
    outputs: {
      latest_path: path.join(outputsDir, 'latest.json'),
      history_path: path.join(outputsDir, 'history.jsonl')
    }
  });

  out = run(['run', `--policy=${policyPath}`, '--strict=1']);
  assert.notStrictEqual(out.status, 0, 'strict mode should fail on unmapped required ids');
  assert.ok(out.payload && out.payload.ok === false);
  assert.ok(out.payload.unmapped_required_external_ids.includes('ext_missing'));

  out = run(['status', `--policy=${policyPath}`]);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.payload && out.payload.latest, 'status should include latest payload');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('requirement_conformance_gate.test.js: OK');
} catch (err) {
  console.error(`requirement_conformance_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
