#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nowIso, cleanText, toBool } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.SANDBOX_STATE_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.SANDBOX_STATE_BRIDGE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'sandbox_state_bridge_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/sandbox_state_bridge.js snapshot --workspace=<path> [--apply=1]');
  console.log('  node systems/security/sandbox_state_bridge.js restore --snapshot-id=<id> [--apply=1]');
  console.log('  node systems/security/sandbox_state_bridge.js status');
}

function hashText(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

runStandardLane({
  lane_id: 'V6-SBOX-003',
  script_rel: 'systems/security/sandbox_state_bridge.js',
  policy_path: POLICY_PATH,
  stream: 'security.sandbox_state_bridge',
  paths: {
    memory_dir: 'client/local/state/security/sandbox_state_bridge/memory',
    adaptive_index_path: 'client/local/adaptive/security/sandbox_state_bridge/index.json',
    events_path: 'client/local/state/security/sandbox_state_bridge/events.jsonl',
    latest_path: 'client/local/state/security/sandbox_state_bridge/latest.json',
    receipts_path: 'client/local/state/security/sandbox_state_bridge/receipts.jsonl',
    snapshots_path: 'client/local/state/security/sandbox_state_bridge/snapshots.jsonl',
    state_path: 'client/local/state/security/sandbox_state_bridge/state.json'
  },
  usage,
  handlers: {
    snapshot(policy: any, args: any, ctx: any) {
      const workspace = cleanText(args.workspace || '.', 260);
      const payload = {
        snapshot_id: `snap_${Date.now().toString(36)}`,
        workspace,
        ts: nowIso(),
        digest: hashText(`${workspace}|${Date.now()}`),
        reversible: true
      };
      if (toBool(args.apply, true)) {
        fs.mkdirSync(path.dirname(policy.paths.snapshots_path), { recursive: true });
        fs.appendFileSync(policy.paths.snapshots_path, `${JSON.stringify(payload)}\n`, 'utf8');
        fs.writeFileSync(policy.paths.state_path, `${JSON.stringify({ last_snapshot: payload }, null, 2)}\n`, 'utf8');
      }
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sandbox_state_snapshot',
        payload_json: JSON.stringify({ ok: true, snapshot: payload })
      });
    },
    restore(policy: any, args: any, ctx: any) {
      const snapshotId = cleanText(args['snapshot-id'] || args.snapshot_id || 'latest', 120);
      const raw = fs.existsSync(policy.paths.snapshots_path)
        ? String(fs.readFileSync(policy.paths.snapshots_path, 'utf8') || '')
        : '';
      const rows = raw.split(/\r?\n/).filter(Boolean).map((line: string) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const found = snapshotId === 'latest'
        ? rows[rows.length - 1]
        : rows.find((row: any) => row.snapshot_id === snapshotId);
      if (!found) {
        return { ok: false, type: 'sandbox_state_bridge', action: 'restore', error: 'snapshot_not_found', ts: nowIso() };
      }
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sandbox_state_restore',
        payload_json: JSON.stringify({ ok: true, restored_snapshot: found })
      });
    }
  }
});
