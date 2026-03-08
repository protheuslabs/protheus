#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const crypto = require('crypto');
const { cleanText } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.BROWSER_TEXT_DIFF_POLICY_PATH
  ? path.resolve(process.env.BROWSER_TEXT_DIFF_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'browser', 'browser_text_diff_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/browser/browser_text_diff_lane.js text --url=https://example.com [--html=<html>] [--text=<text>]');
  console.log('  node systems/browser/browser_text_diff_lane.js diff --before=<text> --after=<text>');
  console.log('  node systems/browser/browser_text_diff_lane.js status');
}

function sha12(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 12);
}

function estimateTokens(value: string) {
  return Math.max(1, Math.ceil(String(value || '').length / 4));
}

function stripHtml(raw: string) {
  const text = String(raw || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text;
}

function lineDiff(before: string, after: string) {
  const a = String(before || '').split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  const b = String(after || '').split(/\r?\n/).map((row) => row.trim()).filter(Boolean);
  const aset = new Set(a);
  const bset = new Set(b);
  const added = b.filter((row) => !aset.has(row));
  const removed = a.filter((row) => !bset.has(row));
  return {
    added,
    removed,
    changed: added.length > 0 || removed.length > 0
  };
}

runStandardLane({
  lane_id: 'V6-BROWSER-007',
  script_rel: 'systems/browser/browser_text_diff_lane.js',
  policy_path: POLICY_PATH,
  stream: 'browser.text_diff',
  paths: {
    memory_dir: 'client/local/state/browser/text_diff/memory',
    adaptive_index_path: 'client/local/adaptive/browser/text_diff/index.json',
    events_path: 'client/local/state/browser/text_diff/events.jsonl',
    latest_path: 'client/local/state/browser/text_diff/latest.json',
    receipts_path: 'client/local/state/browser/text_diff/receipts.jsonl'
  },
  usage,
  handlers: {
    text(policy: any, args: any, ctx: any) {
      const url = cleanText(args.url || 'about:blank', 320);
      const html = String(args.html || '');
      const explicitText = String(args.text || '');
      const extracted = explicitText
        || (html ? stripHtml(html) : `snapshot ${url}`);
      const excerpt = cleanText(extracted, 2400);
      const tokenEstimate = estimateTokens(excerpt);
      const maxTokens = Number(policy.max_text_tokens || 800);
      const withinBudget = tokenEstimate <= maxTokens;
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'browser_text_snapshot',
        payload_json: JSON.stringify({
          ok: true,
          url,
          ref: `txt_${sha12(`${url}|${excerpt}`)}`,
          text: excerpt,
          token_estimate: tokenEstimate,
          max_text_tokens: maxTokens,
          within_budget: withinBudget,
          token_efficient: true
        })
      });
    },
    diff(policy: any, args: any, ctx: any) {
      const before = cleanText(args.before || '', 12000);
      const after = cleanText(args.after || '', 12000);
      const delta = lineDiff(before, after);
      const beforeTokens = estimateTokens(before);
      const afterTokens = estimateTokens(after);
      const deltaTokens = estimateTokens(`${delta.added.join('\n')}\n${delta.removed.join('\n')}`);
      const reduction = beforeTokens > 0 ? Number(((1 - (deltaTokens / beforeTokens)) * 100).toFixed(2)) : 0;
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'browser_text_diff',
        payload_json: JSON.stringify({
          ok: true,
          changed: delta.changed,
          ref: `diff_${sha12(`${before}|${after}`)}`,
          before_tokens: beforeTokens,
          after_tokens: afterTokens,
          delta_tokens: deltaTokens,
          token_reduction_pct: reduction,
          added: delta.added.slice(0, 20),
          removed: delta.removed.slice(0, 20)
        })
      });
    }
  }
});
