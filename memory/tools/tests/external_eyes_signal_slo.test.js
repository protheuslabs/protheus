#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

function writeJson(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function appendJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const list = Array.isArray(rows) ? rows : [];
  const body = list.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, body ? `${body}\n` : '', 'utf8');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'external-eyes-slo-'));
  const eyesStateDir = path.join(tmpRoot, 'state', 'sensory', 'eyes');
  const proposalsDir = path.join(tmpRoot, 'state', 'sensory', 'proposals');
  const queueLogPath = path.join(tmpRoot, 'state', 'sensory', 'queue_log.jsonl');
  const today = '2026-02-27';
  const rawPath = path.join(eyesStateDir, 'raw', `${today}.jsonl`);

  process.env.EYES_STATE_DIR = eyesStateDir;
  process.env.EYES_SENSORY_PROPOSALS_DIR = proposalsDir;
  process.env.EYES_SENSORY_QUEUE_LOG_PATH = queueLogPath;
  process.env.EYES_SLO_MIN_REAL_EXTERNAL_ITEMS = '1';
  process.env.EYES_SLO_MIN_ACCEPTED_ITEMS = '1';
  process.env.EYES_SLO_MIN_PROPOSAL_GENERATED = '1';

  const eyes = require('../../../habits/scripts/external_eyes.js');

  appendJsonl(rawPath, [
    { ts: `${today}T01:00:00.000Z`, type: 'external_item', eye_id: 'eye_live', title: 'Real Item 1' }
  ]);

  const testConfig = {
    version: '1.0-test',
    eyes: [
      { id: 'eye_live', parser_type: 'hn_rss', status: 'active' }
    ]
  };

  const gated = eyes.signalSlo(today, { silent: true, config: testConfig });
  assert.strictEqual(gated.ok, true, 'slo should pass while post-processing is pending');
  assert.strictEqual(gated.post_processing_ready, false, 'post processing should be pending');
  assert.strictEqual(gated.checks.real_external_items.ok, true, 'real external items should pass');
  assert.strictEqual(gated.checks.accepted_items.skipped, true, 'accepted_items should be skipped while pending');
  assert.strictEqual(gated.checks.proposal_generated.skipped, true, 'proposal_generated should be skipped while pending');

  appendJsonl(queueLogPath, [
    { ts: `${today}T01:10:00.000Z`, type: 'proposal_generated', date: today, proposal_id: 'PRP-1' }
  ]);
  writeJson(path.join(proposalsDir, `${today}.json`), { proposals: [] });

  const enforcedFail = eyes.signalSlo(today, { silent: true, config: testConfig });
  assert.strictEqual(enforcedFail.post_processing_ready, true, 'post processing should be ready once queue activity exists');
  assert.strictEqual(enforcedFail.ok, false, 'slo should fail when accepted_items remain below threshold after post-processing');
  assert.ok(enforcedFail.failed_checks.includes('accepted_items'), 'accepted_items should fail after post-processing');
  assert.strictEqual(enforcedFail.checks.proposal_generated.ok, true, 'proposal_generated should pass when event exists');

  writeJson(path.join(proposalsDir, `${today}.json`), {
    proposals: [
      { type: 'external_intel', status: 'open' }
    ]
  });

  const enforcedPass = eyes.signalSlo(today, { silent: true, config: testConfig });
  assert.strictEqual(enforcedPass.post_processing_ready, true);
  assert.strictEqual(enforcedPass.ok, true, 'slo should pass once accepted and generated thresholds are met');
  assert.strictEqual(enforcedPass.checks.accepted_items.ok, true);
  assert.strictEqual(enforcedPass.checks.proposal_generated.ok, true);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('external_eyes_signal_slo.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`external_eyes_signal_slo.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
