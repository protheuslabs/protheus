#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-054
 * Adversarial Goal-Drift Auditor
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.ADVERSARIAL_GOAL_DRIFT_AUDITOR_POLICY_PATH
  ? path.resolve(process.env.ADVERSARIAL_GOAL_DRIFT_AUDITOR_POLICY_PATH)
  : path.join(ROOT, 'config/adversarial_goal_drift_auditor_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-054',
  title: 'Adversarial Goal-Drift Auditor',
  type: 'adversarial_goal_drift_auditor',
  default_action: 'audit',
  script_label: 'systems/security/adversarial_goal_drift_auditor.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "independent_objective_lens",
        "description": "Second-lens objective auditor active"
    },
    {
        "id": "goodhart_detection",
        "description": "Goodhart drift detection contract enabled"
    },
    {
        "id": "covenant_misalignment_veto",
        "description": "Covenant misalignment veto available"
    },
    {
        "id": "promotion_apply_block",
        "description": "Promotion/apply blocked on adversarial fail"
    }
],
    paths: {
      state_path: 'state/security/adversarial_goal_drift_auditor/state.json',
      latest_path: 'state/security/adversarial_goal_drift_auditor/latest.json',
      receipts_path: 'state/security/adversarial_goal_drift_auditor/receipts.jsonl',
      history_path: 'state/security/adversarial_goal_drift_auditor/history.jsonl'
    }
  }
});
