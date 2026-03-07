#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CLI_PATH = path.join(REPO_ROOT, 'systems', 'security', 'secret_broker.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
}

function runCli(args, env) {
  const res = spawnSync('node', [CLI_PATH, ...args], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  return JSON.parse(String(stdout || '{}').trim());
}

function reloadBroker() {
  const id = require.resolve('../../../lib/secret_broker.js');
  delete require.cache[id];
  return require('../../../lib/secret_broker.js');
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'secret-broker-backend-'));
  const policyPath = path.join(tmp, 'secret_broker_policy.json');
  const statePath = path.join(tmp, 'secret_broker_state.json');
  const auditPath = path.join(tmp, 'secret_broker_audit.jsonl');

  writeJson(policyPath, {
    version: '1.0-test',
    rotation_policy: {
      warn_after_days: 7,
      max_after_days: 14,
      require_rotated_at: true,
      enforce_on_issue: false
    },
    secrets: {
      test_cmd_secret: {
        providers: [
          {
            type: 'command',
            enabled: true,
            command: [
              'node',
              '-e',
              "process.stdout.write(JSON.stringify({value:process.env.TEST_CMD_SECRET,rotated_at:process.env.TEST_CMD_ROTATED_AT}));"
            ],
            parse_json: true,
            value_path: 'value',
            rotated_at_path: 'rotated_at',
            timeout_ms: 2000
          }
        ],
        rotation: {
          warn_after_days: 5,
          max_after_days: 10,
          require_rotated_at: true
        }
      }
    }
  });

  process.env.SECRET_BROKER_POLICY_PATH = policyPath;
  process.env.SECRET_BROKER_STATE_PATH = statePath;
  process.env.SECRET_BROKER_AUDIT_PATH = auditPath;
  process.env.SECRET_BROKER_KEY = 'test_secret_broker_key_rotation';
  process.env.TEST_CMD_SECRET = 'cmd_secret_value_12345';
  process.env.TEST_CMD_ROTATED_AT = '2025-12-01T00:00:00.000Z';

  const broker = reloadBroker();
  const loaded = broker.loadSecretById('test_cmd_secret');
  assert.strictEqual(loaded.ok, true, 'command backend should load secret');
  assert.strictEqual(loaded.backend.provider_type, 'command');
  assert.strictEqual(loaded.backend.external, true);
  assert.strictEqual(loaded.rotation.status, 'critical', 'old rotation date should be critical');

  const rotation = broker.evaluateSecretRotationHealth({
    policy_path: policyPath,
    secret_ids: ['test_cmd_secret']
  });
  assert.strictEqual(rotation.ok, false, 'critical rotation should fail health');
  assert.strictEqual(rotation.level, 'critical');
  assert.strictEqual(Number(rotation.counts.critical || 0), 1);

  const strictFail = runCli(['rotation-check', '--secret-ids=test_cmd_secret', '--strict=1', `--policy=${policyPath}`], {
    SECRET_BROKER_POLICY_PATH: policyPath,
    SECRET_BROKER_STATE_PATH: statePath,
    SECRET_BROKER_AUDIT_PATH: auditPath,
    SECRET_BROKER_KEY: 'test_secret_broker_key_rotation',
    TEST_CMD_SECRET: 'cmd_secret_value_12345',
    TEST_CMD_ROTATED_AT: '2025-12-01T00:00:00.000Z'
  });
  assert.strictEqual(strictFail.status, 1, 'strict rotation check should fail on critical');

  const strictPass = runCli(['rotation-check', '--secret-ids=test_cmd_secret', '--strict=1', `--policy=${policyPath}`], {
    SECRET_BROKER_POLICY_PATH: policyPath,
    SECRET_BROKER_STATE_PATH: statePath,
    SECRET_BROKER_AUDIT_PATH: auditPath,
    SECRET_BROKER_KEY: 'test_secret_broker_key_rotation',
    TEST_CMD_SECRET: 'cmd_secret_value_12345',
    TEST_CMD_ROTATED_AT: '2026-02-25T00:00:00.000Z'
  });
  assert.strictEqual(strictPass.status, 0, 'strict rotation check should pass with fresh rotation');
  const strictPassPayload = parseJson(strictPass.stdout);
  assert.strictEqual(strictPassPayload.ok, true, 'fresh rotation should be ok');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('secret_broker_backend_rotation.test.js: OK');
} catch (err) {
  console.error(`secret_broker_backend_rotation.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
