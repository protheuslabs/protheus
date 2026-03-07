#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'startup_attestation_boot_gate.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}
function writeScript(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}
function run(args, env) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' });
}
function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} }
  return null;
}

function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'startup-boot-gate-'));
  const policyPath = path.join(tmp, 'config', 'startup_attestation_boot_gate_policy.json');
  const mockAttest = path.join(tmp, 'mock_startup_attestation.js');
  const mockIntegrity = path.join(tmp, 'mock_integrity_kernel.js');

  writeScript(mockAttest, [
    "#!/usr/bin/env node",
    "'use strict';",
    "const fresh = process.env.MOCK_ATTEST_FRESH !== '0';",
    "const ts = fresh ? new Date().toISOString() : new Date(Date.now() - (48*60*60*1000)).toISOString();",
    "process.stdout.write(JSON.stringify({ ok: true, ts }) + '\\n');",
    "process.exit(0);"
  ].join('\n'));

  writeScript(mockIntegrity, [
    "#!/usr/bin/env node",
    "'use strict';",
    "const ok = process.env.MOCK_INTEGRITY_OK !== '0';",
    "process.stdout.write(JSON.stringify({ ok }) + '\\n');",
    "process.exit(ok ? 0 : 1);"
  ].join('\n'));

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    max_attestation_age_hours: 24,
    scripts: {
      startup_attestation: mockAttest,
      integrity_kernel: mockIntegrity
    },
    outputs: {
      latest_path: path.join(tmp, 'state', 'latest.json'),
      history_path: path.join(tmp, 'state', 'history.jsonl')
    }
  });

  const env = {
    STARTUP_ATTEST_BOOT_GATE_ROOT: tmp,
    STARTUP_ATTEST_BOOT_GATE_POLICY_PATH: policyPath
  };

  let r = run(['boot-check', '--strict=1'], env);
  assert.strictEqual(r.status, 0, r.stderr || 'fresh attestation should pass');
  let out = parseJson(r.stdout);
  assert.ok(out && out.ready_for_execute === true, 'fresh path should be ready');

  r = run(['boot-check', '--strict=1'], { ...env, MOCK_ATTEST_FRESH: '0' });
  assert.notStrictEqual(r.status, 0, 'stale attestation should fail strict');
  out = parseJson(r.stdout);
  assert.ok(out && out.ready_for_execute === false, 'stale path should block execute');

  console.log('startup_attestation_boot_gate.test.js: OK');
}

try { main(); } catch (err) { console.error(`startup_attestation_boot_gate.test.js: FAIL: ${err.message}`); process.exit(1); }
