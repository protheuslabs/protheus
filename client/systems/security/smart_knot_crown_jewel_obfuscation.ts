#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-DEF-025
 * Smart Knot Crown-Jewel Obfuscation Layer
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.SMART_KNOT_CROWN_JEWEL_OBFUSCATION_POLICY_PATH
  ? path.resolve(process.env.SMART_KNOT_CROWN_JEWEL_OBFUSCATION_POLICY_PATH)
  : path.join(ROOT, 'config/smart_knot_crown_jewel_obfuscation_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-DEF-025',
  title: 'Smart Knot Crown-Jewel Obfuscation Layer',
  type: 'smart_knot_crown_jewel_obfuscation',
  default_action: 'verify',
  script_label: 'systems/security/smart_knot_crown_jewel_obfuscation.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "knot_pipeline_present",
        "description": "Knot build pipeline exists",
        "file_must_exist": "build/knot/knot_pipeline_manifest.json"
    },
    {
        "id": "crown_jewel_scope_enforced",
        "description": "Scope excludes open platform/habits/skills"
    },
    {
        "id": "capability_token_resolution",
        "description": "Runtime capability-token resolution enabled"
    },
    {
        "id": "perf_non_regression_guard",
        "description": "Performance guard rails configured"
    }
],
    paths: {
      state_path: 'state/security/smart_knot_crown_jewel_obfuscation/state.json',
      latest_path: 'state/security/smart_knot_crown_jewel_obfuscation/latest.json',
      receipts_path: 'state/security/smart_knot_crown_jewel_obfuscation/receipts.jsonl',
      history_path: 'state/security/smart_knot_crown_jewel_obfuscation/history.jsonl'
    }
  }
});
