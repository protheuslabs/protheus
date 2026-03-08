#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(scriptRel, args = []) {
  const out = spawnSync(process.execPath, [path.join(ROOT, scriptRel), ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env
  });
  const txt = String(out.stdout || '').trim();
  const payload = txt ? JSON.parse(txt) : {};
  return { status: out.status, payload, stderr: String(out.stderr || '') };
}

function main() {
  const bootRes = run('systems/browser/native_browser_daemon.js', ['bootstrap', '--apply=1']);
  assert.strictEqual(bootRes.status, 0, bootRes.stderr);
  assert.strictEqual(bootRes.payload.ok, true);

  const startRes = run('systems/browser/native_browser_daemon.js', ['start', '--profile=default', '--apply=1']);
  assert.strictEqual(startRes.status, 0, startRes.stderr);
  assert.strictEqual(startRes.payload.ok, true);
  assert.strictEqual(startRes.payload.payload.state.daemon_running, true);

  const navRes = run('systems/browser/native_browser_cdp.js', ['navigate', '--url=https://example.com']);
  assert.strictEqual(navRes.status, 0, navRes.stderr);
  assert.strictEqual(navRes.payload.ok, true);

  const saveRes = run('systems/browser/browser_session_vault.js', ['save', '--session=s1', '--state-json={"url":"https://example.com"}', '--apply=1']);
  assert.strictEqual(saveRes.status, 0, saveRes.stderr);
  assert.strictEqual(saveRes.payload.ok, true);

  const restoreRes = run('systems/browser/browser_session_vault.js', ['restore', '--session=s1']);
  assert.strictEqual(restoreRes.status, 0, restoreRes.stderr);
  assert.strictEqual(restoreRes.payload.ok, true);
  assert.ok(String(restoreRes.payload.payload.state_json || '').includes('example.com'));

  const snapRes = run('systems/browser/browser_snapshot_refs.js', ['snapshot', '--url=https://example.com', '--selector=main']);
  assert.strictEqual(snapRes.status, 0, snapRes.stderr);
  assert.strictEqual(snapRes.payload.ok, true);
  assert.ok(Array.isArray(snapRes.payload.payload.refs));

  const policyAllow = run('systems/browser/browser_policy_gate.js', ['check', '--url=https://example.com', '--action=navigate']);
  assert.strictEqual(policyAllow.status, 0, policyAllow.stderr);
  assert.strictEqual(policyAllow.payload.payload.allowed, true);

  const policyDeny = run('systems/browser/browser_policy_gate.js', ['check', '--url=https://evil.com', '--action=navigate']);
  assert.strictEqual(policyDeny.status, 0, policyDeny.stderr);
  assert.strictEqual(policyDeny.payload.payload.allowed, false);

  const bridgeRes = run('systems/browser/browser_cli_shadow_bridge.js', ['run', '--native=1', '--persona=vikram', '--task=navigate https://example.com', '--drift-score=10']);
  assert.strictEqual(bridgeRes.status, 0, bridgeRes.stderr);
  assert.strictEqual(bridgeRes.payload.ok, true);

  const stopRes = run('systems/browser/native_browser_daemon.js', ['stop', '--apply=1']);
  assert.strictEqual(stopRes.status, 0, stopRes.stderr);
  assert.strictEqual(stopRes.payload.ok, true);

  console.log('browser_next10_bundle.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`browser_next10_bundle.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
