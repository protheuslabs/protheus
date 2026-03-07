#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-173
 * role_based_crew_orchestrator lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_173_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_173_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'role_based_crew_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/spawn/role_based_crew_orchestrator.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/spawn/role_based_crew_orchestrator.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/spawn/role_based_crew_orchestrator.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-173',
  script_rel: 'systems/spawn/role_based_crew_orchestrator.js',
  policy_path: POLICY_PATH,
  stream: 'spawn.role_based_crew',
  paths: {
    memory_dir: 'memory/crews',
    adaptive_index_path: 'adaptive/crews/index.json',
    events_path: 'state/spawn\/role_based_crew/events.jsonl',
    latest_path: 'state/spawn\/role_based_crew/latest.json',
    receipts_path: 'state/spawn\/role_based_crew/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'role_based_crew_orchestrator_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-173',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
