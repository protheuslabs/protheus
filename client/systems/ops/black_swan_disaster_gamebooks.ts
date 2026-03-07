#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-057
 * Black-Swan Disaster Gamebooks and Continuous Resilience Drills
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.BLACK_SWAN_DISASTER_GAMEBOOKS_POLICY_PATH
  ? path.resolve(process.env.BLACK_SWAN_DISASTER_GAMEBOOKS_POLICY_PATH)
  : path.join(ROOT, 'config/black_swan_disaster_gamebooks_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-057',
  title: 'Black-Swan Disaster Gamebooks and Continuous Resilience Drills',
  type: 'black_swan_disaster_gamebooks',
  default_action: 'drill',
  script_label: 'systems/ops/black_swan_disaster_gamebooks.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "scenario_library",
        "description": "Black-swan scenario library defined"
    },
    {
        "id": "scheduled_resilience_drills",
        "description": "Scheduled drill cadence in policy"
    },
    {
        "id": "recovery_slo_measurement",
        "description": "Recovery SLO measurement enabled"
    },
    {
        "id": "remediation_closure_tracking",
        "description": "Remediation closure tracker active"
    }
],
    paths: {
      state_path: 'state/ops/black_swan_disaster_gamebooks/state.json',
      latest_path: 'state/ops/black_swan_disaster_gamebooks/latest.json',
      receipts_path: 'state/ops/black_swan_disaster_gamebooks/receipts.jsonl',
      history_path: 'state/ops/black_swan_disaster_gamebooks/history.jsonl'
    }
  }
});
