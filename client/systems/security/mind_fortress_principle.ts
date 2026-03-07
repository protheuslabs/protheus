#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-033
 * Mind Fortress Principle
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.MIND_FORTRESS_PRINCIPLE_POLICY_PATH
  ? path.resolve(process.env.MIND_FORTRESS_PRINCIPLE_POLICY_PATH)
  : path.join(ROOT, 'config/mind_fortress_principle_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-033',
  title: 'Mind Fortress Principle',
  type: 'mind_fortress_principle',
  default_action: 'anchor',
  script_label: 'systems/security/mind_fortress_principle.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "constitution_covenant_preamble",
        "description": "Covenant preamble anchored in constitution",
        "file_must_exist": "AGENT-CONSTITUTION.md"
    },
    {
        "id": "manifesto_doc_present",
        "description": "Mind sovereignty manifesto present",
        "file_must_exist": "docs/MIND_SOVEREIGNTY.md"
    },
    {
        "id": "contract_alignment_field",
        "description": "New contracts include sovereignty alignment field"
    },
    {
        "id": "sovereignty_metric_gate",
        "description": "Sovereignty score integrated in fitness gating"
    }
],
    paths: {
      state_path: 'state/security/mind_fortress_principle/state.json',
      latest_path: 'state/security/mind_fortress_principle/latest.json',
      receipts_path: 'state/security/mind_fortress_principle/receipts.jsonl',
      history_path: 'state/security/mind_fortress_principle/history.jsonl'
    }
  }
});
