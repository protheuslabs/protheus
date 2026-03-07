#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-143
 * FHE encrypted compute pilot lane.
 */

const path = require('path');
const { normalizeToken, cleanText, clampNumber } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.FHE_ENCRYPTED_COMPUTE_POLICY_PATH
  ? path.resolve(process.env.FHE_ENCRYPTED_COMPUTE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'fhe_encrypted_compute_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/crypto/fhe_encrypted_compute_pilot.js configure --owner=<owner_id> [--operator=bfv]');
  console.log('  node systems/crypto/fhe_encrypted_compute_pilot.js compute --owner=<owner_id> --operation=<sum|mean|max> --payload=\"...\" [--risk-tier=2]');
  console.log('  node systems/crypto/fhe_encrypted_compute_pilot.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-143',
  script_rel: 'systems/crypto/fhe_encrypted_compute_pilot.js',
  policy_path: POLICY_PATH,
  stream: 'crypto.fhe_pilot',
  paths: {
    memory_dir: 'memory/crypto/fhe',
    adaptive_index_path: 'adaptive/crypto/fhe/index.json',
    events_path: 'state/crypto/fhe_pilot/events.jsonl',
    latest_path: 'state/crypto/fhe_pilot/latest.json',
    receipts_path: 'state/crypto/fhe_pilot/receipts.jsonl'
  },
  usage,
  handlers: {
    compute(policy: any, args: any, ctx: any) {
      const owner = normalizeToken(args.owner || args.owner_id, 120);
      const operation = normalizeToken(args.operation || '', 80);
      const payload = cleanText(args.payload || '', 4000);
      if (!owner || !operation || !payload) return { ok: false, error: 'missing_owner_operation_or_payload' };
      const allowlist = Array.isArray(policy.allowlisted_operations) ? policy.allowlisted_operations : ['sum', 'mean'];
      if (!allowlist.includes(operation)) {
        return {
          ok: false,
          error: 'operation_not_allowlisted',
          operation,
          allowlisted_operations: allowlist
        };
      }
      const latencyBudgetMs = clampNumber(args['latency-budget-ms'] != null ? args['latency-budget-ms'] : args.latency_budget_ms, 1, 600000, 2000);
      return ctx.cmdRecord(policy, {
        ...args,
        owner,
        event: 'fhe_compute',
        payload_json: JSON.stringify({
          operation,
          encrypted_payload_ref: `enc_${owner}_${operation}`,
          allowlist_enforced: true,
          latency_budget_ms: latencyBudgetMs,
          fallback_contract: 'plaintext_fallback_with_receipt',
          deterministic_failure_handling: true
        })
      });
    }
  }
});
