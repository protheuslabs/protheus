#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { cleanText, clampInt } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.BROWSER_CLI_SHADOW_BRIDGE_POLICY_PATH
  ? path.resolve(process.env.BROWSER_CLI_SHADOW_BRIDGE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'browser', 'browser_cli_shadow_bridge_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/browser/browser_cli_shadow_bridge.js run --native=1 --persona=<id> --task="navigate https://example.com"');
  console.log('  node systems/browser/browser_cli_shadow_bridge.js status');
}

runStandardLane({
  lane_id: 'V6-BROWSER-006',
  script_rel: 'systems/browser/browser_cli_shadow_bridge.js',
  policy_path: POLICY_PATH,
  stream: 'browser.cli_shadow_bridge',
  paths: {
    memory_dir: 'client/local/state/browser/cli_shadow_bridge/memory',
    adaptive_index_path: 'client/local/adaptive/browser/cli_shadow_bridge/index.json',
    events_path: 'client/local/state/browser/cli_shadow_bridge/events.jsonl',
    latest_path: 'client/local/state/browser/cli_shadow_bridge/latest.json',
    receipts_path: 'client/local/state/browser/cli_shadow_bridge/receipts.jsonl'
  },
  usage,
  handlers: {
    run(policy: any, args: any, ctx: any) {
      const persona = cleanText(args.persona || 'default_shadow', 120);
      const task = cleanText(args.task || '', 1000);
      if (!task) return { ok: false, type: 'browser_cli_shadow_bridge', action: 'run', error: 'task_required' };
      const native = String(args.native || '0') === '1';
      const driftScore = clampInt(args['drift-score'] || 12, 0, 100, 12);
      const breakerThreshold = clampInt(policy.breaker_threshold || 70, 1, 100, 70);
      const breaker = driftScore >= breakerThreshold;
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'browser_cli_shadow_bridge_run',
        payload_json: JSON.stringify({
          ok: native && !breaker,
          native,
          persona,
          task,
          drift_score: driftScore,
          breaker_threshold: breakerThreshold,
          escalated_for_review: breaker,
          routed_through_governance: true
        })
      });
    }
  }
});
