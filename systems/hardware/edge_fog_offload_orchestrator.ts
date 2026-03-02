#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-148
 * edge_fog_offload_orchestrator lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_148_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_148_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'edge_fog_offload_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/hardware/edge_fog_offload_orchestrator.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/hardware/edge_fog_offload_orchestrator.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/hardware/edge_fog_offload_orchestrator.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-148',
  script_rel: 'systems/hardware/edge_fog_offload_orchestrator.js',
  policy_path: POLICY_PATH,
  stream: 'hardware.edge_fog_offload',
  paths: {
    memory_dir: 'memory/compute/offload',
    adaptive_index_path: 'adaptive/compute/offload/index.json',
    events_path: 'state/hardware\/edge_fog_offload/events.jsonl',
    latest_path: 'state/hardware\/edge_fog_offload/latest.json',
    receipts_path: 'state/hardware\/edge_fog_offload/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'edge_fog_offload_orchestrator_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-148',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
