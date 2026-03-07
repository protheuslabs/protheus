#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-141
 * Content-addressed archival plane.
 */

const fs = require('fs');
const path = require('path');
const { cleanText, normalizeToken, stableHash } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.CONTENT_ADDRESSED_ARCHIVE_POLICY_PATH
  ? path.resolve(process.env.CONTENT_ADDRESSED_ARCHIVE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'content_addressed_archive_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/archival/content_addressed_archive.js configure --owner=<owner_id> [--pin-policy=hot]');
  console.log('  node systems/archival/content_addressed_archive.js archive --owner=<owner_id> --payload=\"...\" [--label=name] [--risk-tier=2]');
  console.log('  node systems/archival/content_addressed_archive.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-141',
  script_rel: 'systems/archival/content_addressed_archive.js',
  policy_path: POLICY_PATH,
  stream: 'archival.content_addressed',
  paths: {
    memory_dir: 'memory/archival/content_addressed',
    adaptive_index_path: 'adaptive/archival/index.json',
    events_path: 'state/archival/content_addressed/events.jsonl',
    latest_path: 'state/archival/content_addressed/latest.json',
    receipts_path: 'state/archival/content_addressed/receipts.jsonl',
    cid_index_path: 'state/archival/content_addressed/cid_index.json'
  },
  usage,
  handlers: {
    archive(policy: any, args: any, ctx: any) {
      const owner = normalizeToken(args.owner || args.owner_id, 120);
      const payload = cleanText(args.payload || '', 20000);
      if (!owner || !payload) return { ok: false, error: 'missing_owner_or_payload' };
      const label = normalizeToken(args.label || 'artifact', 120) || 'artifact';
      const cid = `cid_${stableHash(payload, 32)}`;
      const envelope = {
        cid,
        owner_id: owner,
        label,
        payload_hash: stableHash(payload, 32),
        encrypted_payload_ref: `enc_${stableHash(`${owner}|${payload}`, 24)}`,
        ipfs_compatible: true
      };
      const cidPath = String(policy.paths.cid_index_path);
      const current = fs.existsSync(cidPath) ? JSON.parse(fs.readFileSync(cidPath, 'utf8')) : { rows: [] };
      current.rows = Array.isArray(current.rows) ? current.rows : [];
      current.rows.push(envelope);
      fs.mkdirSync(path.dirname(cidPath), { recursive: true });
      fs.writeFileSync(cidPath, `${JSON.stringify(current, null, 2)}\n`, 'utf8');
      return ctx.cmdRecord(policy, {
        ...args,
        owner,
        event: 'content_archive',
        payload_json: JSON.stringify({
          ...envelope,
          retrieval_verification_required: true
        })
      });
    }
  }
});
