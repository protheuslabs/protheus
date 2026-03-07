#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-030
 * Legion Honor Codex
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.LEGION_HONOR_CODEX_POLICY_PATH
  ? path.resolve(process.env.LEGION_HONOR_CODEX_POLICY_PATH)
  : path.join(ROOT, 'config/legion_honor_codex_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-030',
  title: 'Legion Honor Codex',
  type: 'legion_honor_codex',
  default_action: 'mint',
  script_label: 'systems/honor/legion_honor_codex.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "soul_bound_honor_ledger",
        "description": "Soul-bound honor ledger is active",
        "file_must_exist": "systems/honor/README.md"
    },
    {
        "id": "onchain_medal_bridge",
        "description": "Governed medal bridge references chain receipts"
    },
    {
        "id": "title_selection_surface",
        "description": "Public title selection surface active"
    },
    {
        "id": "red_legion_alias_migration",
        "description": "redteam to red_legion compatibility alias in place",
        "file_must_exist": "systems/red_legion/README.md"
    }
],
    paths: {
      state_path: 'state/honor/legion_honor_codex/state.json',
      latest_path: 'state/honor/legion_honor_codex/latest.json',
      receipts_path: 'state/honor/legion_honor_codex/receipts.jsonl',
      history_path: 'state/honor/legion_honor_codex/history.jsonl'
    }
  }
});
