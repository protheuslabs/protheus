#!/usr/bin/env node
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'security', 'threat_model_security_test_pack.js');
function writeJson(filePath, payload) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8'); }
function writeScript(filePath, body) { fs.mkdirSync(path.dirname(filePath), { recursive: true }); fs.writeFileSync(filePath, body, 'utf8'); }
function run(args, env) { return spawnSync(process.execPath, [SCRIPT, ...args], { cwd: ROOT, env: { ...process.env, ...env }, encoding: 'utf8' }); }
function parseJson(stdout) { const txt = String(stdout || '').trim(); if (!txt) return null; try { return JSON.parse(txt); } catch {} const lines = txt.split('\n').filter(Boolean); for (let i = lines.length - 1; i >= 0; i -= 1) { try { return JSON.parse(lines[i]); } catch {} } return null; }
function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'v1h-threat-pack-')); const policyPath = path.join(tmp, 'config', 'threat_model_security_test_pack_policy.json');
  const s1 = path.join(tmp, 'check_ok.js'); const s2 = path.join(tmp, 'check_fail.js');
  writeScript(s1, "#!/usr/bin/env node\n'use strict';\nprocess.stdout.write('{}\\n');\nprocess.exit(0);\n");
  writeScript(s2, "#!/usr/bin/env node\n'use strict';\nprocess.stdout.write('{}\\n');\nprocess.exit(process.env.CHECK2_OK==='1'?0:1);\n");
  writeJson(policyPath, { version: '1.0-test', enabled: true, checks: [{ id: 'one', script: s1, args: [] }, { id: 'two', script: s2, args: [] }], outputs: { latest_path: path.join(tmp, 'state', 'latest.json'), history_path: path.join(tmp, 'state', 'history.jsonl') } });
  const env = { THREAT_MODEL_PACK_ROOT: tmp, THREAT_MODEL_PACK_POLICY_PATH: policyPath };
  let r = run(['run', '--strict=1'], { ...env, CHECK2_OK: '1' }); assert.strictEqual(r.status, 0, r.stderr || 'all checks pass should succeed');
  r = run(['run', '--strict=1'], env); assert.notStrictEqual(r.status, 0, 'failing check should fail strict'); const out = parseJson(r.stdout); assert.ok(out && out.ok === false && out.failed_checks.includes('two'), 'failed check id should be present');
  console.log('v1h_threat_model_security_test_pack.test.js: OK');
}
try { main(); } catch (err) { console.error(`v1h_threat_model_security_test_pack.test.js: FAIL: ${err.message}`); process.exit(1); }
