#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-055
 * Insider-Threat Split-Trust Command Governance
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.INSIDER_THREAT_SPLIT_TRUST_COMMAND_GOVERNANCE_POLICY_PATH
  ? path.resolve(process.env.INSIDER_THREAT_SPLIT_TRUST_COMMAND_GOVERNANCE_POLICY_PATH)
  : path.join(ROOT, 'config/insider_threat_split_trust_command_governance_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-055',
  title: 'Insider-Threat Split-Trust Command Governance',
  type: 'insider_threat_split_trust_command_governance',
  default_action: 'approve',
  script_label: 'systems/security/insider_threat_split_trust_command_governance.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "threshold_quorum_requirements",
        "description": "Threshold quorum required for irreversible actions"
    },
    {
        "id": "out_of_band_confirmation",
        "description": "Independent confirmation channel enforced"
    },
    {
        "id": "irreversible_action_guard",
        "description": "High-impact command guard active"
    },
    {
        "id": "deny_without_quorum",
        "description": "Denial-by-default when quorum missing"
    }
],
    paths: {
      state_path: 'state/security/insider_threat_split_trust_command_governance/state.json',
      latest_path: 'state/security/insider_threat_split_trust_command_governance/latest.json',
      receipts_path: 'state/security/insider_threat_split_trust_command_governance/receipts.jsonl',
      history_path: 'state/security/insider_threat_split_trust_command_governance/history.jsonl'
    }
  }
});
