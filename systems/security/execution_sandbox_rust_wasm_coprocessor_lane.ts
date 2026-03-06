#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');
const { normalizeToken, cleanText, toBool, readJson, resolvePath } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.EXECUTION_SANDBOX_RUST_WASM_COPROCESSOR_LANE_POLICY_PATH
  ? path.resolve(process.env.EXECUTION_SANDBOX_RUST_WASM_COPROCESSOR_LANE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'execution_sandbox_rust_wasm_coprocessor_lane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/execution_sandbox_rust_wasm_coprocessor_lane.js configure --owner=<id> [--profile=default]');
  console.log('  node systems/security/execution_sandbox_rust_wasm_coprocessor_lane.js verify --owner=<id> [--strict=1] [--apply=1] [--mock=1]');
  console.log('  node systems/security/execution_sandbox_rust_wasm_coprocessor_lane.js status');
}

function runProbe(scriptPath: string, args: string[]) {
  const proc = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: path.resolve(__dirname, '..', '..'),
    encoding: 'utf8'
  });
  return {
    ok: Number(proc.status) === 0,
    status: Number(proc.status),
    stderr: String(proc.stderr || '').trim(),
    stdout: String(proc.stdout || '').trim()
  };
}

runStandardLane({
  lane_id: 'V3-RACE-186',
  script_rel: 'systems/security/execution_sandbox_rust_wasm_coprocessor_lane.js',
  policy_path: POLICY_PATH,
  stream: 'security.execution_sandbox_rust_wasm_coprocessor',
  paths: {
    memory_dir: 'memory/security/execution_sandbox_rust_wasm_coprocessor_lane',
    adaptive_index_path: 'adaptive/security/execution_sandbox_rust_wasm_coprocessor_lane/index.json',
    events_path: 'state/security/execution_sandbox_rust_wasm_coprocessor_lane/events.jsonl',
    latest_path: 'state/security/execution_sandbox_rust_wasm_coprocessor_lane/latest.json',
    receipts_path: 'state/security/execution_sandbox_rust_wasm_coprocessor_lane/receipts.jsonl'
  },
  usage,
  handlers: {
    verify(policy: any, args: any, ctx: any) {
      const raw = readJson(String(args.policy || POLICY_PATH), {});
      const enabled = raw.enable_coprocessor !== false;
      if (!enabled) {
        return { ok: false, error: 'coprocessor_disabled' };
      }

      const mock = toBool(args.mock, false);
      const sandboxScript = resolvePath(raw.sandbox_script, 'systems/security/execution_sandbox_envelope.js');
      const wasmScript = resolvePath(raw.wasm_runtime_script, 'systems/wasm/component_runtime.js');

      const sandboxProbe = mock
        ? { ok: true, status: 0, stdout: '{"ok":true,"mock":true}', stderr: '' }
        : runProbe(sandboxScript, ['status']);
      const wasmProbe = mock
        ? { ok: true, status: 0, stdout: '{"ok":true,"mock":true}', stderr: '' }
        : runProbe(wasmScript, ['status']);

      const pass = sandboxProbe.ok && wasmProbe.ok;
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'execution_sandbox_rust_wasm_coprocessor_verify',
        action: 'record',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-186',
          pass,
          mock,
          sandbox_script: cleanText(sandboxScript, 260),
          wasm_runtime_script: cleanText(wasmScript, 260),
          sandbox_probe: sandboxProbe,
          wasm_probe: wasmProbe
        })
      });
    }
  }
});
