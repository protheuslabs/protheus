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
  const script = path.join(repoRoot, 'systems', 'ops', 'self_hosted_bootstrap_compiler.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'self-host-bootstrap-'));
  const policyPath = path.join(tmp, 'config', 'self_hosted_bootstrap_policy.json');
  const okScript = path.join(tmp, 'scripts', 'ok_cmd.js');

  write(okScript, "#!/usr/bin/env node\n'use strict';\nprocess.stdout.write(JSON.stringify({ok:true,cmd:'ok'}) + '\\n');\n");

  writeJson(policyPath, {
    schema_id: 'self_hosted_bootstrap_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    min_approval_note_chars: 8,
    source_root: tmp,
    build_command: ['node', okScript],
    smoke_command: ['node', okScript],
    verify_commands: [
      ['node', okScript],
      ['node', okScript]
    ],
    outputs: {
      state_path: path.join(tmp, 'state', 'ops', 'self_hosted_bootstrap', 'state.json'),
      latest_path: path.join(tmp, 'state', 'ops', 'self_hosted_bootstrap', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'ops', 'self_hosted_bootstrap', 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    SELF_HOST_BOOTSTRAP_ROOT: tmp,
    SELF_HOST_BOOTSTRAP_POLICY_PATH: policyPath
  };

  const compileA = run(script, repoRoot, ['compile', '--build-id=build_a', '--apply=1', `--policy=${policyPath}`], env);
  assert.strictEqual(compileA.status, 0, compileA.stderr || 'compile A should pass');
  assert.ok(compileA.payload && compileA.payload.ok === true, 'compile A payload should be ok');

  const verifyA = run(script, repoRoot, ['verify', '--build-id=build_a', '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(verifyA.status, 0, verifyA.stderr || 'verify A should pass');
  assert.ok(verifyA.payload && verifyA.payload.ok === true, 'verify A payload should be ok');

  const promoteA = run(script, repoRoot, [
    'promote',
    '--build-id=build_a',
    '--approved-by=operator',
    '--approval-note=approved_a',
    '--apply=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(promoteA.status, 0, promoteA.stderr || 'promote A should pass');
  assert.ok(promoteA.payload && promoteA.payload.ok === true, 'promote A payload should be ok');

  const compileB = run(script, repoRoot, ['compile', '--build-id=build_b', '--apply=1', `--policy=${policyPath}`], env);
  assert.strictEqual(compileB.status, 0, compileB.stderr || 'compile B should pass');

  const verifyB = run(script, repoRoot, ['verify', '--build-id=build_b', '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(verifyB.status, 0, verifyB.stderr || 'verify B should pass');

  const promoteB = run(script, repoRoot, [
    'promote',
    '--build-id=build_b',
    '--approved-by=operator',
    '--approval-note=approved_b',
    '--apply=1',
    `--policy=${policyPath}`
  ], env);
  assert.strictEqual(promoteB.status, 0, promoteB.stderr || 'promote B should pass');

  const rollback = run(script, repoRoot, ['rollback', '--apply=1', '--reason=test_rollback', `--policy=${policyPath}`], env);
  assert.strictEqual(rollback.status, 0, rollback.stderr || 'rollback should pass');
  assert.ok(rollback.payload && rollback.payload.ok === true, 'rollback payload should be ok');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(String(status.payload.state && status.payload.state.active_build_id || ''), 'build_a', 'active build should roll back to build_a');

  console.log('self_hosted_bootstrap_compiler.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`self_hosted_bootstrap_compiler.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
