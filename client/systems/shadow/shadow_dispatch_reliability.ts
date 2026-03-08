#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { nowIso, cleanText, readJson, writeJsonAtomic } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.SHADOW_DISPATCH_RELIABILITY_POLICY_PATH
  ? path.resolve(process.env.SHADOW_DISPATCH_RELIABILITY_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'shadow', 'shadow_dispatch_reliability_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/shadow/shadow_dispatch_reliability.js enqueue --shadow=<id> --message=<text> [--idempotency-key=<key>] [--apply=1]');
  console.log('  node systems/shadow/shadow_dispatch_reliability.js dispatch [--limit=<n>] [--apply=1]');
  console.log('  node systems/shadow/shadow_dispatch_reliability.js ack --dispatch-id=<id> [--apply=1]');
  console.log('  node systems/shadow/shadow_dispatch_reliability.js status');
}

function sha(value: string) {
  return crypto.createHash('sha256').update(value).digest('hex').slice(0, 16);
}

function loadQueue(policy: any) {
  const queuePath = String(policy.paths.queue_path || '');
  return Array.isArray(readJson(queuePath, [])) ? readJson(queuePath, []) : [];
}

function saveQueue(policy: any, queue: any[]) {
  writeJsonAtomic(policy.paths.queue_path, queue);
}

runStandardLane({
  lane_id: 'V6-SHADOW-004',
  script_rel: 'systems/shadow/shadow_dispatch_reliability.js',
  policy_path: POLICY_PATH,
  stream: 'shadow.dispatch_reliability',
  paths: {
    memory_dir: 'client/local/state/shadow/dispatch_reliability/memory',
    adaptive_index_path: 'client/local/adaptive/shadow/dispatch_reliability/index.json',
    events_path: 'client/local/state/shadow/dispatch_reliability/events.jsonl',
    latest_path: 'client/local/state/shadow/dispatch_reliability/latest.json',
    receipts_path: 'client/local/state/shadow/dispatch_reliability/receipts.jsonl',
    queue_path: 'client/local/state/shadow/dispatch_reliability/queue.json'
  },
  usage,
  handlers: {
    enqueue(policy: any, args: any, ctx: any) {
      const shadow = cleanText(args.shadow || '', 80).toLowerCase();
      const message = cleanText(args.message || '', 2000);
      if (!shadow || !message) {
        return { ok: false, type: 'shadow_dispatch_reliability', action: 'enqueue', error: 'missing_shadow_or_message', ts: nowIso() };
      }
      const key = cleanText(args['idempotency-key'] || args.idempotency_key || `${shadow}|${message}`, 180);
      const queue = loadQueue(policy);
      const existing = queue.find((row: any) => String(row.idempotency_key || '') === key && row.status !== 'acked');
      if (existing) {
        return ctx.cmdRecord(policy, {
          ...args,
          event: 'shadow_dispatch_enqueue_idempotent_hit',
          payload_json: JSON.stringify({ ok: true, reused: true, dispatch_id: existing.dispatch_id, queue_depth: queue.length })
        });
      }
      const dispatchId = `sd_${sha(`${key}|${Date.now()}`)}`;
      queue.push({
        dispatch_id: dispatchId,
        shadow,
        message,
        idempotency_key: key,
        attempts: 0,
        status: 'pending',
        enqueued_at: nowIso(),
        updated_at: nowIso()
      });
      saveQueue(policy, queue);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'shadow_dispatch_enqueued',
        payload_json: JSON.stringify({ ok: true, dispatch_id: dispatchId, queue_depth: queue.length, idempotency_key: key })
      });
    },
    dispatch(policy: any, args: any, ctx: any) {
      const limit = Math.max(1, Math.min(100, Number(args.limit || 10)));
      const queue = loadQueue(policy);
      const maxRetries = Math.max(1, Number(policy.max_retries || 3));
      const processed = [];
      for (const row of queue) {
        if (processed.length >= limit) break;
        if (!['pending', 'retry'].includes(String(row.status || ''))) continue;
        row.attempts = Number(row.attempts || 0) + 1;
        row.updated_at = nowIso();
        if (row.attempts >= maxRetries) {
          row.status = 'escalated';
        } else {
          row.status = 'sent';
        }
        processed.push({
          dispatch_id: row.dispatch_id,
          status: row.status,
          attempts: row.attempts,
          shadow: row.shadow
        });
      }
      saveQueue(policy, queue);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'shadow_dispatch_cycle',
        payload_json: JSON.stringify({
          ok: true,
          processed,
          queue_depth: queue.length,
          escalated: processed.filter((row: any) => row.status === 'escalated').length
        })
      });
    },
    ack(policy: any, args: any, ctx: any) {
      const dispatchId = cleanText(args['dispatch-id'] || args.dispatch_id || '', 80);
      if (!dispatchId) {
        return { ok: false, type: 'shadow_dispatch_reliability', action: 'ack', error: 'dispatch_id_required', ts: nowIso() };
      }
      const queue = loadQueue(policy);
      const target = queue.find((row: any) => String(row.dispatch_id || '') === dispatchId);
      if (!target) {
        return { ok: false, type: 'shadow_dispatch_reliability', action: 'ack', error: 'dispatch_not_found', ts: nowIso() };
      }
      target.status = 'acked';
      target.acked_at = nowIso();
      target.updated_at = nowIso();
      saveQueue(policy, queue);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'shadow_dispatch_acked',
        payload_json: JSON.stringify({ ok: true, dispatch_id: dispatchId, status: target.status })
      });
    }
  }
});
