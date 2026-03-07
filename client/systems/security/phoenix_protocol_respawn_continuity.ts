#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-DEF-028
 * Phoenix Protocol Immortal Red Legion Respawn
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.PHOENIX_PROTOCOL_RESPAWN_CONTINUITY_POLICY_PATH
  ? path.resolve(process.env.PHOENIX_PROTOCOL_RESPAWN_CONTINUITY_POLICY_PATH)
  : path.join(ROOT, 'config/phoenix_protocol_respawn_continuity_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-DEF-028',
  title: 'Phoenix Protocol Immortal Red Legion Respawn',
  type: 'phoenix_protocol_respawn_continuity',
  default_action: 'respawn',
  script_label: 'systems/security/phoenix_protocol_respawn_continuity.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "red_legion_down_trigger",
        "description": "Down trigger emits authoritative event"
    },
    {
        "id": "auto_respawn_target",
        "description": "Auto respawn target under 2 seconds configured"
    },
    {
        "id": "inheritance_state_rehydrate",
        "description": "Intel inheritance restore contract active"
    },
    {
        "id": "fractal_post_respawn_mutation",
        "description": "Fractal mutation hook after respawn configured"
    }
],
    paths: {
      state_path: 'state/security/phoenix_protocol_respawn_continuity/state.json',
      latest_path: 'state/security/phoenix_protocol_respawn_continuity/latest.json',
      receipts_path: 'state/security/phoenix_protocol_respawn_continuity/receipts.jsonl',
      history_path: 'state/security/phoenix_protocol_respawn_continuity/history.jsonl'
    }
  }
});
