#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'docs_coverage_gate.js');

function mkDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeText(filePath, body) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, body, 'utf8');
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const out = String(r.stdout || '').trim();
  const lines = out.split('\n').map((x) => x.trim()).filter(Boolean);
  let payload = null;
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      payload = JSON.parse(lines[i]);
      break;
    } catch {}
  }
  return { status: Number(r.status || 0), stdout: out, stderr: String(r.stderr || '').trim(), payload };
}

function runTest() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docs-coverage-gate-test-'));
  const docsRel = path.join('docs', `__tmp_docs_coverage_gate_${path.basename(tmp)}`);
  const docsRoot = path.join(ROOT, docsRel);
  const mapPath = path.join(tmp, 'docs_map.json');
  const reqDoc = path.join(docsRoot, 'REQ.md');
  const otherDoc = path.join(docsRoot, 'OTHER.md');
  const reqDocRel = path.join(docsRel, 'REQ.md').replace(/\\/g, '/');

  writeText(reqDoc, '# req\nSee [other](./OTHER.md)\n');
  writeText(otherDoc, '# other\n');
  writeText(mapPath, JSON.stringify({
    version: '1.0',
    require_docs_touched: true,
    critical_paths: [
      {
        path_prefix: 'systems/ops/',
        required_docs: [reqDocRel]
      }
    ]
  }, null, 2));

  const env = {
    DOCS_COVERAGE_MAP_PATH: mapPath,
    DOCS_COVERAGE_DOCS_ROOT: docsRoot
  };

  try {
    let r = run(['run', '--strict=1', '--files=systems/ops/new_file.ts'], env);
    assert.notStrictEqual(r.status, 0, 'require_docs_touched should fail when docs not in diff');
    assert.ok(r.payload && r.payload.ok === false, 'payload should fail');
    assert.ok(
      Array.isArray(r.payload.reasons) && r.payload.reasons.includes('required_docs_not_touched'),
      'expected required docs touched failure reason'
    );

    r = run(['run', '--strict=1', `--files=systems/ops/new_file.ts,${reqDocRel}`], env);
    assert.strictEqual(r.status, 0, `should pass when required doc touched: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'payload should pass');

    writeText(reqDoc, '# req\nBad [missing](./MISSING.md)\n');
    r = run(['run', '--strict=1', `--files=systems/ops/new_file.ts,${reqDocRel}`], env);
    assert.notStrictEqual(r.status, 0, 'broken local links should fail gate');
    assert.ok(r.payload && r.payload.ok === false, 'broken-link payload should fail');
    assert.ok(Array.isArray(r.payload.broken_links) && r.payload.broken_links.length > 0, 'broken links expected');

    console.log('docs_coverage_gate.test.js: OK');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(docsRoot, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`docs_coverage_gate.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
