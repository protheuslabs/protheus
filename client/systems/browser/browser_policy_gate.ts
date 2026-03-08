#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { cleanText } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.BROWSER_POLICY_GATE_POLICY_PATH
  ? path.resolve(process.env.BROWSER_POLICY_GATE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'browser', 'browser_policy_gate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/browser/browser_policy_gate.js check --url=https://example.com --action=navigate');
  console.log('  node systems/browser/browser_policy_gate.js status');
}

function loadPolicyExtras(policyPath: string) {
  const fs = require('fs');
  try {
    const raw = JSON.parse(String(fs.readFileSync(policyPath, 'utf8') || '{}'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

runStandardLane({
  lane_id: 'V6-BROWSER-005',
  script_rel: 'systems/browser/browser_policy_gate.js',
  policy_path: POLICY_PATH,
  stream: 'browser.policy_gate',
  paths: {
    memory_dir: 'client/local/state/browser/policy_gate/memory',
    adaptive_index_path: 'client/local/adaptive/browser/policy_gate/index.json',
    events_path: 'client/local/state/browser/policy_gate/events.jsonl',
    latest_path: 'client/local/state/browser/policy_gate/latest.json',
    receipts_path: 'client/local/state/browser/policy_gate/receipts.jsonl'
  },
  usage,
  handlers: {
    check(policy: any, args: any, ctx: any) {
      const extras = loadPolicyExtras(String(policy.policy_path || POLICY_PATH));
      const url = cleanText(args.url || '', 260);
      const action = cleanText(args.action || '', 80).toLowerCase();
      const allowDomains = Array.isArray(extras.allow_domains) ? extras.allow_domains.map((d: string) => String(d).toLowerCase()) : [];
      const allowActions = Array.isArray(extras.allow_actions) ? extras.allow_actions.map((d: string) => String(d).toLowerCase()) : [];
      const host = (() => {
        try { return new URL(url).hostname.toLowerCase(); } catch { return ''; }
      })();
      const domainOk = !!host && (allowDomains.includes(host) || allowDomains.some((d: string) => d.startsWith('*.') && host.endsWith(d.slice(1))));
      const actionOk = allowActions.includes(action);
      const allowed = domainOk && actionOk;
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'browser_policy_gate_check',
        payload_json: JSON.stringify({
          ok: allowed,
          allowed,
          fail_closed: !allowed,
          host,
          action,
          reason: allowed ? 'policy_allow' : (!domainOk ? 'domain_denied' : 'action_denied')
        })
      });
    }
  }
});
