#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-133
 * Peer GPU lending marketplace lane.
 */

const path = require('path');
const {
  normalizeToken,
  clampNumber
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');
const { recordPeerLendingEvent } = require('./gpu_contribution_tracker.js');

const POLICY_PATH = process.env.PEER_LENDING_MARKET_POLICY_PATH
  ? path.resolve(process.env.PEER_LENDING_MARKET_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'peer_lending_market_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/economy/peer_lending_market.js configure --owner=<owner_id> [--allowlist=a,b] [--min-credit=0.1]');
  console.log('  node systems/economy/peer_lending_market.js lend --lender=<owner_id> --borrower=<owner_id> --gpu-hours=<hours> [--credit-rate=<n>] [--risk-tier=2]');
  console.log('  node systems/economy/peer_lending_market.js settle --lender=<owner_id> --borrower=<owner_id> --settlement-credit=<n> [--risk-tier=2]');
  console.log('  node systems/economy/peer_lending_market.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-133',
  script_rel: 'systems/economy/peer_lending_market.js',
  policy_path: POLICY_PATH,
  stream: 'economy.peer_lending',
  paths: {
    memory_dir: 'memory/economy/peer_lending',
    adaptive_index_path: 'adaptive/economy/peer_lending/index.json',
    events_path: 'state/economy/peer_lending/events.jsonl',
    latest_path: 'state/economy/peer_lending/latest.json',
    receipts_path: 'state/economy/peer_lending/receipts.jsonl'
  },
  usage,
  handlers: {
    lend(policy: any, args: any, ctx: any) {
      const lender = normalizeToken(args.lender || args.owner || args.owner_id, 120);
      const borrower = normalizeToken(args.borrower, 120);
      const gpuHours = clampNumber(args['gpu-hours'] != null ? args['gpu-hours'] : args.gpu_hours, 0.0001, 1_000_000, 0);
      const creditRate = clampNumber(args['credit-rate'] != null ? args['credit-rate'] : args.credit_rate, 0, 100000, 0);
      if (!lender || !borrower || gpuHours <= 0) {
        return { ok: false, error: 'missing_lender_borrower_or_gpu_hours' };
      }
      const settlementCredit = Number((gpuHours * creditRate).toFixed(6));
      recordPeerLendingEvent(policy, {
        kind: 'lend',
        lender_id: lender,
        borrower_id: borrower,
        gpu_hours: gpuHours,
        credit_rate: creditRate,
        settlement_credit: settlementCredit,
        contract_ref: normalizeToken(args.contract_ref || '', 120) || null
      });
      return ctx.cmdRecord(policy, {
        ...args,
        owner: lender,
        event: 'peer_lending_lend',
        payload_json: JSON.stringify({
          lender_id: lender,
          borrower_id: borrower,
          gpu_hours: gpuHours,
          credit_rate: creditRate,
          settlement_credit: settlementCredit
        })
      });
    },
    settle(policy: any, args: any, ctx: any) {
      const lender = normalizeToken(args.lender || '', 120);
      const borrower = normalizeToken(args.borrower || '', 120);
      const settlementCredit = clampNumber(
        args['settlement-credit'] != null ? args['settlement-credit'] : args.settlement_credit,
        0,
        1_000_000_000,
        0
      );
      if (!lender || !borrower || settlementCredit < 0) {
        return { ok: false, error: 'missing_settlement_fields' };
      }
      recordPeerLendingEvent(policy, {
        kind: 'settle',
        lender_id: lender,
        borrower_id: borrower,
        settlement_credit: settlementCredit,
        settlement_ref: normalizeToken(args.settlement_ref || '', 120) || null
      });
      return ctx.cmdRecord(policy, {
        ...args,
        owner: lender,
        event: 'peer_lending_settle',
        payload_json: JSON.stringify({
          lender_id: lender,
          borrower_id: borrower,
          settlement_credit: settlementCredit
        })
      });
    }
  }
});
