#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(REPO_ROOT, 'systems', 'security', 'llm_gateway_guard.js');

function writeFile(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function runGuard(tempRoot) {
  const r = spawnSync(process.execPath, [SCRIPT, 'run', '--strict'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      LLM_GATEWAY_GUARD_ROOT: tempRoot
    }
  });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '{}')); } catch {}
  return {
    code: r.status == null ? 1 : r.status,
    payload
  };
}

function main() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-gateway-guard-'));
  try {
    writeFile(
      path.join(tempRoot, 'systems', 'routing', 'llm_gateway.js'),
      "const { spawnSync } = require('child_process');\nspawnSync('ollama', ['run', 'smallthinker', 'Return exactly: OK']);\n"
    );
    writeFile(
      path.join(tempRoot, 'systems', 'memory', 'bad_direct_llm.js'),
      "const { spawnSync } = require('child_process');\nspawnSync('ollama', ['run', 'qwen3:4b', 'hello']);\n"
    );

    const first = runGuard(tempRoot);
    assert.strictEqual(first.code, 1, 'guard should fail on direct non-gateway ollama spawn');
    assert.ok(first.payload && first.payload.ok === false, 'payload should report failure');
    assert.strictEqual(Number(first.payload.violation_count || 0), 1, 'should report exactly one violation');
    assert.strictEqual(String(first.payload.violations[0].file), 'systems/memory/bad_direct_llm.js');
    assert.strictEqual(String(first.payload.violations[0].type), 'direct_ollama_spawn');

    fs.rmSync(path.join(tempRoot, 'systems', 'memory', 'bad_direct_llm.js'), { force: true });
    const second = runGuard(tempRoot);
    assert.strictEqual(second.code, 0, 'guard should pass when only gateway spawn remains');
    assert.ok(second.payload && second.payload.ok === true, 'payload should report success');
    assert.strictEqual(Number(second.payload.violation_count || 0), 0, 'should report zero violations');

    console.log('✅ llm_gateway_guard.test.js PASS');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (err) {
  console.error(`❌ llm_gateway_guard.test.js failed: ${err.message}`);
  process.exit(1);
}

