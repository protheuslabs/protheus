#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-051
 * Hardware Root-of-Trust Attestation Mesh
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.HARDWARE_ROOT_OF_TRUST_ATTESTATION_MESH_POLICY_PATH
  ? path.resolve(process.env.HARDWARE_ROOT_OF_TRUST_ATTESTATION_MESH_POLICY_PATH)
  : path.join(ROOT, 'config/hardware_root_of_trust_attestation_mesh_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-051',
  title: 'Hardware Root-of-Trust Attestation Mesh',
  type: 'hardware_root_of_trust_attestation_mesh',
  default_action: 'attest',
  script_label: 'systems/security/hardware_root_of_trust_attestation_mesh.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "tpm_tee_enrollment",
        "description": "TPM/TEE enrollment contract enabled"
    },
    {
        "id": "session_bound_trust_tokens",
        "description": "Session-bound trust token issuance active"
    },
    {
        "id": "drift_auto_quarantine",
        "description": "Attestation drift triggers automatic quarantine"
    },
    {
        "id": "trust_transition_receipts",
        "description": "Trust transition receipts emitted"
    }
],
    paths: {
      state_path: 'state/security/hardware_root_of_trust_attestation_mesh/state.json',
      latest_path: 'state/security/hardware_root_of_trust_attestation_mesh/latest.json',
      receipts_path: 'state/security/hardware_root_of_trust_attestation_mesh/receipts.jsonl',
      history_path: 'state/security/hardware_root_of_trust_attestation_mesh/history.jsonl'
    }
  }
});
