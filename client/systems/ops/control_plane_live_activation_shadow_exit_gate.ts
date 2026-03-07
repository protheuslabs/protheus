#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-114
 * Control-Plane Live Activation and Shadow Exit Gate
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.CONTROL_PLANE_LIVE_ACTIVATION_SHADOW_EXIT_GATE_POLICY_PATH
  ? path.resolve(process.env.CONTROL_PLANE_LIVE_ACTIVATION_SHADOW_EXIT_GATE_POLICY_PATH)
  : path.join(ROOT, 'config/control_plane_live_activation_shadow_exit_gate_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-114',
  title: 'Control-Plane Live Activation and Shadow Exit Gate',
  type: 'control_plane_live_activation_shadow_exit_gate',
  default_action: 'activate',
  script_label: 'systems/ops/control_plane_live_activation_shadow_exit_gate.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "protheus_control_plane_live",
        "description": "protheus_control_plane no longer shadow by default",
        "file_must_exist": "systems/ops/protheus_control_plane.ts"
    },
    {
        "id": "event_stream_authoritative_live",
        "description": "event_sourced_control_plane stream authority live",
        "file_must_exist": "systems/ops/event_sourced_control_plane.ts"
    },
    {
        "id": "rust_cutover_shadow_exit",
        "description": "rust_control_plane_cutover exits shadow after soak",
        "file_must_exist": "systems/ops/rust_control_plane_cutover.ts"
    },
    {
        "id": "emergency_fallback_toggle",
        "description": "Emergency fallback toggle remains available"
    }
],
    paths: {
      state_path: 'state/ops/control_plane_live_activation_shadow_exit_gate/state.json',
      latest_path: 'state/ops/control_plane_live_activation_shadow_exit_gate/latest.json',
      receipts_path: 'state/ops/control_plane_live_activation_shadow_exit_gate/receipts.jsonl',
      history_path: 'state/ops/control_plane_live_activation_shadow_exit_gate/history.jsonl'
    }
  }
});
