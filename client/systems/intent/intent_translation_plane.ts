#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-139
 * Intent declaration + translation plane.
 */

const path = require('path');
const { cleanText, normalizeToken } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.INTENT_TRANSLATION_POLICY_PATH
  ? path.resolve(process.env.INTENT_TRANSLATION_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'intent_translation_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/intent/intent_translation_plane.js configure --owner=<owner_id> [--disambiguation=balanced]');
  console.log('  node systems/intent/intent_translation_plane.js translate --owner=<owner_id> --intent=\"...\" [--risk-tier=2]');
  console.log('  node systems/intent/intent_translation_plane.js status [--owner=<owner_id>]');
}

function inferPlan(intentText: string) {
  const lowered = intentText.toLowerCase();
  const objective = lowered.includes('revenue')
    ? 'increase_revenue'
    : lowered.includes('security')
      ? 'improve_security_posture'
      : 'general_objective';
  const steps = lowered.includes('watch')
    ? ['create_signal_collector', 'schedule_scan', 'emit_receipt']
    : ['decompose_intent', 'generate_candidate_plan', 'run_governed_execution'];
  return { objective, steps };
}

runStandardLane({
  lane_id: 'V3-RACE-139',
  script_rel: 'systems/intent/intent_translation_plane.js',
  policy_path: POLICY_PATH,
  stream: 'intent.translation',
  paths: {
    memory_dir: 'memory/intent',
    adaptive_index_path: 'adaptive/intent/index.json',
    events_path: 'state/intent/translation/events.jsonl',
    latest_path: 'state/intent/translation/latest.json',
    receipts_path: 'state/intent/translation/receipts.jsonl'
  },
  usage,
  handlers: {
    translate(policy: any, args: any, ctx: any) {
      const intent = cleanText(args.intent || args.prompt || '', 2000);
      if (!intent) return { ok: false, error: 'missing_intent' };
      const plan = inferPlan(intent);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'intent_translate',
        payload_json: JSON.stringify({
          intent_text: intent,
          normalized_intent_id: normalizeToken(intent, 120) || 'intent',
          plan,
          explainability_receipt: true,
          risk_gate_applied: true
        })
      });
    }
  }
});
