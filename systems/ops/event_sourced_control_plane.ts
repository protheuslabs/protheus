#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-003 */
const path = require('path');
const {
  ROOT, nowIso, parseArgs, normalizeToken, toBool, readJson,
  readJsonl, writeJsonAtomic, appendJsonl, resolvePath, stableHash, emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH
  ? path.resolve(process.env.EVENT_SOURCED_CONTROL_PLANE_POLICY_PATH)
  : path.join(ROOT, 'config', 'event_sourced_control_plane_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/event_sourced_control_plane.js append --stream=<id> --event=<id> [--payload_json={}]');
  console.log('  node systems/ops/event_sourced_control_plane.js replay');
  console.log('  node systems/ops/event_sourced_control_plane.js status');
}

function policy() {
  const base = {
    enabled: true,
    shadow_only: true,
    paths: {
      events_path: 'state/ops/event_sourced_control_plane/events.jsonl',
      views_path: 'state/ops/event_sourced_control_plane/materialized_views.json',
      latest_path: 'state/ops/event_sourced_control_plane/latest.json',
      receipts_path: 'state/ops/event_sourced_control_plane/receipts.jsonl'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    paths: {
      events_path: resolvePath(paths.events_path, base.paths.events_path),
      views_path: resolvePath(paths.views_path, base.paths.views_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    }
  };
}

function appendEvent(args: any, p: any) {
  const event = {
    ts: nowIso(),
    event_id: `evt_${Date.now()}_${stableHash(JSON.stringify(args), 8)}`,
    stream: normalizeToken(args.stream || 'control', 80) || 'control',
    event: normalizeToken(args.event || 'mutation', 80) || 'mutation',
    payload: (() => {
      if (!args.payload_json) return {};
      try { return JSON.parse(String(args.payload_json)); } catch { return { raw: String(args.payload_json) }; }
    })()
  };
  appendJsonl(p.paths.events_path, event);
  const all = readJsonl(p.paths.events_path);
  const byStream: Record<string, any> = {};
  for (const row of all.slice(-5000)) {
    const stream = normalizeToken(row.stream || 'control', 80) || 'control';
    byStream[stream] = byStream[stream] || { stream, events: 0, last_event: null };
    byStream[stream].events += 1;
    byStream[stream].last_event = row.event;
  }
  writeJsonAtomic(p.paths.views_path, { schema_version: '1.0', generated_at: nowIso(), streams: Object.values(byStream) });
  const receipt = {
    ts: nowIso(),
    type: 'event_sourced_control_plane_append',
    ok: true,
    shadow_only: p.shadow_only,
    event_id: event.event_id,
    stream: event.stream,
    materialized_streams: Object.keys(byStream).length
  };
  writeJsonAtomic(p.paths.latest_path, receipt);
  appendJsonl(p.paths.receipts_path, receipt);
  return receipt;
}

function replay(p: any) {
  const events = readJsonl(p.paths.events_path);
  const streams: Record<string, number> = {};
  for (const row of events) {
    const stream = normalizeToken(row.stream || 'control', 80) || 'control';
    streams[stream] = (streams[stream] || 0) + 1;
  }
  const receipt = {
    ts: nowIso(),
    type: 'event_sourced_control_plane_replay',
    ok: true,
    shadow_only: p.shadow_only,
    replay_event_count: events.length,
    stream_count: Object.keys(streams).length
  };
  writeJsonAtomic(p.paths.latest_path, receipt);
  appendJsonl(p.paths.receipts_path, receipt);
  return receipt;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === '--help' || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }
  const p = policy();
  if (!p.enabled) emit({ ok: false, error: 'event_sourced_control_plane_disabled' }, 1);
  if (cmd === 'append') emit(appendEvent(args, p));
  if (cmd === 'replay') emit(replay(p));
  if (cmd === 'status') emit({ ok: true, type: 'event_sourced_control_plane_status', latest: readJson(p.paths.latest_path, {}) });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
