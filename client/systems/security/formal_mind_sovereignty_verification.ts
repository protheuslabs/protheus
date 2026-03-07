#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-035
 * Formal Mind-Sovereignty Verification Layer
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.FORMAL_MIND_SOVEREIGNTY_VERIFICATION_POLICY_PATH
  ? path.resolve(process.env.FORMAL_MIND_SOVEREIGNTY_VERIFICATION_POLICY_PATH)
  : path.join(ROOT, 'config/formal_mind_sovereignty_verification_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-035',
  title: 'Formal Mind-Sovereignty Verification Layer',
  type: 'formal_mind_sovereignty_verification',
  default_action: 'verify',
  script_label: 'systems/security/formal_mind_sovereignty_verification.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "sovereignty_invariant_spec",
        "description": "Machine-checkable sovereignty invariants defined"
    },
    {
        "id": "model_check_gate",
        "description": "Model checking gate blocks unsafe mutations"
    },
    {
        "id": "merge_block_on_proof_failure",
        "description": "Merge blocked on failed proofs"
    },
    {
        "id": "ci_sovereignty_enforcement",
        "description": "CI enforcement for sovereignty proofs active"
    }
],
    paths: {
      state_path: 'state/security/formal_mind_sovereignty_verification/state.json',
      latest_path: 'state/security/formal_mind_sovereignty_verification/latest.json',
      receipts_path: 'state/security/formal_mind_sovereignty_verification/receipts.jsonl',
      history_path: 'state/security/formal_mind_sovereignty_verification/history.jsonl'
    }
  }
});
