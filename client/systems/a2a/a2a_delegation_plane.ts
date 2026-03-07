#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-166
 * a2a_delegation_plane lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_166_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_166_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'a2a_delegation_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/a2a/a2a_delegation_plane.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/a2a/a2a_delegation_plane.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/a2a/a2a_delegation_plane.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-166',
  script_rel: 'systems/a2a/a2a_delegation_plane.js',
  policy_path: POLICY_PATH,
  stream: 'federation.a2a_delegation',
  paths: {
    memory_dir: 'memory/federation/a2a',
    adaptive_index_path: 'adaptive/federation/a2a/index.json',
    events_path: 'state/federation\/a2a_delegation/events.jsonl',
    latest_path: 'state/federation\/a2a_delegation/latest.json',
    receipts_path: 'state/federation\/a2a_delegation/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'a2a_delegation_plane_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-166',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
