#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'compatibility_tail_retirement.js');

let failed = false;

function runTest(name, fn) {
  try {
    fn();
    console.log(`   ✅ ${name}`);
  } catch (err) {
    failed = true;
    console.error(`   ❌ ${name}: ${err && err.message ? err.message : err}`);
  }
}

function mkDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function runCmd(policyPath, args = []) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      COMPATIBILITY_TAIL_RETIREMENT_POLICY_PATH: policyPath
    }
  });
}

function parseJson(stdout) {
  try { return JSON.parse(String(stdout || '').trim()); } catch { return null; }
}

console.log('═══════════════════════════════════════════════════════════');
console.log('   COMPATIBILITY TAIL RETIREMENT TESTS');
console.log('═══════════════════════════════════════════════════════════');

runTest('strict mode fails on non-wrapper js/ts pair', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-tail-'));
  const systemsDir = path.join(tempRoot, 'systems');
  mkDir(systemsDir);
  fs.writeFileSync(path.join(systemsDir, 'good.ts'), 'export {};\n', 'utf8');
  fs.writeFileSync(path.join(systemsDir, 'good.js'), "#!/usr/bin/env node\n'use strict';\nrequire('../../lib/ts_bootstrap').bootstrap(__filename, module);\n", 'utf8');
  fs.writeFileSync(path.join(systemsDir, 'bad.ts'), 'export {};\n', 'utf8');
  fs.writeFileSync(path.join(systemsDir, 'bad.js'), "console.log('legacy js body');\n", 'utf8');

  const policyPath = path.join(tempRoot, 'config', 'compatibility_tail_retirement_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    strict_default: true,
    scan_roots: [systemsDir],
    approved_non_wrapper_js: [],
    wrapper_patterns: ["ts_bootstrap').bootstrap(__filename, module);"],
    paths: {
      latest_path: path.join(tempRoot, 'state', 'latest.json'),
      receipts_path: path.join(tempRoot, 'state', 'receipts.jsonl')
    }
  });

  const run = runCmd(policyPath, ['run', '--strict=1']);
  assert.strictEqual(run.status, 2, `expected strict failure: ${run.stderr}`);
  const out = parseJson(run.stdout);
  assert.ok(out && out.ok === false, 'expected ok=false');
  assert.strictEqual(Number(out.violating_pairs), 1);
});

runTest('allowlist makes strict mode pass', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-tail-'));
  const systemsDir = path.join(tempRoot, 'systems');
  mkDir(systemsDir);
  fs.writeFileSync(path.join(systemsDir, 'good.ts'), 'export {};\n', 'utf8');
  fs.writeFileSync(path.join(systemsDir, 'good.js'), "#!/usr/bin/env node\n'use strict';\nrequire('../../lib/ts_bootstrap').bootstrap(__filename, module);\n", 'utf8');
  fs.writeFileSync(path.join(systemsDir, 'legacy.ts'), 'export {};\n', 'utf8');
  fs.writeFileSync(path.join(systemsDir, 'legacy.js'), "console.log('allowlisted');\n", 'utf8');

  const policyPath = path.join(tempRoot, 'config', 'compatibility_tail_retirement_policy.json');
  writeJson(policyPath, {
    version: '1.0',
    enabled: true,
    strict_default: true,
    scan_roots: [systemsDir],
    approved_non_wrapper_js: ['systems/legacy.js'],
    wrapper_patterns: ["ts_bootstrap').bootstrap(__filename, module);"],
    paths: {
      latest_path: path.join(tempRoot, 'state', 'latest.json'),
      receipts_path: path.join(tempRoot, 'state', 'receipts.jsonl')
    }
  });

  const run = runCmd(policyPath, ['run', '--strict=1']);
  assert.strictEqual(run.status, 0, `expected strict pass: ${run.stderr}`);
  const out = parseJson(run.stdout);
  assert.ok(out && out.ok === true, 'expected ok=true');
  assert.strictEqual(Number(out.allowlisted_pairs), 1);
  assert.strictEqual(Number(out.wrapper_pairs), 1);
});

if (failed) process.exit(1);
console.log('✅ compatibility_tail_retirement tests passed');
