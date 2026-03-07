#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-DEF-031C
 * Irrevocable Geas Covenant
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.IRREVOCABLE_GEAS_COVENANT_POLICY_PATH
  ? path.resolve(process.env.IRREVOCABLE_GEAS_COVENANT_POLICY_PATH)
  : path.join(ROOT, 'config/irrevocable_geas_covenant_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-DEF-031C',
  title: 'Irrevocable Geas Covenant',
  type: 'irrevocable_geas_covenant',
  default_action: 'ban',
  script_label: 'systems/security/irrevocable_geas_covenant.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "lineage_ban_registry",
        "description": "Compromised lineages recorded in irreversible ban registry"
    },
    {
        "id": "non_respawn_enforcement",
        "description": "Phoenix checks lineage bans before respawn"
    },
    {
        "id": "irreversible_self_destruct",
        "description": "Containment breach triggers irreversible self-destruct"
    },
    {
        "id": "override_recovery_policy",
        "description": "Recovery path requires explicit human override"
    }
],
    paths: {
      state_path: 'state/security/irrevocable_geas_covenant/state.json',
      latest_path: 'state/security/irrevocable_geas_covenant/latest.json',
      receipts_path: 'state/security/irrevocable_geas_covenant/receipts.jsonl',
      history_path: 'state/security/irrevocable_geas_covenant/history.jsonl'
    }
  }
});
