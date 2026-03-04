#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');
const TMP_ROOT = path.join(ROOT, 'tmp', 'tests', 'protheus_internal_operator_commands');
const SHADOW_STATE_PATH = path.join(TMP_ROOT, 'state', 'shadow_cli_state.json');
const SHADOW_TELEMETRY_PATH = path.join(TMP_ROOT, 'state', 'shadow_cli_telemetry.jsonl');

function ensureCleanDir(dirPath) {
  fs.rmSync(dirPath, { recursive: true, force: true });
  fs.mkdirSync(dirPath, { recursive: true });
}

function run(args, env = {}) {
  const out = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_RUNTIME_MODE: 'source',
      PROTHEUS_CTL_SECURITY_GATE_DISABLED: '1',
      PROTHEUS_CLI_SUGGESTIONS: '0',
      PROTHEUS_SKIP_SETUP: '1',
      PROTHEUS_UPDATE_CHECKER_DISABLED: '1',
      PROTHEUS_SHADOW_SKIP_SECURITY_GATE: '1',
      PROTHEUS_SHADOW_STATE_PATH: SHADOW_STATE_PATH,
      PROTHEUS_PERSONA_TELEMETRY_PATH: SHADOW_TELEMETRY_PATH,
      ...env
    }
  });
  return {
    status: Number.isFinite(out.status) ? Number(out.status) : 1,
    stdout: String(out.stdout || ''),
    stderr: String(out.stderr || '')
  };
}

function parseJson(raw) {
  const txt = String(raw || '').trim();
  if (!txt) return null;
  try {
    return JSON.parse(txt);
  } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

try {
  ensureCleanDir(TMP_ROOT);

  let out = run(['status', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  let payload = parseJson(out.stdout);
  assert.ok(payload && payload.type === 'protheus_status_dashboard', 'status should return dashboard payload');
  assert.ok(payload.rust && Number.isFinite(Number(payload.rust.rust_percent)), 'status should include rust percentage');
  assert.ok(payload.drift && typeof payload.drift.drift_level === 'string', 'status should include drift summary');
  assert.ok(payload.shadows && Number.isFinite(Number(payload.shadows.active_shadows)), 'status should include shadow summary');
  assert.ok(payload.heartbeat && Object.prototype.hasOwnProperty.call(payload.heartbeat, 'last_check_at'), 'status should include heartbeat summary');

  out = run(['debug', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.type === 'protheus_debug_diagnostics', 'debug should return diagnostics payload');
  assert.ok(payload.parity && payload.parity.continuous, 'debug should include parity diagnostics');
  assert.ok(payload.security && payload.security.dispatch_probe, 'debug should include security dispatch probe');
  assert.ok(payload.logs && payload.logs.persona_telemetry, 'debug should include log summaries');

  out = run(['shadow', 'list', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.type === 'shadow_cli_list', 'shadow list should return list payload');
  assert.ok(Array.isArray(payload.available_personas), 'shadow list should include available personas');
  assert.ok(payload.available_personas.includes('vikram_menon'), 'expected vikram_menon persona to exist');

  out = run(['shadow', 'arise', 'vikram_menon', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.type === 'shadow_cli_status', 'shadow arise should include status payload');
  assert.ok(Array.isArray(payload.active_ids) && payload.active_ids.includes('vikram_menon'), 'shadow arise should activate persona');

  out = run(['shadow', 'pause', 'vikram_menon', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(Array.isArray(payload.paused_ids) && payload.paused_ids.includes('vikram_menon'), 'shadow pause should pause persona');

  out = run(['shadow', 'review', 'vikram_menon', '--note=weekly_check', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.type === 'shadow_cli_status', 'shadow review should include status payload');
  assert.ok(Number(payload.reviews_pending || 0) >= 1, 'shadow review should increase pending review count');

  out = run(['shadow', 'status', '--json=1']);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  payload = parseJson(out.stdout);
  assert.ok(payload && payload.type === 'shadow_cli_status', 'shadow status should return status payload');
  assert.ok(fs.existsSync(SHADOW_STATE_PATH), 'shadow command should persist state file');
  assert.ok(fs.existsSync(SHADOW_TELEMETRY_PATH), 'shadow command should write telemetry');

  console.log('protheus_internal_operator_commands.test.js: OK');
} catch (err) {
  console.error(`protheus_internal_operator_commands.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
