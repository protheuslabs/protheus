#!/usr/bin/env node
'use strict';
export {};

/** V3-RACE-003 */
const path = require('path');
const { spawnSync } = require('child_process');
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
    jetstream: {
      enabled: false,
      shadow_only: true,
      allow_shadow_publish: false,
      subject_prefix: 'protheus.events',
      publish_command: ['nats', 'pub'],
      timeout_ms: 5000
    },
    paths: {
      events_path: 'state/ops/event_sourced_control_plane/events.jsonl',
      views_path: 'state/ops/event_sourced_control_plane/materialized_views.json',
      latest_path: 'state/ops/event_sourced_control_plane/latest.json',
      receipts_path: 'state/ops/event_sourced_control_plane/receipts.jsonl',
      jetstream_latest_path: 'state/ops/event_sourced_control_plane/jetstream_latest.json'
    }
  };
  const raw = readJson(POLICY_PATH, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const jetstream = raw.jetstream && typeof raw.jetstream === 'object' ? raw.jetstream : {};
  const publishCommand = Array.isArray(jetstream.publish_command) && jetstream.publish_command.length > 0
    ? jetstream.publish_command.map((row: unknown) => String(row || '').trim()).filter(Boolean)
    : base.jetstream.publish_command;
  return {
    enabled: toBool(raw.enabled, base.enabled),
    shadow_only: toBool(raw.shadow_only, base.shadow_only),
    jetstream: {
      enabled: toBool(jetstream.enabled, base.jetstream.enabled),
      shadow_only: toBool(jetstream.shadow_only, base.jetstream.shadow_only),
      allow_shadow_publish: toBool(jetstream.allow_shadow_publish, base.jetstream.allow_shadow_publish),
      subject_prefix: normalizeToken(jetstream.subject_prefix || base.jetstream.subject_prefix, 120) || base.jetstream.subject_prefix,
      publish_command: publishCommand,
      timeout_ms: Number.isFinite(Number(jetstream.timeout_ms))
        ? Math.max(1000, Math.floor(Number(jetstream.timeout_ms)))
        : base.jetstream.timeout_ms
    },
    paths: {
      events_path: resolvePath(paths.events_path, base.paths.events_path),
      views_path: resolvePath(paths.views_path, base.paths.views_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      jetstream_latest_path: resolvePath(paths.jetstream_latest_path, base.paths.jetstream_latest_path)
    }
  };
}

function mirrorToJetStream(event: any, p: any) {
  const cfg = p.jetstream || {};
  const stream = normalizeToken(event && event.stream || 'control', 80) || 'control';
  const evt = normalizeToken(event && event.event || 'mutation', 80) || 'mutation';
  const subject = `${cfg.subject_prefix || 'protheus.events'}.${stream}.${evt}`;
  const payload = JSON.stringify({
    schema_id: 'event_sourced_control_plane_mirror',
    schema_version: '1.0',
    mirrored_at: nowIso(),
    event
  });
  const payload_hash = stableHash(payload, 32);

  if (cfg.enabled !== true) {
    return { mirrored: false, reason: 'jetstream_disabled', subject, payload_hash };
  }
  if (cfg.shadow_only === true && cfg.allow_shadow_publish !== true) {
    return { mirrored: false, reason: 'jetstream_shadow_only_simulated', subject, payload_hash };
  }
  const cmd = Array.isArray(cfg.publish_command) ? cfg.publish_command.filter(Boolean) : [];
  if (cmd.length < 1) {
    return { mirrored: false, reason: 'jetstream_publish_command_missing', subject, payload_hash };
  }

  const proc = spawnSync(cmd[0], cmd.slice(1).concat([subject, payload]), {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: Number(cfg.timeout_ms || 5000)
  });
  const status = Number(proc.status || 0);
  const ok = status === 0;
  const out = {
    mirrored: ok,
    reason: ok ? 'jetstream_publish_ok' : 'jetstream_publish_failed',
    subject,
    payload_hash,
    command: cmd,
    status,
    stderr: String(proc.stderr || '').trim().slice(0, 600)
  };
  writeJsonAtomic(p.paths.jetstream_latest_path, {
    ts: nowIso(),
    type: 'event_sourced_control_plane_jetstream_mirror',
    ...out
  });
  return out;
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
  const jetstreamMirror = mirrorToJetStream(event, p);
  const receipt = {
    ts: nowIso(),
    type: 'event_sourced_control_plane_append',
    ok: true,
    shadow_only: p.shadow_only,
    event_id: event.event_id,
    stream: event.stream,
    materialized_streams: Object.keys(byStream).length,
    jetstream: jetstreamMirror
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
  if (cmd === 'status') emit({
    ok: true,
    type: 'event_sourced_control_plane_status',
    latest: readJson(p.paths.latest_path, {}),
    jetstream_latest: readJson(p.paths.jetstream_latest_path, null)
  });
  emit({ ok: false, error: 'unsupported_command', cmd }, 1);
}

main();
