#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-140
 * DID + VC soul binding lane.
 */

const path = require('path');
const { normalizeToken, stableHash } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.DID_VC_BINDING_POLICY_PATH
  ? path.resolve(process.env.DID_VC_BINDING_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'did_vc_binding_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/identity/did_vc_binding.js configure --owner=<owner_id> [--did=did:key:z...]');
  console.log('  node systems/identity/did_vc_binding.js issue --owner=<owner_id> --subject=<subject_id> --claim=<badge_id> [--risk-tier=2]');
  console.log('  node systems/identity/did_vc_binding.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-140',
  script_rel: 'systems/identity/did_vc_binding.js',
  policy_path: POLICY_PATH,
  stream: 'identity.did_vc',
  paths: {
    memory_dir: 'memory/identity/did',
    adaptive_index_path: 'adaptive/identity/did/index.json',
    events_path: 'state/identity/did_vc/events.jsonl',
    latest_path: 'state/identity/did_vc/latest.json',
    receipts_path: 'state/identity/did_vc/receipts.jsonl'
  },
  usage,
  handlers: {
    issue(policy: any, args: any, ctx: any) {
      const owner = normalizeToken(args.owner || args.owner_id, 120);
      const subject = normalizeToken(args.subject || args.subject_id, 120);
      const claim = normalizeToken(args.claim || args.badge || '', 120) || 'claim';
      if (!owner || !subject) return { ok: false, error: 'missing_owner_or_subject' };
      const credentialId = `vc_${stableHash(`${owner}|${subject}|${claim}|${Date.now()}`, 20)}`;
      return ctx.cmdRecord(policy, {
        ...args,
        owner,
        event: 'did_vc_issue',
        payload_json: JSON.stringify({
          credential_id: credentialId,
          issuer_owner_id: owner,
          subject_id: subject,
          claim,
          revocation_supported: true,
          private_field_minimization: true
        })
      });
    }
  }
});
