#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-137
 * CRDT local-first state plane.
 */

const path = require('path');
const { normalizeToken } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.CRDT_STATE_PLANE_POLICY_PATH
  ? path.resolve(process.env.CRDT_STATE_PLANE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'crdt_state_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/pinnacle/crdt_state_plane.js configure --owner=<owner_id> [--domain=soul]');
  console.log('  node systems/pinnacle/crdt_state_plane.js reconcile --owner=<owner_id> --domain=<soul|memory|contract> [--risk-tier=2]');
  console.log('  node systems/pinnacle/crdt_state_plane.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-137',
  script_rel: 'systems/pinnacle/crdt_state_plane.js',
  policy_path: POLICY_PATH,
  stream: 'pinnacle.crdt_state_plane',
  paths: {
    memory_dir: 'memory/crdt',
    adaptive_index_path: 'adaptive/crdt/index.json',
    events_path: 'state/pinnacle/crdt_state_plane/events.jsonl',
    latest_path: 'state/pinnacle/crdt_state_plane/latest.json',
    receipts_path: 'state/pinnacle/crdt_state_plane/receipts.jsonl'
  },
  usage,
  handlers: {
    reconcile(policy: any, args: any, ctx: any) {
      const domain = normalizeToken(args.domain || 'memory', 40) || 'memory';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'crdt_reconcile',
        payload_json: JSON.stringify({
          domain,
          reconciliation_rule: 'last_writer_wins_with_vector_clock_tie_break',
          replay_parity_check: true,
          jetstream_receipt_required: true
        })
      });
    }
  }
});
