#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { cleanText, readJson } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.SHADOW_SIGNAL_CLASSIFIER_POLICY_PATH
  ? path.resolve(process.env.SHADOW_SIGNAL_CLASSIFIER_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'shadow', 'shadow_signal_classifier_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/shadow/shadow_signal_classifier.js classify --signal-json=<json>');
  console.log('  node systems/shadow/shadow_signal_classifier.js status');
}

function parseSignal(raw: string) {
  try {
    const parsed = JSON.parse(String(raw || '{}'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeTags(signal: any) {
  const tags = Array.isArray(signal.tags) ? signal.tags : [];
  const summary = cleanText(signal.summary || signal.message || '', 400).toLowerCase();
  const fromSummary = [];
  for (const token of ['revenue', 'security', 'infra', 'memory', 'persona', 'deadline', 'health']) {
    if (summary.includes(token)) fromSummary.push(token);
  }
  const out = [...tags, ...fromSummary]
    .map((row) => cleanText(row, 40).toLowerCase())
    .filter(Boolean);
  return Array.from(new Set(out));
}

function laneConfig(policy: any) {
  const raw = readJson(policy.policy_path, {});
  return {
    max_routes: Number(raw && raw.max_routes ? raw.max_routes : 3),
    route_map: raw && raw.route_map && typeof raw.route_map === 'object' ? raw.route_map : {},
    severity_boost: raw && raw.severity_boost && typeof raw.severity_boost === 'object' ? raw.severity_boost : {}
  };
}

function rankRoutes(policy: any, tags: string[], severity: string) {
  const config = laneConfig(policy);
  const routeMap = config.route_map;
  const severityBoost = config.severity_boost;
  const scores = new Map();

  for (const tag of tags) {
    const shadows = Array.isArray(routeMap[tag]) ? routeMap[tag] : [];
    for (const shadow of shadows) {
      const key = cleanText(shadow, 80).toLowerCase();
      if (!key) continue;
      scores.set(key, Number(scores.get(key) || 0) + 1);
    }
  }

  const boost = Number(severityBoost[String(severity || '').toLowerCase()] || 0);
  const routed = Array.from(scores.entries())
    .map(([shadow, score]) => ({
      shadow,
      score: Number((score + boost).toFixed(3)),
      reason: `tag_overlap:${score}`
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return a.shadow.localeCompare(b.shadow);
    });

  return routed.slice(0, Number(config.max_routes || 3));
}

runStandardLane({
  lane_id: 'V6-SHADOW-003',
  script_rel: 'systems/shadow/shadow_signal_classifier.js',
  policy_path: POLICY_PATH,
  stream: 'shadow.signal_classifier',
  paths: {
    memory_dir: 'client/local/state/shadow/signal_classifier/memory',
    adaptive_index_path: 'client/local/adaptive/shadow/signal_classifier/index.json',
    events_path: 'client/local/state/shadow/signal_classifier/events.jsonl',
    latest_path: 'client/local/state/shadow/signal_classifier/latest.json',
    receipts_path: 'client/local/state/shadow/signal_classifier/receipts.jsonl'
  },
  usage,
  handlers: {
    classify(policy: any, args: any, ctx: any) {
      const signal = parseSignal(args['signal-json'] || args.signal_json || '{}');
      const severity = cleanText(signal.severity || 'info', 24).toLowerCase();
      const tags = normalizeTags(signal);
      const routes = rankRoutes(policy, tags, severity);
      const confidence = routes.length === 0 ? 0 : Number((Math.min(1, (routes[0].score / 3))).toFixed(3));
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'shadow_signal_classified',
        payload_json: JSON.stringify({
          ok: true,
          signal_id: cleanText(signal.id || '', 80) || null,
          severity,
          tags,
          routes,
          confidence,
          reasons: routes.map((row: any) => row.reason)
        })
      });
    }
  }
});
