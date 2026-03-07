#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-042
 * Formal Threat Modeling Engine
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.FORMAL_THREAT_MODELING_ENGINE_POLICY_PATH
  ? path.resolve(process.env.FORMAL_THREAT_MODELING_ENGINE_POLICY_PATH)
  : path.join(ROOT, 'config/formal_threat_modeling_engine_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-042',
  title: 'Formal Threat Modeling Engine',
  type: 'formal_threat_modeling_engine',
  default_action: 'model',
  script_label: 'systems/security/formal_threat_modeling_engine.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "stride_attack_mapping",
        "description": "STRIDE and ATT&CK mapping coverage generated"
    },
    {
        "id": "contract_delta_detection",
        "description": "Organ and contract deltas trigger remapping"
    },
    {
        "id": "high_risk_unmapped_gate",
        "description": "CI blocks high-risk unmapped surfaces"
    },
    {
        "id": "threat_model_receipts",
        "description": "Threat-model generation receipts persisted"
    }
],
    paths: {
      state_path: 'state/security/formal_threat_modeling_engine/state.json',
      latest_path: 'state/security/formal_threat_modeling_engine/latest.json',
      receipts_path: 'state/security/formal_threat_modeling_engine/receipts.jsonl',
      history_path: 'state/security/formal_threat_modeling_engine/history.jsonl'
    }
  }
});
