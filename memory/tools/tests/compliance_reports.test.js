#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'compliance_reports.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeText(p, body) {
  mkDir(path.dirname(p));
  fs.writeFileSync(p, body, 'utf8');
}

function writeJson(p, obj) {
  writeText(p, JSON.stringify(obj, null, 2) + '\n');
}

function writeJsonl(p, rows) {
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  writeText(p, `${body}\n`);
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const out = String(r.stdout || '').trim();
  let payload = null;
  if (out) {
    try { payload = JSON.parse(out); } catch {}
  }
  if (!payload) {
    const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return { status: Number(r.status || 0), stdout: out, stderr: String(r.stderr || '').trim(), payload };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-reports-test-'));
  const policyPath = path.join(tmp, 'policy.json');
  const outDir = path.join(tmp, 'out');
  const historyPath = path.join(outDir, 'history.jsonl');

  const sourceLog = path.join(tmp, 'source', 'policy_root_decisions.jsonl');
  const sourceFile = path.join(tmp, 'source', 'runbook.md');
  writeJsonl(sourceLog, [{ ts: new Date().toISOString(), ok: true }]);
  writeText(sourceFile, '# runbook\n');

  writeJson(policyPath, {
    version: '1.0',
    strict_default: true,
    controls: [
      {
        id: 'CC6.1',
        title: 'Control A',
        owner: 'security',
        frequency: 'daily',
        evidence: [
          {
            type: 'jsonl_min_rows',
            path: path.relative(ROOT, sourceLog),
            min_rows: 1
          }
        ]
      },
      {
        id: 'CC7.2',
        title: 'Control B',
        owner: 'ops',
        frequency: 'weekly',
        evidence: [
          {
            type: 'file_exists',
            path: path.relative(ROOT, sourceFile)
          }
        ]
      }
    ]
  });

  const env = {
    COMPLIANCE_REPORT_POLICY_PATH: policyPath,
    COMPLIANCE_REPORT_OUT_DIR: outDir,
    COMPLIANCE_REPORT_HISTORY_PATH: historyPath
  };

  try {
    let r = run(['evidence-index', '--days=30'], env);
    assert.strictEqual(r.status, 0, `evidence-index should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.failed_rules === 0, 'evidence index should have no failed rules');

    r = run(['soc2-readiness', '--days=30', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `soc2-readiness should pass strict: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'readiness should pass');

    // break one control and confirm strict failure.
    fs.unlinkSync(sourceFile);
    r = run(['soc2-readiness', '--days=30', '--strict=1'], env);
    assert.notStrictEqual(r.status, 0, 'strict readiness should fail when evidence missing');
    assert.ok(r.payload && r.payload.ok === false, 'readiness payload should fail');

    r = run(['status'], env);
    assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
    assert.ok(r.payload && Number(r.payload.recent_soc2_runs || 0) >= 2, 'status should report soc2 runs');

    console.log('compliance_reports.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`compliance_reports.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
