#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-168
 * Background hands scheduler lane.
 */

const path = require('path');
const { normalizeToken } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.BACKGROUND_HANDS_SCHEDULER_POLICY_PATH
  ? path.resolve(process.env.BACKGROUND_HANDS_SCHEDULER_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'background_hands_scheduler_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/spine/background_hands_scheduler.js configure --owner=<owner_id> [--cadence=hourly]');
  console.log('  node systems/spine/background_hands_scheduler.js schedule --owner=<owner_id> [--task=queue_gc] [--risk-tier=2]');
  console.log('  node systems/spine/background_hands_scheduler.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-168',
  script_rel: 'systems/spine/background_hands_scheduler.js',
  policy_path: POLICY_PATH,
  stream: 'spine.background_hands',
  paths: {
    memory_dir: 'memory/ops/preferences',
    adaptive_index_path: 'adaptive/ops/index.json',
    events_path: 'state/spine/background_hands/events.jsonl',
    latest_path: 'state/spine/background_hands/latest.json',
    receipts_path: 'state/spine/background_hands/receipts.jsonl'
  },
  usage,
  handlers: {
    schedule(policy: any, args: any, ctx: any) {
      const task = normalizeToken(args.task || 'queue_gc', 120) || 'queue_gc';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'background_hand_schedule',
        payload_json: JSON.stringify({
          task,
          rollback_safe_control: true,
          non_bypass_integrity: true,
          adaptive_cadence_enabled: true
        })
      });
    }
  }
});
