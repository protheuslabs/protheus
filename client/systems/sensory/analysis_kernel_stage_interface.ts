#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-112
 * Analysis Kernel Stage Interface and Plugin Contracts
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.ANALYSIS_KERNEL_STAGE_INTERFACE_POLICY_PATH
  ? path.resolve(process.env.ANALYSIS_KERNEL_STAGE_INTERFACE_POLICY_PATH)
  : path.join(ROOT, 'config/analysis_kernel_stage_interface_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-112',
  title: 'Analysis Kernel Stage Interface and Plugin Contracts',
  type: 'analysis_kernel_stage_interface',
  default_action: 'emit',
  script_label: 'systems/sensory/analysis_kernel_stage_interface.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "stage_contract_interface",
        "description": "Detect->infer->calibrate->challenge->score->emit contract active"
    },
    {
        "id": "plugin_adapter_registry",
        "description": "Plugin adapter registry is live"
    },
    {
        "id": "baseline_detector_parity",
        "description": "Baseline detector outputs parity harness passes"
    },
    {
        "id": "kernel_regression_harness",
        "description": "Regression harness emits deterministic receipts"
    }
],
    paths: {
      state_path: 'state/sensory/analysis_kernel_stage_interface/state.json',
      latest_path: 'state/sensory/analysis_kernel_stage_interface/latest.json',
      receipts_path: 'state/sensory/analysis_kernel_stage_interface/receipts.jsonl',
      history_path: 'state/sensory/analysis_kernel_stage_interface/history.jsonl'
    }
  }
});
