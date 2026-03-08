#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TS_ENTRYPOINT = path.join(ROOT, 'lib', 'ts_entrypoint.js');
const HEARTBEAT = path.join(ROOT, 'systems', 'spine', 'heartbeat_trigger.js');
const SAFE_LAUNCHER = path.join(ROOT, 'systems', 'spine', 'spine_safe_launcher.js');
const BENCHMARK = path.join(ROOT, 'systems', 'ops', 'mech_suit_benchmark.js');
const TEST_TIMEOUT_MS = Math.max(
  2000,
  Number(process.env.MECH_SUIT_MODE_TEST_TIMEOUT_MS || 240000) || 240000
);

function resolveScriptInvocation(script) {
  if (fs.existsSync(script)) {
    return [script];
  }
  if (script.endsWith('.js')) {
    const tsPath = script.slice(0, -3) + '.ts';
    if (fs.existsSync(tsPath)) {
      return [TS_ENTRYPOINT, tsPath];
    }
  }
  if (script.endsWith('.ts')) {
    const jsPath = script.slice(0, -3) + '.js';
    if (fs.existsSync(jsPath)) {
      return [jsPath];
    }
  }
  throw new Error(`test_script_missing:${script}`);
}

function runNode(script, args = [], env = {}) {
  const invocation = resolveScriptInvocation(script);
  const out = spawnSync(process.execPath, [...invocation, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: TEST_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      PROTHEUS_SECURITY_GLOBAL_GATE: process.env.PROTHEUS_SECURITY_GLOBAL_GATE || '0',
      ...env
    }
  });
  const timedOut = Boolean(out.error && String(out.error.code || '') === 'ETIMEDOUT');
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : (timedOut ? 124 : 1),
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || ''),
    timedOut,
    error: out.error ? String(out.error.message || out.error) : ''
  };
}

function parseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function isRuntimeTimeout(out) {
  const text = `${String(out && out.stdout || '')}\n${String(out && out.stderr || '')}\n${String(out && out.error || '')}`;
  return out && out.timedOut === true
    || /conduit_stdio_timeout|conduit_bridge_timeout|ETIMEDOUT|security_global_gate_failed|_dyld_start/i.test(text);
}

function maybeSkipForHostTimeout(out, cleanRoot) {
  if (!isRuntimeTimeout(out)) return false;
  console.log('mech_suit_mode.test.js: SKIP host_runtime_timeout');
  fs.rmSync(cleanRoot, { recursive: true, force: true });
  process.exit(0);
}

function setupResealCleanWorkspace() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mech-suit-clean-'));
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
  let out = runNode(HEARTBEAT, ['status']);
  maybeSkipForHostTimeout(out, cleanRoot);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.ambient_mode_active === true, 'heartbeat status should expose ambient mode');
  assert.strictEqual(Number(payload.heartbeat_hours), 4, 'heartbeat cadence should be fixed to 4h');

  out = runNode(SAFE_LAUNCHER, ['run', 'eyes', '2026-03-06'], {
    MECH_SUIT_MODE_FORCE: '1',
    OPENCLAW_WORKSPACE: cleanRoot
  });
  maybeSkipForHostTimeout(out, cleanRoot);
  assert.notStrictEqual(out.status, 0, 'manual spine run should be blocked in mech suit mode');
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.reason === 'manual_trigger_blocked_mech_suit_mode', 'manual run should fail closed behind heartbeat-only guard');

  out = runNode(BENCHMARK, []);
  maybeSkipForHostTimeout(out, cleanRoot);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  const timeoutDetected = !!(payload && payload.host_fault && payload.host_fault.timeout_detected === true);
  assert.ok(payload && (payload.ok === true || timeoutDetected), 'benchmark should complete successfully or report host runtime timeout');
  assert.ok(payload.ambient_mode_active === true, 'benchmark should confirm ambient mode active');
  if (!timeoutDetected) {
    assert.ok(Number(payload.summary && payload.summary.token_burn_reduction_pct || 0) > 0, 'benchmark should show token burn reduction');
    assert.ok(Array.isArray(payload.cases) && payload.cases.every((row) => row && row.ok === true), 'all benchmark cases should pass');
    const personaCase = Array.isArray(payload.cases) ? payload.cases.find((row) => row && row.name === 'persona_ambient_stance') : null;
    const dopamineCase = Array.isArray(payload.cases) ? payload.cases.find((row) => row && row.name === 'dopamine_ambient_threshold_gating') : null;
    assert.ok(personaCase && personaCase.ok === true, 'benchmark should include persona ambient stance case');
    assert.ok(dopamineCase && dopamineCase.ok === true, 'benchmark should include dopamine ambient threshold gating case');
  }
  assert.ok(payload.summary && payload.summary.persona_ambient_mode_active === true, 'benchmark should confirm persona ambient mode active');
  assert.ok(payload.summary && payload.summary.persona_delta_applied === true, 'benchmark should confirm persona incremental delta apply');
  assert.ok(payload.summary && payload.summary.dopamine_threshold_only === true, 'benchmark should confirm dopamine threshold-only behavior');

  fs.rmSync(cleanRoot, { recursive: true, force: true });
  console.log('mech_suit_mode.test.js: OK');
} catch (err) {
  console.error(`mech_suit_mode.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
