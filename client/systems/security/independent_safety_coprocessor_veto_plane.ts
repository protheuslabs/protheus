#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-050
 * Independent Safety Coprocessor and Out-of-Band Veto Plane
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.INDEPENDENT_SAFETY_COPROCESSOR_VETO_PLANE_POLICY_PATH
  ? path.resolve(process.env.INDEPENDENT_SAFETY_COPROCESSOR_VETO_PLANE_POLICY_PATH)
  : path.join(ROOT, 'config/independent_safety_coprocessor_veto_plane_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-050',
  title: 'Independent Safety Coprocessor and Out-of-Band Veto Plane',
  type: 'independent_safety_coprocessor_veto_plane',
  default_action: 'veto',
  script_label: 'systems/security/independent_safety_coprocessor_veto_plane.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "independent_guardian_runtime",
        "description": "Independent guardian runtime online"
    },
    {
        "id": "out_of_band_veto_channel",
        "description": "Out-of-band veto channel operational"
    },
    {
        "id": "kill_revert_authority",
        "description": "Guardian can halt and revert unsafe actions"
    },
    {
        "id": "non_bypass_contract",
        "description": "Bypass resistance checks pass"
    }
],
    paths: {
      state_path: 'state/security/independent_safety_coprocessor_veto_plane/state.json',
      latest_path: 'state/security/independent_safety_coprocessor_veto_plane/latest.json',
      receipts_path: 'state/security/independent_safety_coprocessor_veto_plane/receipts.jsonl',
      history_path: 'state/security/independent_safety_coprocessor_veto_plane/history.jsonl'
    }
  }
});
