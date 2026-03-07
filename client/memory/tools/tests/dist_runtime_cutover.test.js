#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'dist_runtime_cutover.js');

function runCmd(args, env) {
  return spawnSync('node', [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...env
    }
  });
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}'));
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dist-runtime-cutover-test-'));
  const statePath = path.join(tmp, 'runtime_mode.json');
  const legacyStatePath = path.join(tmp, 'legacy_pairs_state.json');
  const legacyIncidentsPath = path.join(tmp, 'legacy_pair_incidents.jsonl');
  const baseEnv = {
    PROTHEUS_RUNTIME_MODE_STATE_PATH: statePath,
    DIST_RUNTIME_LEGACY_STATE_PATH: legacyStatePath,
    DIST_RUNTIME_LEGACY_INCIDENTS_PATH: legacyIncidentsPath
  };

  let r = runCmd(['status'], baseEnv);
  assert.strictEqual(r.status, 0, `status should pass: ${r.stderr}`);
  let out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.state_mode, 'source');

  r = runCmd(['set-mode', '--mode=dist'], baseEnv);
  assert.strictEqual(r.status, 0, `set-mode dist should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.mode, 'dist');
  assert.ok(fs.existsSync(statePath), 'set-mode should write state file');

  r = runCmd(['status'], baseEnv);
  assert.strictEqual(r.status, 0, `status after set-mode should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true);
  assert.strictEqual(out.state_mode, 'dist');
  assert.strictEqual(out.effective_mode, 'dist');

  r = runCmd(['status'], {
    ...baseEnv,
    PROTHEUS_RUNTIME_MODE: 'source'
  });
  assert.strictEqual(r.status, 0, `status with env override should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.effective_mode, 'source');

  r = runCmd(['legacy-pairs'], baseEnv);
  assert.strictEqual(r.status, 0, `legacy-pairs should pass: ${r.stderr}`);
  out = parseJson(r.stdout);
  assert.strictEqual(out.ok, true, 'legacy runtime JS pairs should be retired');
  assert.strictEqual(Number(out.legacy_pair_count || 0), 0, 'no legacy runtime JS pairs expected');
  assert.ok(out.backlog_status_guard && out.backlog_status_guard.ok === true, 'backlog status guard should pass when no legacy pairs exist');

  const fixtureTs = path.join(ROOT, 'systems', 'ops', '__legacy_runtime_pair_fixture__.ts');
  const fixtureJs = path.join(ROOT, 'systems', 'ops', '__legacy_runtime_pair_fixture__.js');
  try {
    fs.writeFileSync(fixtureTs, "export const legacyRuntimePairFixture = true;\n", 'utf8');
    fs.writeFileSync(
      fixtureJs,
      [
        '#!/usr/bin/env node',
        "'use strict';",
        'module.exports = { legacyRuntimePairFixture: true };',
        ''
      ].join('\n'),
      'utf8'
    );

    r = runCmd(['legacy-pairs', '--strict=1'], baseEnv);
    assert.strictEqual(r.status, 1, 'legacy-pairs strict should fail when a non-wrapper JS/TS pair exists');
    out = parseJson(r.stdout);
    assert.strictEqual(out.ok, false, 'legacy-pairs output should fail');
    assert.ok(Number(out.legacy_pair_count || 0) >= 1, 'legacy pair count should be positive');
    assert.ok(
      Array.isArray(out.legacy_pairs) && out.legacy_pairs.includes('client/systems/ops/__legacy_runtime_pair_fixture__.js'),
      'fixture legacy pair should be detected'
    );
    assert.strictEqual(out.incident_opened, true, 'pair delta failure should auto-open an incident');
    assert.ok(
      out.backlog_status_guard
        && Array.isArray(out.backlog_status_guard.reopen_required_ids)
        && out.backlog_status_guard.reopen_required_ids.includes('V2-003'),
      'done backlog runtime ticket should require reopen on legacy pair failure'
    );
    assert.ok(fs.existsSync(legacyIncidentsPath), 'incident log should be created');
    const incidentLines = String(fs.readFileSync(legacyIncidentsPath, 'utf8') || '').trim().split('\n').filter(Boolean);
    assert.ok(incidentLines.length >= 1, 'incident log should include at least one entry');
  } finally {
    try { if (fs.existsSync(fixtureJs)) fs.unlinkSync(fixtureJs); } catch {}
    try { if (fs.existsSync(fixtureTs)) fs.unlinkSync(fixtureTs); } catch {}
  }

  r = runCmd(['legacy-pairs', '--strict=1'], baseEnv);
  assert.strictEqual(r.status, 0, 'legacy-pairs should recover after fixture cleanup');
  out = parseJson(r.stdout);
  assert.strictEqual(Number(out.legacy_pair_count || 0), 0, 'legacy pair count should return to zero after cleanup');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('dist_runtime_cutover.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`dist_runtime_cutover.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
