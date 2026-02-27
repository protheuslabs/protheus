#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeFile(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function runNode(scriptPath, args, cwd, env) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env: { ...process.env, ...env },
    encoding: 'utf8'
  });
}

function parseJson(proc) {
  const raw = String(proc.stdout || '').trim();
  if (!raw) return null;
  return JSON.parse(raw.split('\n').filter(Boolean).slice(-1)[0]);
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'ops', 'js_holdout_audit.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'js-audit-'));

  writeFile(path.join(tmp, 'systems', 'paired.js'), "console.log('paired');\n");
  writeFile(path.join(tmp, 'systems', 'paired.ts'), "export {};\n");
  writeFile(path.join(tmp, 'systems', 'holdout.js'), "console.log('holdout');\n");
  writeFile(path.join(tmp, 'habits', 'scripts', 'probe.js'), "console.log('probe');\n");

  const registryPath = path.join(tmp, 'config', 'js_exception_registry.json');
  writeJson(registryPath, {
    version: '1.0-test',
    strict_roots: ['systems'],
    advisory_roots: ['habits/scripts'],
    exceptions: [
      {
        path: 'systems/holdout.js',
        owner: 'unit',
        reason: 'test',
        benchmark_evidence: 'test',
        expires_at: '2099-01-01T00:00:00.000Z'
      }
    ]
  });

  const env = { JS_HOLDOUT_ROOT: tmp };
  const strictRun = runNode(script, ['run', `--registry=${registryPath}`, '--strict=1'], tmp, env);
  assert.strictEqual(strictRun.status, 0, strictRun.stderr || strictRun.stdout);
  const strictPayload = parseJson(strictRun);
  assert.ok(strictPayload && strictPayload.ok === true, 'strict run should pass with approved exception');
  assert.ok(Number(strictPayload.strict_total || 0) >= 2, 'strict total should include scanned JS files');
  assert.ok(
    Array.isArray(strictPayload.advisory_violations)
      && strictPayload.advisory_violations.some((row) => String(row.path || '').endsWith('habits/scripts/probe.js')),
    'advisory violation should include habits/scripts probe.js'
  );

  // Remove exception to force strict failure.
  writeJson(registryPath, {
    version: '1.0-test',
    strict_roots: ['systems'],
    advisory_roots: ['habits/scripts'],
    exceptions: []
  });
  const strictFail = runNode(script, ['run', `--registry=${registryPath}`, '--strict=1'], tmp, env);
  assert.strictEqual(strictFail.status, 1, 'strict run should fail when unpaired JS is unapproved');
  const failPayload = parseJson(strictFail);
  assert.ok(failPayload && failPayload.ok === false, 'strict failure payload should set ok=false');
  assert.ok(
    Array.isArray(failPayload.strict_violations)
      && failPayload.strict_violations.some((row) => String(row.path || '').endsWith('systems/holdout.js')),
    'strict violations should include unapproved holdout.js'
  );

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('js_holdout_audit.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`js_holdout_audit.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
