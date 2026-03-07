#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-151
 * ai_multimodel_data_plane lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_151_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_151_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'ai_multimodel_data_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/data/ai_multimodel_data_plane.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/data/ai_multimodel_data_plane.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/data/ai_multimodel_data_plane.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-151',
  script_rel: 'systems/data/ai_multimodel_data_plane.js',
  policy_path: POLICY_PATH,
  stream: 'data.ai_multimodel',
  paths: {
    memory_dir: 'memory/data/preferences',
    adaptive_index_path: 'adaptive/data/index.json',
    events_path: 'state/data\/ai_multimodel/events.jsonl',
    latest_path: 'state/data\/ai_multimodel/latest.json',
    receipts_path: 'state/data\/ai_multimodel/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'ai_multimodel_data_plane_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-151',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
