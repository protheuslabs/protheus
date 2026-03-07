#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-039
 * Human-Machine Merge Interface Security Substrate
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.HUMAN_MACHINE_MERGE_INTERFACE_SECURITY_SUBSTRATE_POLICY_PATH
  ? path.resolve(process.env.HUMAN_MACHINE_MERGE_INTERFACE_SECURITY_SUBSTRATE_POLICY_PATH)
  : path.join(ROOT, 'config/human_machine_merge_interface_security_substrate_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-039',
  title: 'Human-Machine Merge Interface Security Substrate',
  type: 'human_machine_merge_interface_security_substrate',
  default_action: 'merge',
  script_label: 'systems/continuity/human_machine_merge_interface_security_substrate.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "consent_ceremony_gate",
        "description": "Consent ceremony required for merge channel"
    },
    {
        "id": "identity_lock_channel",
        "description": "Identity lock keeps merge channel sovereign"
    },
    {
        "id": "rollback_killswitch",
        "description": "Rollback and kill-switch path available"
    },
    {
        "id": "hostile_interface_tests",
        "description": "Hostile interface simulation suite passes"
    }
],
    paths: {
      state_path: 'state/continuity/human_machine_merge_interface_security_substrate/state.json',
      latest_path: 'state/continuity/human_machine_merge_interface_security_substrate/latest.json',
      receipts_path: 'state/continuity/human_machine_merge_interface_security_substrate/receipts.jsonl',
      history_path: 'state/continuity/human_machine_merge_interface_security_substrate/history.jsonl'
    }
  }
});
