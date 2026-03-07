#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-172
 * hierarchical_memory_view_plane lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_172_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_172_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'hierarchical_memory_view_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/hierarchical_memory_view_plane.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/memory/hierarchical_memory_view_plane.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/memory/hierarchical_memory_view_plane.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-172',
  script_rel: 'systems/memory/hierarchical_memory_view_plane.js',
  policy_path: POLICY_PATH,
  stream: 'memory.hierarchical_views',
  paths: {
    memory_dir: 'memory/views',
    adaptive_index_path: 'adaptive/memory/views/index.json',
    events_path: 'state/memory\/hierarchical_views/events.jsonl',
    latest_path: 'state/memory\/hierarchical_views/latest.json',
    receipts_path: 'state/memory\/hierarchical_views/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'hierarchical_memory_view_plane_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-172',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
