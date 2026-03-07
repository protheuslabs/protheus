#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-163
 * agentic_memory_operation_controller lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_163_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_163_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'agentic_memory_operation_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/memory/agentic_memory_operation_controller.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/memory/agentic_memory_operation_controller.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/memory/agentic_memory_operation_controller.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-163',
  script_rel: 'systems/memory/agentic_memory_operation_controller.js',
  policy_path: POLICY_PATH,
  stream: 'memory.agentic_ops',
  paths: {
    memory_dir: 'memory/memory_ops',
    adaptive_index_path: 'adaptive/memory_ops/index.json',
    events_path: 'state/memory\/agentic_ops/events.jsonl',
    latest_path: 'state/memory\/agentic_ops/latest.json',
    receipts_path: 'state/memory\/agentic_ops/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'agentic_memory_operation_controller_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-163',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
