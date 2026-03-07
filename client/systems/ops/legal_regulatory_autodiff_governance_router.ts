#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-058
 * Legal and Regulatory Auto-Diff Governance Router
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.LEGAL_REGULATORY_AUTODIFF_GOVERNANCE_ROUTER_POLICY_PATH
  ? path.resolve(process.env.LEGAL_REGULATORY_AUTODIFF_GOVERNANCE_ROUTER_POLICY_PATH)
  : path.join(ROOT, 'config/legal_regulatory_autodiff_governance_router_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-058',
  title: 'Legal and Regulatory Auto-Diff Governance Router',
  type: 'legal_regulatory_autodiff_governance_router',
  default_action: 'diff',
  script_label: 'systems/ops/legal_regulatory_autodiff_governance_router.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "legal_source_diff_ingestion",
        "description": "Legal source diff ingestion active"
    },
    {
        "id": "impact_classification_router",
        "description": "Control impact classification available"
    },
    {
        "id": "human_approval_checkpoints",
        "description": "Human approval checkpoints enforced"
    },
    {
        "id": "evidence_update_trails",
        "description": "Evidence update trails emitted"
    }
],
    paths: {
      state_path: 'state/ops/legal_regulatory_autodiff_governance_router/state.json',
      latest_path: 'state/ops/legal_regulatory_autodiff_governance_router/latest.json',
      receipts_path: 'state/ops/legal_regulatory_autodiff_governance_router/receipts.jsonl',
      history_path: 'state/ops/legal_regulatory_autodiff_governance_router/history.jsonl'
    }
  }
});
