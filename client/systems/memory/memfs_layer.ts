#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-161
 * memfs_layer lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_161_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_161_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'memfs_layer_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/memfs_layer.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/memory/memfs_layer.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/memory/memfs_layer.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-161',
  script_rel: 'systems/memory/memfs_layer.js',
  policy_path: POLICY_PATH,
  stream: 'memory.memfs',
  paths: {
    memory_dir: 'memory/fs',
    adaptive_index_path: 'adaptive/memory/fs/index.json',
    events_path: 'state/memory\/memfs/events.jsonl',
    latest_path: 'state/memory\/memfs/latest.json',
    receipts_path: 'state/memory\/memfs/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'memfs_layer_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-161',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
