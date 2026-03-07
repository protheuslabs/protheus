#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-056
 * Signed Plugin Trust Marketplace and Revocation Plane
 */

const path = require('path');
const { ROOT } = require('../../lib/queued_backlog_runtime');
const { runLaneCli } = require('../../lib/backlog_lane_cli');

const POLICY_PATH = process.env.SIGNED_PLUGIN_TRUST_MARKETPLACE_POLICY_PATH
  ? path.resolve(process.env.SIGNED_PLUGIN_TRUST_MARKETPLACE_POLICY_PATH)
  : path.join(ROOT, 'config/signed_plugin_trust_marketplace_policy.json');

runLaneCli({
  lane_id: 'V3-RACE-056',
  title: 'Signed Plugin Trust Marketplace and Revocation Plane',
  type: 'signed_plugin_trust_marketplace',
  default_action: 'publish',
  script_label: 'systems/security/signed_plugin_trust_marketplace.js',
  policy_path: POLICY_PATH,
  default_policy: {
    version: '1.0',
    enabled: true,
    strict_default: true,
    checks: [
    {
        "id": "signed_extension_manifests",
        "description": "Signed extension manifests required"
    },
    {
        "id": "sandbox_attestation_gate",
        "description": "Sandbox attestation mandatory for publish"
    },
    {
        "id": "scoped_capability_grants",
        "description": "Capability grants remain scope-bounded"
    },
    {
        "id": "global_revocation_propagation",
        "description": "Global revocation propagation available"
    }
],
    paths: {
      state_path: 'state/security/signed_plugin_trust_marketplace/state.json',
      latest_path: 'state/security/signed_plugin_trust_marketplace/latest.json',
      receipts_path: 'state/security/signed_plugin_trust_marketplace/receipts.jsonl',
      history_path: 'state/security/signed_plugin_trust_marketplace/history.jsonl'
    }
  }
});
