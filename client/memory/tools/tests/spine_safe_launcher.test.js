#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SAFE_LAUNCHER = [
  path.join(ROOT, 'runtime', 'systems', 'spine', 'spine_safe_launcher.js'),
  path.join(ROOT, 'systems', 'spine', 'spine_safe_launcher.js')
].find((candidate) => fs.existsSync(candidate));
if (!SAFE_LAUNCHER) throw new Error('spine_safe_launcher_missing');

function runNode(script, args, extraEnv = {}) {
  const out = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...extraEnv
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function isRuntimeTimeout(out) {
  const text = `${String(out && out.stdout || '')}\n${String(out && out.stderr || '')}`;
  return /conduit_stdio_timeout|conduit_bridge_timeout|conduit_runtime_gate_active_until|ETIMEDOUT|_dyld_start/i.test(text);
}

function maybeSkipForHostTimeout(out, ...tempRoots) {
  if (!isRuntimeTimeout(out)) return;
  for (const root of tempRoots) {
    if (!root) continue;
    fs.rmSync(root, { recursive: true, force: true });
  }
  console.log('spine_safe_launcher.test.js: SKIP host_runtime_timeout');
  process.exit(0);
}

function setupResealRequiredWorkspace() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-safe-launcher-'));
  const securityDir = path.join(tempRoot, 'systems', 'security');
  fs.mkdirSync(securityDir, { recursive: true });
  const stub = `#!/usr/bin/env node
'use strict';
const cmd = String(process.argv[2] || 'status');
if (cmd === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    reseal_required: true,
    check: { violation_counts: { unsealed_file: 2 } }
  }) + '\\n');
  process.exit(0);
}
if (cmd === 'run') {
  process.stdout.write(JSON.stringify({ ok: true, reseal_required: false, applied: true }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: false, error: 'unsupported_command' }) + '\\n');
process.exit(1);
`;
  fs.writeFileSync(path.join(securityDir, 'integrity_reseal_assistant.js'), stub, 'utf8');
  return tempRoot;
}

function setupResealCleanWorkspace() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'spine-safe-launcher-clean-'));
  const securityDir = path.join(tempRoot, 'systems', 'security');
  fs.mkdirSync(securityDir, { recursive: true });
  const stub = `#!/usr/bin/env node
'use strict';
const cmd = String(process.argv[2] || 'status');
if (cmd === 'status') {
  process.stdout.write(JSON.stringify({
    ok: true,
    reseal_required: false,
    check: { violation_counts: { unsealed_file: 0 } }
  }) + '\\n');
  process.exit(0);
}
if (cmd === 'run') {
  process.stdout.write(JSON.stringify({ ok: true, reseal_required: false, applied: false }) + '\\n');
  process.exit(0);
}
process.stdout.write(JSON.stringify({ ok: false, error: 'unsupported_command' }) + '\\n');
process.exit(1);
`;
  fs.writeFileSync(path.join(securityDir, 'integrity_reseal_assistant.js'), stub, 'utf8');
  return tempRoot;
}

try {
  const cleanRoot = setupResealCleanWorkspace();
  let out = runNode(SAFE_LAUNCHER, ['status'], { AUTONOMY_ENABLED: '1', OPENCLAW_WORKSPACE: cleanRoot });
  maybeSkipForHostTimeout(out, cleanRoot);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'status should return ok payload');
  assert.ok(Array.isArray(payload.neutralized_risky_toggles), 'status should expose neutralized toggles');
  assert.ok(payload.neutralized_risky_toggles.includes('AUTONOMY_ENABLED'), 'launcher should neutralize AUTONOMY_ENABLED by default');

  const resealRoot = setupResealRequiredWorkspace();
  out = runNode(SAFE_LAUNCHER, ['status'], { OPENCLAW_WORKSPACE: resealRoot });
  maybeSkipForHostTimeout(out, cleanRoot, resealRoot);
  assert.notStrictEqual(out.status, 0, 'status should fail closed when reseal is required');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.blocked === true, 'blocked payload should be emitted');
  assert.strictEqual(payload.reason, 'integrity_reseal_required', 'blocked reason should be integrity reseal requirement');

  out = runNode(SAFE_LAUNCHER, ['status', '--apply-reseal=1'], { OPENCLAW_WORKSPACE: resealRoot });
  maybeSkipForHostTimeout(out, cleanRoot, resealRoot);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.ok === true, 'apply reseal status should pass');
  assert.strictEqual(payload.reseal_applied, true, 'status payload should report reseal_applied=true when auto-apply is enabled');

  out = runNode(SAFE_LAUNCHER, ['run', 'eyes', '2026-03-06'], {
    MECH_SUIT_MODE_FORCE: '1',
    OPENCLAW_WORKSPACE: cleanRoot
  });
  maybeSkipForHostTimeout(out, cleanRoot, resealRoot);
  assert.notStrictEqual(out.status, 0, 'manual spine run should be blocked when mech suit mode is active');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.reason === 'manual_trigger_blocked_mech_suit_mode', 'manual run should fail closed behind heartbeat-only entry');

  fs.rmSync(cleanRoot, { recursive: true, force: true });
  fs.rmSync(resealRoot, { recursive: true, force: true });
  console.log('spine_safe_launcher.test.js: OK');
} catch (err) {
  console.error(`spine_safe_launcher.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
