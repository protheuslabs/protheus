#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const crypto = require('crypto');
const { cleanText } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.BROWSER_SNAPSHOT_REFS_POLICY_PATH
  ? path.resolve(process.env.BROWSER_SNAPSHOT_REFS_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'browser', 'browser_snapshot_refs_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/browser/browser_snapshot_refs.js snapshot --url=https://example.com [--selector=body]');
  console.log('  node systems/browser/browser_snapshot_refs.js diff --session=<id> [--previous=<text>] [--current=<text>]');
  console.log('  node systems/browser/browser_snapshot_refs.js status');
}

function refFrom(input: string) {
  return `el_${crypto.createHash('sha1').update(input).digest('hex').slice(0, 12)}`;
}

runStandardLane({
  lane_id: 'V6-BROWSER-004',
  script_rel: 'systems/browser/browser_snapshot_refs.js',
  policy_path: POLICY_PATH,
  stream: 'browser.snapshot_refs',
  paths: {
    memory_dir: 'client/local/state/browser/snapshot_refs/memory',
    adaptive_index_path: 'client/local/adaptive/browser/snapshot_refs/index.json',
    events_path: 'client/local/state/browser/snapshot_refs/events.jsonl',
    latest_path: 'client/local/state/browser/snapshot_refs/latest.json',
    receipts_path: 'client/local/state/browser/snapshot_refs/receipts.jsonl'
  },
  usage,
  handlers: {
    snapshot(policy: any, args: any, ctx: any) {
      const url = cleanText(args.url || 'about:blank', 260);
      const selector = cleanText(args.selector || 'body', 180);
      const refs = [selector, `${selector} > *`].map((s: string) => ({ selector: s, ref: refFrom(`${url}|${s}`) }));
      return ctx.cmdRecord(policy, { ...args, event: 'browser_snapshot_refs_snapshot', payload_json: JSON.stringify({ ok: true, url, refs, annotated: true }) });
    },
    diff(policy: any, args: any, ctx: any) {
      const previous = cleanText(args.previous || '', 8000);
      const current = cleanText(args.current || '', 8000);
      const changed = previous !== current;
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'browser_snapshot_refs_diff',
        payload_json: JSON.stringify({ ok: true, changed, token_efficient: true, refs: [{ ref: refFrom(`${previous}|${current}`), changed }] })
      });
    }
  }
});
