#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-171
 * cyclic_strategy_graph_runner lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_171_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_171_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'cyclic_strategy_graph_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/strategy/cyclic_strategy_graph_runner.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/strategy/cyclic_strategy_graph_runner.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/strategy/cyclic_strategy_graph_runner.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-171',
  script_rel: 'systems/strategy/cyclic_strategy_graph_runner.js',
  policy_path: POLICY_PATH,
  stream: 'strategy.cyclic_graph',
  paths: {
    memory_dir: 'memory/strategy/graphs',
    adaptive_index_path: 'adaptive/strategy/graphs/index.json',
    events_path: 'state/strategy\/cyclic_graph/events.jsonl',
    latest_path: 'state/strategy\/cyclic_graph/latest.json',
    receipts_path: 'state/strategy\/cyclic_graph/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'cyclic_strategy_graph_runner_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-171',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
