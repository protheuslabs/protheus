#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-157
 * model_artifact_archive lane.
 */

const path = require('path');
const { normalizeToken } = require(path.join(__dirname, '..', '..', 'lib', 'queued_backlog_runtime.js'));
const { runStandardLane } = require(path.join(__dirname, '..', '..', 'lib', 'upgrade_lane_runtime.js'));

const POLICY_PATH = process.env.V3_RACE_157_POLICY_PATH
  ? path.resolve(process.env.V3_RACE_157_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'model_artifact_archive_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/training/model_artifact_archive.js configure --owner=<owner_id> [--profile=default]');
  console.log('  node systems/training/model_artifact_archive.js execute --owner=<owner_id> [--task=default] [--risk-tier=2]');
  console.log('  node systems/training/model_artifact_archive.js status [--owner=<owner_id>]');
}

runStandardLane({
  lane_id: 'V3-RACE-157',
  script_rel: 'systems/training/model_artifact_archive.js',
  policy_path: POLICY_PATH,
  stream: 'training.model_artifact_archive',
  paths: {
    memory_dir: 'memory/training/artifact_access',
    adaptive_index_path: 'adaptive/training/artifacts/index.json',
    events_path: 'state/training\/model_artifact_archive/events.jsonl',
    latest_path: 'state/training\/model_artifact_archive/latest.json',
    receipts_path: 'state/training\/model_artifact_archive/receipts.jsonl'
  },
  usage,
  handlers: {
    execute(policy, args, ctx) {
      const task = normalizeToken(args.task || args.mode || 'default', 120) || 'default';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'model_artifact_archive_execute',
        payload_json: JSON.stringify({
          lane_id: 'V3-RACE-157',
          task,
          guarded_execution: true,
          bounded_risk_tier: true,
          deterministic_receipts: true
        })
      });
    }
  }
});
