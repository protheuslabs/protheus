#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-152
 * webgpu_rust_compute_plane lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_152_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_152_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'webgpu_rust_compute_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/client/webgpu_rust_compute_plane.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/client/webgpu_rust_compute_plane.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/client/webgpu_rust_compute_plane.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-152',
  script_rel: 'systems/client/webgpu_rust_compute_plane.js',
  policy_path: POLICY_PATH,
  stream: 'client.webgpu_rust',
  paths: {
    memory_dir: 'memory/client_compute',
    adaptive_index_path: 'adaptive/client_compute/index.json',
    events_path: 'state/client\/webgpu_rust/events.jsonl',
    latest_path: 'state/client\/webgpu_rust/latest.json',
    receipts_path: 'state/client\/webgpu_rust/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'webgpu_rust_compute_plane_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-152',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
