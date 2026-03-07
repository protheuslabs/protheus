#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCRIPT = path.join(ROOT, 'systems', 'ops', 'deployment_packaging.js');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
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
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deployment-packaging-test-'));
  const outDir = path.join(tmpRoot, 'out');
  const policyPath = path.join(tmpRoot, 'policy.json');
  const requiredFile = path.join(tmpRoot, 'required.marker');
  fs.writeFileSync(requiredFile, 'ok\n', 'utf8');

  writeJson(policyPath, {
    version: '1.0',
    strict_default: true,
    profiles: {
      prod: {
        required_files: ['Dockerfile', requiredFile],
        required_scripts: ['typecheck:systems'],
        checks: {
          docker_require_user: true,
          docker_require_healthcheck: true,
          docker_forbid_latest_tag: true,
          k8s_require_run_as_non_root: false,
          k8s_require_no_privilege_escalation: false,
          k8s_require_read_only_root_fs: false
        }
      }
    }
  });

  try {
    let r = run(['run', '--profile=prod', '--strict=1'], {
      DEPLOYMENT_PACKAGING_POLICY_PATH: policyPath,
      DEPLOYMENT_PACKAGING_OUT_DIR: outDir
    });
    assert.strictEqual(r.status, 0, `packaging strict run should pass: ${r.stderr}`);
    assert.ok(r.payload && r.payload.ok === true, 'expected packaging payload ok=true');
    assert.strictEqual(r.payload.verdict, 'pass', 'expected pass verdict');

    writeJson(policyPath, {
      version: '1.0',
      strict_default: true,
      profiles: {
        prod: {
          required_files: ['Dockerfile', '/tmp/path-that-does-not-exist'],
          required_scripts: ['typecheck:systems'],
          checks: {
            docker_require_user: true,
            docker_require_healthcheck: true,
            docker_forbid_latest_tag: true,
            k8s_require_run_as_non_root: false,
            k8s_require_no_privilege_escalation: false,
            k8s_require_read_only_root_fs: false
          }
        }
      }
    });

    r = run(['run', '--profile=prod', '--strict=1'], {
      DEPLOYMENT_PACKAGING_POLICY_PATH: policyPath,
      DEPLOYMENT_PACKAGING_OUT_DIR: outDir
    });
    assert.notStrictEqual(r.status, 0, 'strict packaging run should fail when file is missing');
    assert.ok(r.payload && r.payload.ok === false, 'expected payload ok=false');
    assert.ok(Number(r.payload.failed_checks || 0) > 0, 'expected failed checks > 0');

    r = run(['status', 'latest'], {
      DEPLOYMENT_PACKAGING_POLICY_PATH: policyPath,
      DEPLOYMENT_PACKAGING_OUT_DIR: outDir
    });
    assert.strictEqual(r.status, 0, `status should still return latest payload: ${r.stderr}`);
    assert.ok(r.payload && r.payload.type === 'deployment_packaging_status', 'expected status payload');

    console.log('deployment_packaging.test.js: OK');
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  runTest();
} catch (err) {
  console.error(`deployment_packaging.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
