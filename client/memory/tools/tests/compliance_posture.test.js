#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'compliance_posture.js');

function writeFile(filePath, body) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function writeScript(filePath, body) {
  writeFile(filePath, body);
  fs.chmodSync(filePath, 0o755);
}

function writeJson(filePath, payload) {
  writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`);
}

function run(args, env) {
  const r = spawnSync(process.execPath, [SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...(env || {}) }
  });
  const text = String(r.stdout || '').trim();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch {}
  }
  if (!payload) {
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        payload = JSON.parse(lines[i]);
        break;
      } catch {}
    }
  }
  return {
    status: Number(r.status || 0),
    payload,
    stderr: String(r.stderr || '').trim()
  };
}

function runTest() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'compliance-posture-test-'));
  const outDir = path.join(tmpRoot, 'out');
  const policyPath = path.join(tmpRoot, 'policy.json');
  const scriptsDir = path.join(tmpRoot, 'scripts');

  const soc2Script = path.join(scriptsDir, 'soc2.js');
  const integrityScript = path.join(scriptsDir, 'integrity.js');
  const startupScript = path.join(scriptsDir, 'startup.js');
  const deployScript = path.join(scriptsDir, 'deploy.js');
  const contractScript = path.join(scriptsDir, 'contract.js');

  writeScript(soc2Script, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, pass_rate: 0.95 }));\n`);
  writeScript(integrityScript, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, violations: [] }));\n`);
  writeScript(startupScript, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, state: { expires_at: "2099-01-01T00:00:00.000Z" } }));\n`);
  writeScript(deployScript, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, pass_rate: 0.9 }));\n`);
  writeScript(contractScript, `#!/usr/bin/env node\nconsole.log("contract_check: OK");\n`);

  writeJson(policyPath, {
    version: '1.0',
    strict_default: true,
    default_days: 30,
    weights: {
      soc2_readiness: 0.4,
      integrity_kernel: 0.2,
      startup_attestation: 0.2,
      deployment_packaging: 0.1,
      contract_surface: 0.1
    },
    thresholds: {
      pass: 0.8,
      warn: 0.65
    }
  });

  const env = {
    COMPLIANCE_POSTURE_POLICY_PATH: policyPath,
    COMPLIANCE_POSTURE_OUT_DIR: outDir,
    COMPLIANCE_POSTURE_SOC2_SCRIPT: soc2Script,
    COMPLIANCE_POSTURE_INTEGRITY_SCRIPT: integrityScript,
    COMPLIANCE_POSTURE_STARTUP_ATTESTATION_SCRIPT: startupScript,
    COMPLIANCE_POSTURE_DEPLOYMENT_SCRIPT: deployScript,
    COMPLIANCE_POSTURE_CONTRACT_CHECK_SCRIPT: contractScript
  };

  try {
    let r = run(['run', '--strict=1'], env);
    assert.strictEqual(r.status, 0, `strict posture run should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'expected payload ok=true');
    assert.strictEqual(r.payload.verdict, 'pass', 'expected pass verdict');

    writeScript(soc2Script, `#!/usr/bin/env node\nconsole.log(JSON.stringify({ ok: true, pass_rate: 0.1 }));\n`);

    r = run(['run', '--strict=1'], env);
    assert.notStrictEqual(r.status, 0, 'strict posture run should fail on low score');
    assert.ok(r.payload && r.payload.ok === false, 'expected payload ok=false');
    assert.ok(['warn', 'fail'].includes(String(r.payload.verdict || '')), 'expected warn/fail verdict');

    r = run(['status', 'latest'], env);
    assert.strictEqual(r.status, 0, `status should return latest posture: ${r.stderr}`);
    assert.ok(r.payload && r.payload.type === 'compliance_posture_status', 'expected status payload');

    console.log('compliance_posture.test.js: OK');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`compliance_posture.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
