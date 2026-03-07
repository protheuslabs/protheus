#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

function parsePayload(stdout) {
  const raw = String(stdout || '').trim();
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function isTrit(value) {
  return value === -1 || value === 0 || value === 1;
}

function run() {
  const root = path.resolve(__dirname, '..', '..', '..');
  const modulePath = path.join(root, 'systems', 'workflow', 'orchestron', 'intent_analyzer.js');
  const scriptPath = modulePath;
  const { analyzeIntent } = require(modulePath);

  const highRiskIntent = analyzeIntent(
    'Quickly explore maybe unknown external api publish workflow with strict budget and safety constraints'
  );
  assert.ok(highRiskIntent && typeof highRiskIntent === 'object', 'intent analyzer should return object');
  assert.ok(String(highRiskIntent.objective || '').length > 0, 'intent objective should be populated');
  assert.ok(['low', 'medium', 'high'].includes(String(highRiskIntent.uncertainty_band || '')), 'uncertainty band should be normalized');
  assert.strictEqual(highRiskIntent.uncertainty_band, 'high', 'uncertainty keywords should map to high uncertainty');
  assert.ok(highRiskIntent.constraints && typeof highRiskIntent.constraints === 'object', 'constraints should exist');
  const weightSum = Number(highRiskIntent.constraints.speed_weight || 0)
    + Number(highRiskIntent.constraints.robustness_weight || 0)
    + Number(highRiskIntent.constraints.cost_weight || 0);
  assert.ok(Math.abs(weightSum - 1) < 0.02, 'constraint weights should normalize to ~1');
  assert.ok(highRiskIntent.risk_signals && typeof highRiskIntent.risk_signals === 'object', 'risk_signals should exist');
  assert.ok(isTrit(highRiskIntent.risk_signals.feasibility), 'feasibility should be trit-shaped');
  assert.ok(isTrit(highRiskIntent.risk_signals.risk), 'risk should be trit-shaped');
  assert.ok(isTrit(highRiskIntent.risk_signals.novelty), 'novelty should be trit-shaped');
  assert.strictEqual(highRiskIntent.risk_signals.risk, -1, 'external execution language should increase risk pressure');

  const lowUncertaintyIntent = analyzeIntent('Ship 3 low-risk automation steps with deterministic guard checks');
  assert.strictEqual(lowUncertaintyIntent.uncertainty_band, 'low', 'numeric/scoped intents should classify as low uncertainty');
  assert.ok(lowUncertaintyIntent.risk_signals && isTrit(lowUncertaintyIntent.risk_signals.risk), 'risk signal should stay trit-shaped');

  const cli = spawnSync(process.execPath, [
    scriptPath,
    'run',
    '--intent=Build robust low-cost workflow with external API surface'
  ], {
    cwd: root,
    encoding: 'utf8'
  });
  assert.strictEqual(cli.status, 0, cli.stderr || 'intent analyzer CLI should exit 0');
  const payload = parsePayload(cli.stdout);
  assert.ok(payload && payload.ok === true, 'CLI output should be ok');
  assert.ok(payload.intent && payload.intent.objective, 'CLI payload should include objective');
  assert.ok(payload.intent.constraints, 'CLI payload should include constraints');
  assert.ok(payload.intent.uncertainty_band, 'CLI payload should include uncertainty band');
  assert.ok(payload.intent.risk_signals, 'CLI payload should include trit risk signals');

  console.log('orchestron_intent_analyzer.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`orchestron_intent_analyzer.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
