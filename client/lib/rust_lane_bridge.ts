'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function repoRoot(scriptDir) {
  let dir = path.resolve(scriptDir || process.cwd());
  while (true) {
    const cargo = path.join(dir, 'Cargo.toml');
    const coreOps = path.join(dir, 'core', 'layer0', 'ops', 'Cargo.toml');
    const legacyOps = path.join(dir, 'crates', 'ops', 'Cargo.toml');
    if (fs.existsSync(cargo) && (fs.existsSync(coreOps) || fs.existsSync(legacyOps))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(scriptDir || process.cwd(), '..', '..', '..');
}

function parseJsonPayload(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (!line || line[0] !== '{') continue;
    try {
      return JSON.parse(line);
    } catch {}
  }
  return null;
}

function normalizeStatus(v) {
  return Number.isFinite(Number(v)) ? Number(v) : 1;
}

function defaultEnv() {
  return {
    ...process.env,
    PROTHEUS_NODE_BINARY: process.execPath || 'node'
  };
}

function runBridge(config, args = [], cliMode = false) {
  const root = repoRoot(config.scriptDir);
  const passArgs = Array.isArray(args) ? args.slice(0) : [];

  if (config.mode === 'ops_domain') {
    const runner = fs.existsSync(path.join(root, 'client', 'lib', 'ops_domain_conduit_runner.js'))
      ? path.join(root, 'client', 'lib', 'ops_domain_conduit_runner.js')
      : path.join(root, 'lib', 'ops_domain_conduit_runner.js');
    const commandArgs = [runner, '--domain', config.domain].concat(passArgs);
    const run = spawnSync(process.execPath, commandArgs, {
      cwd: root,
      encoding: 'utf8',
      env: defaultEnv(),
      stdio: cliMode && config.inheritStdio ? 'inherit' : undefined
    });

    const status = normalizeStatus(run.status);
    const stdout = run.stdout || '';
    const stderr = run.stderr || '';
    const payload = cliMode && config.inheritStdio ? null : parseJsonPayload(stdout);

    return {
      ok: status === 0,
      status,
      stdout,
      stderr,
      payload,
      lane: config.lane,
      rust_command: process.execPath,
      rust_args: commandArgs,
      routed_via: 'conduit'
    };
  }

  if (config.mode === 'manifest_binary') {
    const payload = {
      ok: false,
      type: 'conduit_only_enforced',
      reason: 'direct_manifest_binary_execution_blocked_route_via_conduit',
      lane: config.lane,
      manifest_path: config.manifestPath,
      binary_name: config.binaryName
    };
    return {
      ok: false,
      status: 1,
      stdout: cliMode && config.inheritStdio ? '' : JSON.stringify(payload),
      stderr: 'conduit_only_enforced',
      payload,
      lane: config.lane,
      rust_command: null,
      rust_args: [],
      routed_via: 'conduit_policy'
    };
  }

  throw new Error('invalid_rust_lane_bridge_config');
}

function runCliWithOutput(out, inheritStdio) {
  if (!inheritStdio) {
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
  }
  process.exit(out.status);
}

function createOpsLaneBridge(scriptDir, lane, domain, opts = {}) {
  const config = {
    scriptDir,
    lane,
    domain: String(domain || '').trim(),
    mode: 'ops_domain',
    inheritStdio: opts.inheritStdio === true
  };

  function run(args = []) {
    return runBridge(config, args, false);
  }

  function runCli(args = []) {
    const out = runBridge(config, args, config.inheritStdio === true);
    runCliWithOutput(out, config.inheritStdio);
  }

  return {
    lane,
    run,
    runCli
  };
}

function createManifestLaneBridge(scriptDir, lane, options) {
  const config = {
    scriptDir,
    lane,
    manifestPath: options.manifestPath,
    binaryName: options.binaryName,
    binaryEnvVar: options.binaryEnvVar,
    preArgs: options.preArgs || [],
    mode: 'manifest_binary',
    inheritStdio: options.inheritStdio === true
  };

  function run(args = []) {
    return runBridge(config, args, false);
  }

  function runCli(args = []) {
    const out = runBridge(config, args, config.inheritStdio === true);
    runCliWithOutput(out, config.inheritStdio);
  }

  return {
    lane,
    run,
    runCli
  };
}

module.exports = {
  createOpsLaneBridge,
  createManifestLaneBridge
};
