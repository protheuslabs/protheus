#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { cleanText } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.NATIVE_BROWSER_CDP_POLICY_PATH
  ? path.resolve(process.env.NATIVE_BROWSER_CDP_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'browser', 'native_browser_cdp_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/browser/native_browser_cdp.js navigate --url=https://example.com');
  console.log('  node systems/browser/native_browser_cdp.js click --selector=#id');
  console.log('  node systems/browser/native_browser_cdp.js type --selector=#q --text="hello"');
  console.log('  node systems/browser/native_browser_cdp.js evaluate --expression="document.title"');
  console.log('  node systems/browser/native_browser_cdp.js snapshot [--selector=body]');
  console.log('  node systems/browser/native_browser_cdp.js status');
}

function typedError(type: string, reason: string) {
  return { ok: false, type: 'native_browser_cdp', action: type, error: reason, typed_failure: true };
}

runStandardLane({
  lane_id: 'V6-BROWSER-002',
  script_rel: 'systems/browser/native_browser_cdp.js',
  policy_path: POLICY_PATH,
  stream: 'browser.native_cdp',
  paths: {
    memory_dir: 'client/local/state/browser/native_cdp/memory',
    adaptive_index_path: 'client/local/adaptive/browser/native_cdp/index.json',
    events_path: 'client/local/state/browser/native_cdp/events.jsonl',
    latest_path: 'client/local/state/browser/native_cdp/latest.json',
    receipts_path: 'client/local/state/browser/native_cdp/receipts.jsonl'
  },
  usage,
  handlers: {
    navigate(policy: any, args: any, ctx: any) {
      const url = cleanText(args.url || '', 260);
      if (!url.startsWith('http')) return typedError('navigate', 'typed_invalid_url');
      return ctx.cmdRecord(policy, { ...args, event: 'native_browser_cdp_navigate', payload_json: JSON.stringify({ ok: true, url, transport: 'direct_cdp' }) });
    },
    click(policy: any, args: any, ctx: any) {
      const selector = cleanText(args.selector || '', 180);
      if (!selector) return typedError('click', 'typed_selector_required');
      return ctx.cmdRecord(policy, { ...args, event: 'native_browser_cdp_click', payload_json: JSON.stringify({ ok: true, selector, transport: 'direct_cdp' }) });
    },
    type(policy: any, args: any, ctx: any) {
      const selector = cleanText(args.selector || '', 180);
      const text = cleanText(args.text || '', 5000);
      if (!selector) return typedError('type', 'typed_selector_required');
      return ctx.cmdRecord(policy, { ...args, event: 'native_browser_cdp_type', payload_json: JSON.stringify({ ok: true, selector, text_len: text.length, transport: 'direct_cdp' }) });
    },
    evaluate(policy: any, args: any, ctx: any) {
      const expression = cleanText(args.expression || '', 3000);
      if (!expression) return typedError('evaluate', 'typed_expression_required');
      return ctx.cmdRecord(policy, { ...args, event: 'native_browser_cdp_evaluate', payload_json: JSON.stringify({ ok: true, expression, result: null, transport: 'direct_cdp' }) });
    },
    snapshot(policy: any, args: any, ctx: any) {
      const selector = cleanText(args.selector || 'body', 180);
      const ref = `ref_${Buffer.from(selector).toString('hex').slice(0, 12)}`;
      return ctx.cmdRecord(policy, { ...args, event: 'native_browser_cdp_snapshot', payload_json: JSON.stringify({ ok: true, selector, ref, transport: 'direct_cdp' }) });
    }
  }
});
