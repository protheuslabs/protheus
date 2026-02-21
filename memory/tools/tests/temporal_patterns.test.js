#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function appendJsonl(p, rows) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(
    p,
    rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''),
    'utf8'
  );
}

function dayEvents(dateStr, eyeId, realItems) {
  const rows = [{
    ts: `${dateStr}T08:00:00.000Z`,
    type: 'eye_run_started',
    eye_id: eyeId
  }];
  for (let i = 0; i < realItems; i++) {
    rows.push({
      ts: `${dateStr}T08:00:01.000Z`,
      type: 'external_item',
      eye_id: eyeId,
      id: `${eyeId}-${dateStr}-${i}`,
      item_hash: `${eyeId}-${dateStr}-${i}`,
      title: `Real signal ${i + 1}`,
      url: `https://example.com/${eyeId}/${dateStr}/${i}`,
      topics: ['reliability']
    });
  }
  rows.push({
    ts: `${dateStr}T08:00:02.000Z`,
    type: 'eye_run_ok',
    eye_id: eyeId,
    items_collected: realItems,
    focus_selected: 0
  });
  return rows;
}

function run() {
  const tmpRoot = path.join(__dirname, 'temp_temporal_patterns');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  ensureDir(tmpRoot);

  try {
    const sensoryDir = path.join(tmpRoot, 'state', 'sensory');
    const rawDir = path.join(sensoryDir, 'eyes', 'raw');
    const trendsDir = path.join(sensoryDir, 'trends');
    const anomaliesDir = path.join(sensoryDir, 'anomalies');
    const registryPath = path.join(sensoryDir, 'eyes', 'registry.json');
    const catalogPath = path.join(tmpRoot, 'adaptive', 'sensory', 'eyes', 'catalog.json');

    writeJson(catalogPath, {
      version: '1.0',
      eyes: [
        {
          id: 'eye_dark',
          status: 'active',
          parser_type: 'hn_rss',
          cadence_hours: 4,
          allowed_domains: ['example.com'],
          budgets: { max_items: 10, max_seconds: 10, max_bytes: 2048, max_requests: 1 }
        },
        {
          id: 'eye_ok',
          status: 'active',
          parser_type: 'hn_rss',
          cadence_hours: 4,
          allowed_domains: ['example.com'],
          budgets: { max_items: 10, max_seconds: 10, max_bytes: 2048, max_requests: 1 }
        }
      ]
    });

    writeJson(registryPath, {
      version: '1.0',
      eyes: [
        {
          id: 'eye_dark',
          status: 'active',
          parser_type: 'hn_rss',
          cadence_hours: 4,
          total_items: 30,
          last_success: '2026-02-20T00:00:00.000Z'
        },
        {
          id: 'eye_ok',
          status: 'active',
          parser_type: 'hn_rss',
          cadence_hours: 4,
          total_items: 30,
          last_success: '2026-02-21T08:00:00.000Z'
        }
      ]
    });

    appendJsonl(path.join(rawDir, '2026-02-17.jsonl'), [
      ...dayEvents('2026-02-17', 'eye_dark', 3),
      ...dayEvents('2026-02-17', 'eye_ok', 2)
    ]);
    appendJsonl(path.join(rawDir, '2026-02-18.jsonl'), [
      ...dayEvents('2026-02-18', 'eye_dark', 2),
      ...dayEvents('2026-02-18', 'eye_ok', 2)
    ]);
    appendJsonl(path.join(rawDir, '2026-02-19.jsonl'), [
      ...dayEvents('2026-02-19', 'eye_dark', 4),
      ...dayEvents('2026-02-19', 'eye_ok', 3)
    ]);
    appendJsonl(path.join(rawDir, '2026-02-20.jsonl'), [
      ...dayEvents('2026-02-20', 'eye_dark', 2),
      ...dayEvents('2026-02-20', 'eye_ok', 2)
    ]);
    appendJsonl(path.join(rawDir, '2026-02-21.jsonl'), [
      ...dayEvents('2026-02-21', 'eye_dark', 0),
      ...dayEvents('2026-02-21', 'eye_ok', 2)
    ]);

    appendJsonl(path.join(sensoryDir, 'queue_log.jsonl'), [
      { ts: '2026-02-20T12:00:00.000Z', type: 'proposal_generated', date: '2026-02-20', proposal_id: 'P1' },
      { ts: '2026-02-21T12:00:00.000Z', type: 'proposal_generated', date: '2026-02-21', proposal_id: 'P2' }
    ]);

    const { analyzeTemporalPatterns } = require('../../../systems/sensory/temporal_patterns.js');
    const rep = analyzeTemporalPatterns({
      workspaceDir: tmpRoot,
      sensoryDir,
      dateStr: '2026-02-21',
      lookbackDays: 5,
      write: true
    });

    assert.ok(rep && rep.type === 'temporal_patterns', 'should return temporal report');
    assert.ok(Array.isArray(rep.by_eye), 'should include eye rows');
    const dark = (rep.dark_candidates || []).find((x) => x && x.eye_id === 'eye_dark');
    assert.ok(dark, 'eye_dark should be identified as dark candidate');
    const okEye = (rep.dark_candidates || []).find((x) => x && x.eye_id === 'eye_ok');
    assert.ok(!okEye, 'eye_ok should not be dark candidate');

    assert.ok(fs.existsSync(path.join(trendsDir, '2026-02-21.json')), 'trend report should be written');
    assert.ok(fs.existsSync(path.join(anomaliesDir, '2026-02-21.temporal.json')), 'temporal anomalies should be written');

    console.log('temporal_patterns.test.js: OK');
  } finally {
    if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
}

try {
  run();
} catch (err) {
  console.error(`temporal_patterns.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
