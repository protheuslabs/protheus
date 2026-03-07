#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-043
 * Supply-Chain Security and Reproducible Build Plane
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.SUPPLY_CHAIN_REPRODUCIBLE_BUILD_PLANE_POLICY_PATH
  ? path.resolve(process.env.SUPPLY_CHAIN_REPRODUCIBLE_BUILD_PLANE_POLICY_PATH)
  : path.join(ROOT, 'config/supply_chain_reproducible_build_plane_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-043',
  title: 'Supply-Chain Security and Reproducible Build Plane',
  type: 'supply_chain_reproducible_build_plane',
  default_action: 'attest',
  script_label: 'systems/security/supply_chain_reproducible_build_plane.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "reproducible_build_profile",
        "description": "Reproducible build profile for crown-jewel artifacts exists"
    },
    {
        "id": "sbom_generation",
        "description": "SBOM generation and retention policy enabled"
    },
    {
        "id": "signed_provenance_attestation",
        "description": "Signed provenance attestations required"
    },
    {
        "id": "release_verification_gate",
        "description": "Strict release verification gate enabled"
    }
],
    paths: {
      state_path: 'state/security/supply_chain_reproducible_build_plane/state.json',
      latest_path: 'state/security/supply_chain_reproducible_build_plane/latest.json',
      receipts_path: 'state/security/supply_chain_reproducible_build_plane/receipts.jsonl',
      history_path: 'state/security/supply_chain_reproducible_build_plane/history.jsonl'
    }
  }
});
