#!/usr/bin/env node
'use strict';
export {};

const { nowIso, clampInt, cleanText } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');
const path = require('path');

const POLICY_PATH = process.env.SANDBOX_CONTEXT_CONTROLS_POLICY_PATH
  ? path.resolve(process.env.SANDBOX_CONTEXT_CONTROLS_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'sandbox_context_controls_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/sandbox_context_controls.js compress --tokens=<n> [--max-tokens=<n>] [--mode=trim|reject]');
  console.log('  node systems/security/sandbox_context_controls.js status');
}

runStandardLane({
  lane_id: 'V6-SBOX-005',
  script_rel: 'systems/security/sandbox_context_controls.js',
  policy_path: POLICY_PATH,
  stream: 'security.sandbox_context_controls',
  paths: {
    memory_dir: 'client/local/state/security/sandbox_context_controls/memory',
    adaptive_index_path: 'client/local/adaptive/security/sandbox_context_controls/index.json',
    events_path: 'client/local/state/security/sandbox_context_controls/events.jsonl',
    latest_path: 'client/local/state/security/sandbox_context_controls/latest.json',
    receipts_path: 'client/local/state/security/sandbox_context_controls/receipts.jsonl'
  },
  usage,
  handlers: {
    compress(policy: any, args: any, ctx: any) {
      const maxTokens = clampInt(args['max-tokens'] || args.max_tokens || policy.max_tokens || 8000, 256, 64000, 8000);
      const tokens = clampInt(args.tokens || 0, 0, 500000, 0);
      const mode = cleanText(args.mode || policy.mode || 'trim', 20).toLowerCase();
      const over = tokens > maxTokens;
      const action = !over ? 'pass' : (mode === 'reject' ? 'reject' : 'trim');
      const reducedTo = action === 'trim' ? maxTokens : tokens;
      const rejected = action === 'reject';
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sandbox_context_compress',
        payload_json: JSON.stringify({
          ok: !rejected,
          mode,
          input_tokens: tokens,
          max_tokens: maxTokens,
          action,
          output_tokens: reducedTo,
          ts: nowIso()
        })
      });
    }
  }
});
