#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-059
 * Sovereign Decommission Legacy and Succession Boundary Protocol
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.SOVEREIGN_DECOMMISSION_SUCCESSION_PROTOCOL_POLICY_PATH
  ? path.resolve(process.env.SOVEREIGN_DECOMMISSION_SUCCESSION_PROTOCOL_POLICY_PATH)
  : path.join(ROOT, 'config/sovereign_decommission_succession_protocol_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-059',
  title: 'Sovereign Decommission Legacy and Succession Boundary Protocol',
  type: 'sovereign_decommission_succession_protocol',
  default_action: 'decommission',
  script_label: 'systems/continuity/sovereign_decommission_succession_protocol.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "cryptographic_handoff",
        "description": "Cryptographic handoff protocol active"
    },
    {
        "id": "archival_freeze_mode",
        "description": "Archival lock/freeze mode available"
    },
    {
        "id": "verified_decommission_receipts",
        "description": "Verified decommission receipts emitted"
    },
    {
        "id": "succession_boundary_contract",
        "description": "Succession boundary contract enforced"
    }
],
    paths: {
      state_path: 'state/continuity/sovereign_decommission_succession_protocol/state.json',
      latest_path: 'state/continuity/sovereign_decommission_succession_protocol/latest.json',
      receipts_path: 'state/continuity/sovereign_decommission_succession_protocol/receipts.jsonl',
      history_path: 'state/continuity/sovereign_decommission_succession_protocol/history.jsonl'
    }
  }
});
