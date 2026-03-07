#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-138
 * WASM component runtime lane.
 */

const path = require('path');
const { normalizeToken, stableHash } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.WASM_COMPONENT_RUNTIME_POLICY_PATH
  ? path.resolve(process.env.WASM_COMPONENT_RUNTIME_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'wasm_component_runtime_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/wasm/component_runtime.js configure --owner=<owner_id> [--module-preference=<name>]');
  console.log('  node systems/wasm/component_runtime.js load --owner=<owner_id> --module=<module_id> --manifest-hash=<sha> [--risk-tier=2]');
  console.log('  node systems/wasm/component_runtime.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-138',
  script_rel: 'systems/wasm/component_runtime.js',
  policy_path: POLICY_PATH,
  stream: 'wasm.component_runtime',
  paths: {
    memory_dir: 'memory/wasm',
    adaptive_index_path: 'adaptive/wasm/index.json',
    events_path: 'state/wasm/component_runtime/events.jsonl',
    latest_path: 'state/wasm/component_runtime/latest.json',
    receipts_path: 'state/wasm/component_runtime/receipts.jsonl'
  },
  usage,
  handlers: {
    load(policy: any, args: any, ctx: any) {
      const moduleId = normalizeToken(args.module || args.module_id, 120);
      const manifestHash = normalizeToken(args['manifest-hash'] || args.manifest_hash, 120);
      if (!moduleId || !manifestHash) {
        return { ok: false, error: 'missing_module_or_manifest_hash' };
      }
      const capabilityManifestId = `cap_${stableHash(`${moduleId}|${manifestHash}`, 16)}`;
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'wasm_component_load',
        payload_json: JSON.stringify({
          module_id: moduleId,
          manifest_hash: manifestHash,
          capability_manifest_id: capabilityManifestId,
          signature_verification: true,
          host_bindings_mode: 'deny_by_default'
        })
      });
    }
  }
});
