#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-147
 * activitypub_matrix_gateway lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_147_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_147_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'activitypub_matrix_gateway_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/federation/activitypub_matrix_gateway.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/federation/activitypub_matrix_gateway.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/federation/activitypub_matrix_gateway.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-147',
  script_rel: 'systems/federation/activitypub_matrix_gateway.js',
  policy_path: POLICY_PATH,
  stream: 'federation.activitypub_matrix',
  paths: {
    memory_dir: 'memory/federation/channels',
    adaptive_index_path: 'adaptive/federation/channels/index.json',
    events_path: 'state/federation\/activitypub_matrix/events.jsonl',
    latest_path: 'state/federation\/activitypub_matrix/latest.json',
    receipts_path: 'state/federation\/activitypub_matrix/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'activitypub_matrix_gateway_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-147',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
