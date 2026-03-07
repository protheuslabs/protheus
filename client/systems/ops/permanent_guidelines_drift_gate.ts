#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-CONF-007
 * Permanent Guidelines Drift Gate and Ticket Output Contract
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.PERMANENT_GUIDELINES_DRIFT_GATE_POLICY_PATH
  ? path.resolve(process.env.PERMANENT_GUIDELINES_DRIFT_GATE_POLICY_PATH)
  : path.join(ROOT, 'config/permanent_guidelines_drift_gate_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-CONF-007',
  title: 'Permanent Guidelines Drift Gate and Ticket Output Contract',
  type: 'permanent_guidelines_drift_gate',
  default_action: 'verify',
  script_label: 'systems/ops/permanent_guidelines_drift_gate.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "canonical_guidelines_artifact",
        "description": "Canonical permanent guidelines artifact exists",
        "file_must_exist": "docs/PERMANENT_GUIDELINES.md"
    },
    {
        "id": "checksum_drift_gate",
        "description": "Checksum drift checker configured"
    },
    {
        "id": "ticket_output_contract",
        "description": "Ticket output contract markers enforced",
        "file_must_exist": "config/ticket_output_contract.json"
    },
    {
        "id": "ci_fail_on_divergence",
        "description": "CI fails on governance drift divergence"
    }
],
    paths: {
      state_path: 'state/ops/permanent_guidelines_drift_gate/state.json',
      latest_path: 'state/ops/permanent_guidelines_drift_gate/latest.json',
      receipts_path: 'state/ops/permanent_guidelines_drift_gate/receipts.jsonl',
      history_path: 'state/ops/permanent_guidelines_drift_gate/history.jsonl'
    }
  }
});
