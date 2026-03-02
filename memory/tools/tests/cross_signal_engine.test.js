#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function appendJsonl(p, rows) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
}

function eventsFor(dateStr, eyeId, topic, count) {
  const out = [];
  out.push({
    ts: `${dateStr}T08:00:00.000Z`,
    type: 'eye_run_started',
    eye_id: eyeId
  });
  for (let i = 0; i < count; i++) {
    out.push({
      ts: `${dateStr}T08:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'external_item',
      eye_id: eyeId,
      title: `${topic} signal ${i + 1}`,
      url: `https://example.com/${eyeId}/${dateStr}/${i}`,
      topics: [topic]
    });
  }
  out.push({
    ts: `${dateStr}T09:00:00.000Z`,
    type: 'eye_run_ok',
    eye_id: eyeId,
    items_collected: count
  });
  return out;
}

function run() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-signal-engine-'));
  const sensoryDir = path.join(tmpRoot, 'state', 'sensory');
  const rawDir = path.join(sensoryDir, 'eyes', 'raw');
  const envBefore = process.env.CROSS_SIGNAL_SENSORY_DIR;
  process.env.CROSS_SIGNAL_SENSORY_DIR = sensoryDir;

  try {
    appendJsonl(path.join(rawDir, '2026-02-19.jsonl'), [
      ...eventsFor('2026-02-19', 'eye_a', 'automation', 3),
      ...eventsFor('2026-02-19', 'eye_b', 'automation', 2)
    ]);
    appendJsonl(path.join(rawDir, '2026-02-20.jsonl'), [
      ...eventsFor('2026-02-20', 'eye_a', 'automation', 2),
      ...eventsFor('2026-02-20', 'eye_b', 'automation', 2)
    ]);
    appendJsonl(path.join(rawDir, '2026-02-21.jsonl'), [
      ...eventsFor('2026-02-21', 'eye_a', 'automation', 4),
      ...eventsFor('2026-02-21', 'eye_b', 'automation', 3),
      ...eventsFor('2026-02-21', 'eye_c', 'automation', 2),
      {
        ts: '2026-02-21T10:10:00.000Z',
        type: 'external_item',
        eye_id: 'eye_b',
        title: 'automation rollout failed due outage',
        url: 'https://example.com/eye_b/negative/1',
        topics: ['automation']
      },
      {
        ts: '2026-02-21T11:10:00.000Z',
        type: 'external_item',
        eye_id: 'eye_c',
        title: 'automation blocked by deployment error',
        url: 'https://example.com/eye_c/negative/1',
        topics: ['automation']
      }
    ]);

    const { analyze } = require('../../../systems/sensory/cross_signal_engine.js');
    const rep = analyze({ dateStr: '2026-02-21', lookbackDays: 3 });
    assert.ok(rep && rep.type === 'cross_signal_hypotheses');
    assert.ok(Array.isArray(rep.hypotheses));
    assert.ok(rep.hypotheses.length >= 1, 'expected at least one hypothesis');

    const convergence = rep.hypotheses.find((h) => h && h.type === 'convergence' && h.topic === 'automation');
    assert.ok(convergence, 'expected automation convergence hypothesis');
    assert.ok(Number(convergence.support_eyes || 0) >= 2, 'convergence should include multiple eyes');
    assert.ok(Number(convergence.confidence || 0) >= 1, 'convergence should have confidence');

    const negativeSignal = rep.hypotheses.find((h) => h && h.type === 'negative_signal' && h.topic === 'automation');
    assert.ok(negativeSignal, 'expected automation negative-signal hypothesis');
    assert.ok(Array.isArray(negativeSignal.negative_terms) && negativeSignal.negative_terms.length >= 1, 'negative-signal should include extracted terms');

    const temporalDelta = rep.hypotheses.find((h) => h && h.type === 'temporal_delta' && h.topic === 'automation');
    assert.ok(temporalDelta, 'expected automation temporal-delta hypothesis');
    assert.ok(rep.temporal_deltas && Array.isArray(rep.temporal_deltas), 'expected temporal delta report lane');
    assert.ok(rep.temporal_deltas.some((row) => row && row.topic === 'automation'), 'expected automation temporal delta entry');

    console.log('cross_signal_engine.test.js: OK');
  } finally {
    if (envBefore == null) delete process.env.CROSS_SIGNAL_SENSORY_DIR;
    else process.env.CROSS_SIGNAL_SENSORY_DIR = envBefore;
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  run();
} catch (err) {
  console.error(`cross_signal_engine.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
