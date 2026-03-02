#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-153
 * collective_training_orchestrator lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_153_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_153_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'collective_training_orchestrator_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/training/collective_training_orchestrator.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/training/collective_training_orchestrator.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/training/collective_training_orchestrator.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-153',
  script_rel: 'systems/training/collective_training_orchestrator.js',
  policy_path: POLICY_PATH,
  stream: 'training.collective_orchestrator',
  paths: {
    memory_dir: 'memory/training/contributions',
    adaptive_index_path: 'adaptive/training/contributions/index.json',
    events_path: 'state/training\/collective_orchestrator/events.jsonl',
    latest_path: 'state/training\/collective_orchestrator/latest.json',
    receipts_path: 'state/training\/collective_orchestrator/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'collective_training_orchestrator_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-153',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
