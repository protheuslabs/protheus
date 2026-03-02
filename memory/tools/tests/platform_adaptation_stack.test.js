#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const ORACLE = path.join(ROOT, 'systems', 'ops', 'platform_oracle_hostprofile.js');
const CHANNEL = path.join(ROOT, 'systems', 'ops', 'platform_adaptation_channel_runtime.js');
const MATRIX = path.join(ROOT, 'systems', 'ops', 'platform_universal_abstraction_matrix.js');
const HOST = path.join(ROOT, 'systems', 'ops', 'host_adaptation_operator_surface.js');
const GATE = path.join(ROOT, 'systems', 'ops', 'host_profile_conformance_formal_gate.js');
const SOCKET = path.join(ROOT, 'systems', 'ops', 'platform_socket_runtime.js');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function mkdirp(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, value) {
  mkdirp(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function run(script, args, env) {
  const res = spawnSync('node', [script, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    encoding: 'utf8',
    timeout: 120000
  });
  return {
    status: typeof res.status === 'number' ? res.status : 1,
    stdout: String(res.stdout || ''),
    stderr: String(res.stderr || '')
  };
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  assert.ok(txt, 'expected JSON stdout');
  try {
    return JSON.parse(txt);
  } catch {
    const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      try {
        return JSON.parse(lines[i]);
      } catch {
        // continue
      }
    }
    throw new Error('stdout was not parseable JSON');
  }
}

try {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'platform-adaptation-stack-'));
  const stateDir = path.join(tmp, 'state');
  const configDir = path.join(tmp, 'config');

  const oraclePolicyPath = path.join(configDir, 'platform_oracle_hostprofile_policy.json');
  const channelPolicyPath = path.join(configDir, 'platform_adaptation_channel_runtime_policy.json');
  const matrixPolicyPath = path.join(configDir, 'platform_universal_abstraction_matrix_policy.json');
  const hostPolicyPath = path.join(configDir, 'host_adaptation_operator_surface_policy.json');
  const gatePolicyPath = path.join(configDir, 'host_profile_conformance_formal_gate_policy.json');
  const socketPolicyPath = path.join(configDir, 'platform_socket_runtime_policy.json');

  writeJson(oraclePolicyPath, {
    schema_id: 'platform_oracle_hostprofile_policy',
    schema_version: '1.0-test',
    enabled: true,
    min_confidence: 0.35,
    signing_secret: 'test-secret',
    fallback_profile: {
      mode: 'minimal',
      os_family: 'unknown',
      distro: 'unknown',
      variant: 'unknown',
      arch: process.arch,
      runtime: { node: process.version }
    },
    state_path: path.join(stateDir, 'ops/platform_oracle_hostprofile/latest.json'),
    history_path: path.join(stateDir, 'ops/platform_oracle_hostprofile/history.jsonl'),
    last_known_good_path: path.join(stateDir, 'ops/platform_oracle_hostprofile/last_known_good.json')
  });

  writeJson(channelPolicyPath, {
    schema_id: 'platform_adaptation_channel_runtime_policy',
    schema_version: '1.0-test',
    enabled: true,
    oracle_state_path: path.join(stateDir, 'ops/platform_oracle_hostprofile/latest.json'),
    channels_registry_path: path.join(ROOT, 'config/platform_adaptation_channels.json'),
    state_path: path.join(stateDir, 'ops/platform_adaptation_channel_runtime/latest.json'),
    history_path: path.join(stateDir, 'ops/platform_adaptation_channel_runtime/history.jsonl'),
    signing_secret: 'test-secret'
  });

  writeJson(matrixPolicyPath, {
    schema_id: 'platform_universal_abstraction_matrix_policy',
    schema_version: '1.0-test',
    enabled: true,
    matrix_path: path.join(ROOT, 'config/platform_universal_abstraction_matrix.json'),
    state_path: path.join(stateDir, 'ops/platform_universal_abstraction_matrix/latest.json'),
    history_path: path.join(stateDir, 'ops/platform_universal_abstraction_matrix/history.jsonl'),
    signing_secret: 'test-secret'
  });

  writeJson(hostPolicyPath, {
    schema_id: 'host_adaptation_operator_surface_policy',
    schema_version: '1.0-test',
    enabled: true,
    first_run_auto_adapt: true,
    state_path: path.join(stateDir, 'ops/host_adaptation_operator_surface/latest.json'),
    history_path: path.join(stateDir, 'ops/host_adaptation_operator_surface/history.jsonl'),
    oracle_state_path: path.join(stateDir, 'ops/platform_oracle_hostprofile/latest.json'),
    channel_state_path: path.join(stateDir, 'ops/platform_adaptation_channel_runtime/latest.json'),
    matrix_state_path: path.join(stateDir, 'ops/platform_universal_abstraction_matrix/latest.json')
  });

  writeJson(gatePolicyPath, {
    schema_id: 'host_profile_conformance_formal_gate_policy',
    schema_version: '1.0-test',
    enabled: true,
    oracle_state_path: path.join(stateDir, 'ops/platform_oracle_hostprofile/latest.json'),
    channel_state_path: path.join(stateDir, 'ops/platform_adaptation_channel_runtime/latest.json'),
    lane_predicates_path: path.join(ROOT, 'config/host_profile_lane_predicates.json'),
    state_path: path.join(stateDir, 'ops/host_profile_conformance_formal_gate/latest.json'),
    history_path: path.join(stateDir, 'ops/host_profile_conformance_formal_gate/history.jsonl'),
    signing_secret: 'test-secret'
  });

  writeJson(socketPolicyPath, {
    schema_id: 'platform_socket_runtime_policy',
    schema_version: '1.0-test',
    enabled: true,
    oracle_state_path: path.join(stateDir, 'ops/platform_oracle_hostprofile/latest.json'),
    socket_registry_path: path.join(ROOT, 'config/platform_socket_registry.json'),
    admission_policy_path: path.join(ROOT, 'config/platform_socket_admission_policy.json'),
    state_path: path.join(stateDir, 'ops/platform_socket_runtime/latest.json'),
    history_path: path.join(stateDir, 'ops/platform_socket_runtime/history.jsonl'),
    install_state_path: path.join(stateDir, 'ops/platform_socket_runtime/installed.json'),
    signing_secret: 'test-secret'
  });

  const env = {
    PLATFORM_ORACLE_HOSTPROFILE_POLICY_PATH: oraclePolicyPath,
    PLATFORM_ADAPTATION_CHANNEL_RUNTIME_POLICY_PATH: channelPolicyPath,
    PLATFORM_UNIVERSAL_ABSTRACTION_MATRIX_POLICY_PATH: matrixPolicyPath,
    HOST_ADAPTATION_OPERATOR_SURFACE_POLICY_PATH: hostPolicyPath,
    HOST_PROFILE_CONFORMANCE_FORMAL_GATE_POLICY_PATH: gatePolicyPath,
    PLATFORM_SOCKET_RUNTIME_POLICY_PATH: socketPolicyPath
  };

  const oracleRun = run(ORACLE, ['run', '--phase=boot', '--strict=1'], env);
  assert.strictEqual(oracleRun.status, 0, `oracle run failed: ${oracleRun.stderr}`);
  const oraclePayload = parseJson(oracleRun.stdout);
  assert.strictEqual(oraclePayload.ok, true, 'oracle should pass');
  assert.ok(oraclePayload.host_profile, 'host profile should be present');

  const channelTest = run(CHANNEL, ['test', '--strict=1'], env);
  assert.strictEqual(channelTest.status, 0, `channel test failed: ${channelTest.stderr}`);
  const channelPayload = parseJson(channelTest.stdout);
  assert.strictEqual(channelPayload.ok, true, 'channel test should pass');

  const matrixRun = run(MATRIX, ['run', '--strict=1'], env);
  assert.strictEqual(matrixRun.status, 0, `matrix run failed: ${matrixRun.stderr}`);
  const matrixPayload = parseJson(matrixRun.stdout);
  assert.strictEqual(matrixPayload.ok, true, 'matrix should pass');

  const hostAdapt = run(HOST, ['adapt', '--strict=1'], env);
  assert.strictEqual(hostAdapt.status, 0, `host adapt failed: ${hostAdapt.stderr}`);
  const hostPayload = parseJson(hostAdapt.stdout);
  assert.strictEqual(hostPayload.ok, true, 'host adapt should pass');

  const gateRun = run(GATE, ['run', '--strict=1'], env);
  assert.strictEqual(gateRun.status, 0, `gate run failed: ${gateRun.stderr}`);
  const gatePayload = parseJson(gateRun.stdout);
  assert.strictEqual(gatePayload.ok, true, 'conformance gate should pass');

  const socketActivate = run(SOCKET, ['activate', '--strict=1'], env);
  assert.strictEqual(socketActivate.status, 0, `socket activate failed: ${socketActivate.stderr}`);
  const socketPayload = parseJson(socketActivate.stdout);
  assert.strictEqual(socketPayload.ok, true, 'socket activation should pass');

  const socketList = run(SOCKET, ['lifecycle', 'list'], env);
  assert.strictEqual(socketList.status, 0, `socket list failed: ${socketList.stderr}`);
  const listPayload = parseJson(socketList.stdout);
  assert.ok(Array.isArray(listPayload.sockets), 'socket list should return sockets');

  const socketInstall = run(SOCKET, ['lifecycle', 'install', '--socket-id=generic', '--strict=1'], env);
  assert.strictEqual(socketInstall.status, 0, `socket install failed: ${socketInstall.stderr}`);
  const installPayload = parseJson(socketInstall.stdout);
  assert.strictEqual(installPayload.ok, true, 'socket install should pass');

  const socketTest = run(SOCKET, ['lifecycle', 'test', '--socket-id=generic', '--strict=1'], env);
  assert.strictEqual(socketTest.status, 0, `socket test failed: ${socketTest.stderr}`);
  const socketTestPayload = parseJson(socketTest.stdout);
  assert.strictEqual(socketTestPayload.ok, true, 'socket lifecycle test should pass');

  const socketAdmission = run(SOCKET, ['admission', '--strict=1'], env);
  assert.strictEqual(socketAdmission.status, 0, `socket admission failed: ${socketAdmission.stderr}`);
  const admissionPayload = parseJson(socketAdmission.stdout);
  assert.strictEqual(admissionPayload.ok, true, 'socket admission should pass');

  const ctlHost = run(PROTHEUSCTL, ['host', 'status'], env);
  assert.strictEqual(ctlHost.status, 0, `protheusctl host status failed: ${ctlHost.stderr}`);
  const ctlHostPayload = parseJson(ctlHost.stdout);
  assert.strictEqual(ctlHostPayload.ok, true, 'protheusctl host status should pass');

  const ctlSocket = run(PROTHEUSCTL, ['socket', 'list'], env);
  assert.strictEqual(ctlSocket.status, 0, `protheusctl socket list failed: ${ctlSocket.stderr}`);
  const ctlSocketPayload = parseJson(ctlSocket.stdout);
  assert.strictEqual(ctlSocketPayload.ok, true, 'protheusctl socket list should pass');

  console.log('platform_adaptation_stack.test.js: OK');
} catch (err) {
  console.error(`platform_adaptation_stack.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
}
