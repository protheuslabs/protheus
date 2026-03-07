#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-155
 * fractal_training_oversight lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_155_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_155_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'fractal_training_oversight_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/training/fractal_training_oversight.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/training/fractal_training_oversight.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/training/fractal_training_oversight.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-155',
  script_rel: 'systems/training/fractal_training_oversight.js',
  policy_path: POLICY_PATH,
  stream: 'training.fractal_oversight',
  paths: {
    memory_dir: 'memory/training/preferences',
    adaptive_index_path: 'adaptive/training/curriculum/index.json',
    events_path: 'state/training\/fractal_oversight/events.jsonl',
    latest_path: 'state/training\/fractal_oversight/latest.json',
    receipts_path: 'state/training\/fractal_oversight/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'fractal_training_oversight_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-155',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
