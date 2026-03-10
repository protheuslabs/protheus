#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/autonomy + core/layer0/ops::assimilation-controller (authoritative)
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

const bridge = createOpsLaneBridge(__dirname, 'assimilation_controller', 'assimilation-controller');

process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '60000';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';

function mapArgs(argv = []) {
  const cmd = String(argv[0] || 'status').trim().toLowerCase();
  if (cmd === 'run' || cmd === 'status' || cmd === 'assess' || cmd === 'record-use' || cmd === 'rollback') {
    return [cmd, ...argv.slice(1)];
  }
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') return ['help'];
  return ['status', ...argv];
}

function run(args = []) {
  try {
    return bridge.run(mapArgs(args));
  } catch (error) {
    return {
      status: 1,
      stdout: '',
      stderr: String(error && error.message ? error.message : error),
      payload: {
        ok: false,
        type: 'assimilation_controller_core_error',
        error: String(error && error.message ? error.message : error)
      }
    };
  }
}

if (require.main === module) {
  const out = run(process.argv.slice(2));
  if (out && out.stdout) process.stdout.write(out.stdout);
  else if (out && out.payload) process.stdout.write(`${JSON.stringify(out.payload)}\n`);
  if (out && out.stderr) process.stderr.write(out.stderr);
  process.exit(Number.isFinite(Number(out && out.status)) ? Number(out.status) : 1);
}

module.exports = { run };
