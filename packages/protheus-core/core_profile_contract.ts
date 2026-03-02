#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-169
 * Core profile contract lane for user defaults.
 */

const path = require('path');
const { normalizeToken } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.PROTHEUS_CORE_PROFILE_POLICY_PATH
  ? path.resolve(process.env.PROTHEUS_CORE_PROFILE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'protheus_core_profile_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node packages/protheus-core/core_profile_contract.js configure --owner=<owner_id> [--mode=lite]');
  console.log('  node packages/protheus-core/core_profile_contract.js bootstrap --owner=<owner_id> [--mode=lite]');
  console.log('  node packages/protheus-core/core_profile_contract.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-169',
  script_rel: 'packages/protheus-core/core_profile_contract.js',
  policy_path: POLICY_PATH,
  stream: 'core.profiles',
  paths: {
    memory_dir: 'memory/core_profiles',
    adaptive_index_path: 'adaptive/core_profiles/index.json',
    events_path: 'state/core/profiles/events.jsonl',
    latest_path: 'state/core/profiles/latest.json',
    receipts_path: 'state/core/profiles/receipts.jsonl'
  },
  usage,
  handlers: {
    bootstrap(policy: any, args: any, ctx: any) {
      const mode = normalizeToken(args.mode || 'lite', 40) || 'lite';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'core_profile_bootstrap',
        payload_json: JSON.stringify({
          mode,
          one_command_starter: true,
          optional_heavy_layers: false
        })
      });
    }
  }
});
