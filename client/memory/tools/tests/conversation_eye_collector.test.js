#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const collectorDriver = require(path.join(repoRoot, 'systems', 'sensory', 'collector_driver.js'));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'conversation-eye-collector-'));
  const inboxDir = path.join(tmp, 'cockpit', 'inbox');
  const memoryDir = path.join(tmp, 'memory', 'conversation_eye');
  fs.mkdirSync(inboxDir, { recursive: true });
  fs.mkdirSync(memoryDir, { recursive: true });

  const historyPath = path.join(inboxDir, 'history.jsonl');
  const latestPath = path.join(inboxDir, 'latest.json');
  const envelope = {
    ok: true,
    type: 'cockpit_context_envelope',
    ts: '2026-03-07T22:00:00.000Z',
    sequence: 42,
    attention: {
      batch_count: 1,
      events: [
        {
          event: {
            summary: 'manual_trigger_blocked_mech_suit_mode',
            source_type: 'spine_ambient_gate'
          }
        }
      ]
    },
    spine_status: {
      type: 'spine_status',
      summary: 'manual_trigger_blocked_mech_suit_mode'
    },
    dopamine_status: {
      breach_reasons: ['directive_pain_active']
    }
  };
  fs.writeFileSync(historyPath, `${JSON.stringify(envelope)}\n`, 'utf8');
  fs.writeFileSync(latestPath, `${JSON.stringify(envelope, null, 2)}\n`, 'utf8');

  process.env.CONVERSATION_EYE_HISTORY_PATH = historyPath;
  process.env.CONVERSATION_EYE_LATEST_PATH = latestPath;
  process.env.CONVERSATION_EYE_MEMORY_DIR = memoryDir;

  const eyeConfig = {
    id: 'conversation_eye',
    parser_type: 'conversation_eye',
    allowed_domains: ['local.workspace'],
    topics: ['conversation'],
    budgets: {
      max_items: 6,
      max_seconds: 8,
      max_bytes: 65536,
      max_requests: 1,
      max_rows: 96
    }
  };

  const preflight = await collectorDriver.preflightWithDriver(eyeConfig);
  assert.ok(preflight && preflight.ok === true, 'conversation_eye preflight must pass');

  const first = await collectorDriver.collectWithDriver(eyeConfig);
  assert.ok(first && first.success === true, 'first collection must succeed');
  assert.ok(Array.isArray(first.items), 'first collection must return items array');
  assert.ok(first.items.length >= 1, 'first collection should emit at least one item');
  const item = first.items[0];
  assert.ok(Array.isArray(item.node_tags), 'item should include node_tags');
  assert.ok(item.node_tags.includes('conversation'), 'node tags should include conversation');
  assert.ok(item.node_tags.includes('decision'), 'node tags should include decision');
  assert.ok(Array.isArray(item.edges_to) && item.edges_to.includes('spine'), 'edges_to should include spine');

  const memoryJsonl = path.join(memoryDir, 'nodes.jsonl');
  assert.ok(fs.existsSync(memoryJsonl), 'conversation memory node log should be written');
  const rows = fs.readFileSync(memoryJsonl, 'utf8').split('\n').filter(Boolean);
  assert.ok(rows.length >= 1, 'memory node log should contain at least one row');

  const second = await collectorDriver.collectWithDriver(eyeConfig);
  assert.ok(second && second.success === true, 'second collection must succeed');
  assert.strictEqual(second.items.length, 0, 'second collection should dedupe already-emitted node');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('conversation_eye_collector.test.js: OK');
}

run().catch((err) => {
  console.error(`conversation_eye_collector.test.js: FAIL: ${err && err.message ? err.message : err}`);
  process.exit(1);
});
