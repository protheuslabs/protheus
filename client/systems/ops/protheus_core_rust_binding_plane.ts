#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-185
 * protheus-core Rust binding plane parity and fallback contract.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.PROTHEUS_CORE_RUST_BINDING_PLANE_POLICY_PATH
  ? path.resolve(process.env.PROTHEUS_CORE_RUST_BINDING_PLANE_POLICY_PATH)
  : path.join(ROOT, 'config', 'protheus_core_rust_binding_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/protheus_core_rust_binding_plane.js configure --owner=<owner_id>');
  console.log('  node systems/ops/protheus_core_rust_binding_plane.js verify --owner=<owner_id> [--mock=1] [--strict=1] [--apply=1]');
  console.log('  node systems/ops/protheus_core_rust_binding_plane.js status [--owner=<owner_id>]');
}

function parseJson(stdout) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runNode(scriptPath, args, timeoutMs, mock, label) {
  if (mock) {
    return {
      ok: true,
      status: 0,
      payload: { ok: true, type: `${normalizeToken(label || 'mock', 80) || 'mock'}_mock` },
      stderr: ''
    };
  }
  const run = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  return {
    ok: Number(run.status || 0) === 0,
    status: Number.isFinite(run.status) ? Number(run.status) : 1,
    payload: parseJson(run.stdout || ''),
    stderr: cleanText(run.stderr || '', 400)
  };
}

function resolveMaybe(rawPath, fallbackRel) {
  const txt = cleanText(rawPath || '', 420);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? path.resolve(txt) : path.join(ROOT, txt);
}

function rel(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function readState(policy) {
  return readJson(policy.paths.binding_state_path, {
    schema_id: 'protheus_core_rust_binding_plane_state',
    schema_version: '1.0',
    runs: 0,
    updated_at: null,
    last_result: null
  });
}

function writeState(policy, state) {
  fs.mkdirSync(path.dirname(policy.paths.binding_state_path), { recursive: true });
  writeJsonAtomic(policy.paths.binding_state_path, {
    schema_id: 'protheus_core_rust_binding_plane_state',
    schema_version: '1.0',
    runs: Number(state.runs || 0),
    updated_at: state.updated_at || nowIso(),
    last_result: state.last_result || null
  });
}

runStandardLane({
  lane_id: 'V3-RACE-185',
  script_rel: 'systems/ops/protheus_core_rust_binding_plane.js',
  policy_path: POLICY_PATH,
  stream: 'ops.protheus_core_rust_binding_plane',
  paths: {
    memory_dir: 'memory/ops/protheus_core_rust_binding_plane',
    adaptive_index_path: 'adaptive/ops/protheus_core_rust_binding_plane/index.json',
    events_path: 'state/ops/protheus_core_rust_binding_plane/events.jsonl',
    latest_path: 'state/ops/protheus_core_rust_binding_plane/latest.json',
    receipts_path: 'state/ops/protheus_core_rust_binding_plane/receipts.jsonl',
    binding_state_path: 'state/ops/protheus_core_rust_binding_plane/state.json'
  },
  usage,
  handlers: {
    verify(policy, args, ctx) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, true);
      const mock = toBool(args.mock, false);

      const coreModulePath = resolveMaybe(policy.core_module_path, 'packages/protheus-core/index.js');
      const shimScript = resolveMaybe(policy.rust_component_shim_script, 'systems/rust/control_plane_component_shim.js');
      const napiScript = resolveMaybe(policy.napi_surface_script, 'systems/memory/napi_build_surface_compat.js');
      const components = Array.isArray(policy.components)
        ? policy.components.map((row) => normalizeToken(row, 80)).filter(Boolean)
        : ['guard', 'spine_router', 'reflex_dispatcher', 'spawn_broker'];
      const requiredExports = Array.isArray(policy.required_exports)
        ? policy.required_exports.map((row) => cleanText(row, 120)).filter(Boolean)
        : ['coreStatus', 'coldStartContract', 'spineStatus', 'reflexStatus', 'gateStatus'];

      let exportedKeys = [];
      try {
        const coreMod = require(coreModulePath);
        exportedKeys = Object.keys(coreMod || {}).sort();
      } catch {
        exportedKeys = [];
      }

      const missingExports = requiredExports.filter((key) => exportedKeys.indexOf(key) === -1);
      const rustChecks = components.map((component) => {
        const run = runNode(shimScript, ['run', `--component=${component}`, '--engine=rust'], 120000, mock, `rust_probe_${component}`);
        return {
          component,
          ok: run.ok,
          status: run.status,
          payload_type: normalizeToken(run.payload && run.payload.type, 120) || null
        };
      });
      const tsChecks = components.map((component) => {
        const run = runNode(shimScript, ['run', `--component=${component}`, '--engine=js'], 120000, mock, `ts_probe_${component}`);
        return {
          component,
          ok: run.ok,
          status: run.status,
          payload_type: normalizeToken(run.payload && run.payload.type, 120) || null
        };
      });

      const parityOk = rustChecks.length > 0 && rustChecks.every((row, idx) => row.ok && tsChecks[idx] && tsChecks[idx].ok);
      const napiStatus = runNode(napiScript, ['status'], 120000, mock, 'napi_surface_status');
      const fallbackSupported = toBool(policy.fallback_to_ts_enabled, true);

      const allOk = missingExports.length === 0
        && parityOk
        && napiStatus.ok
        && fallbackSupported;

      if (apply) {
        const state = readState(policy);
        writeState(policy, {
          runs: Number(state.runs || 0) + 1,
          updated_at: nowIso(),
          last_result: {
            owner_id: ownerId,
            ts: nowIso(),
            ok: allOk,
            missing_exports: missingExports,
            rust_components: rustChecks.length
          }
        });
      }

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'protheus_core_rust_binding_plane_verify',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          all_ok: allOk,
          missing_exports: missingExports,
          exported_keys: exportedKeys,
          rust_checks: rustChecks,
          ts_checks: tsChecks,
          parity_ok: parityOk,
          napi_status_ok: napiStatus.ok,
          fallback_to_ts_enabled: fallbackSupported,
          paths: {
            core_module: rel(coreModulePath),
            rust_component_shim: rel(shimScript),
            napi_surface_script: rel(napiScript)
          }
        })
      });

      if (strict && !allOk) {
        return {
          ...receipt,
          ok: false,
          error: 'protheus_core_rust_binding_plane_failed',
          missing_exports: missingExports,
          parity_ok: parityOk,
          napi_status_ok: napiStatus.ok
        };
      }

      return {
        ...receipt,
        protheus_core_rust_binding_plane_ok: allOk,
        missing_exports: missingExports,
        parity_ok: parityOk
      };
    },

    status(policy, args, ctx) {
      const base = ctx.cmdStatus(policy, args);
      const state = readState(policy);
      return {
        ...base,
        binding_state: state,
        artifacts: {
          ...base.artifacts,
          binding_state_path: rel(policy.paths.binding_state_path)
        }
      };
    }
  }
});
