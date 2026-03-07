#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function parseLastJson(stdout) {
  const lines = String(stdout || '').split('\n').map(l => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line.startsWith('{') || !line.endsWith('}')) continue;
    try { return JSON.parse(line); } catch {}
  }
  return null;
}

function runScript(repoRoot, args, env) {
  const script = path.join(repoRoot, 'systems', 'autonomy', 'autonomy_controller.js');
  return spawnSync('node', [script, ...args], { cwd: repoRoot, encoding: 'utf8', env });
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_directive_clarification_preview');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  const testDate = '2099-12-31';
  const proposalsPath = path.join(repoRoot, 'state', 'sensory', 'proposals', `${testDate}.json`);
  const backupExists = fs.existsSync(proposalsPath);
  const backupBody = backupExists ? fs.readFileSync(proposalsPath, 'utf8') : null;

  try {
    writeJson(proposalsPath, [
      {
        id: 'PULSE-DIRECTIVE-CLARIFY',
        type: 'directive_clarification',
        title: 'Clarify and replan T1 objective execution',
        summary: 'Validate current Tier 1 directive quality and identify missing specifics.',
        expected_impact: 'medium',
        risk: 'low',
        validation: [
          'Directive intake validate returns ok=true',
          'Preview receipt shows executable=true'
        ],
        suggested_next_command: 'node client/systems/security/directive_intake.js validate --id=T1_make_jay_billionaire_v1 --file=client/config/directives/T1_make_jay_billionaire_v1.yaml',
        evidence: [
          { evidence_ref: 'eye:directive_pulse/T1_make_jay_billionaire_v1' }
        ],
        meta: {
          source_eye: 'directive_pulse',
          directive_objective_id: 'T1_make_jay_billionaire_v1',
          relevance_score: 78,
          relevance_tier: 'high',
          signal_quality_score: 72,
          signal_quality_tier: 'medium'
        }
      }
    ]);

    const env = {
      ...process.env,
      AUTONOMY_STATE_DIR: path.join(tmpRoot, 'autonomy'),
      AUTONOMY_MODEL_CATALOG_ENABLED: '0',
      AUTONOMY_DIRECTIVE_PULSE_ENABLED: '0',
      AUTONOMY_DIRECTIVE_DECOMPOSE_ENABLED: '0',
      AUTONOMY_CAMPAIGN_DECOMPOSE_ENABLED: '0',
      AUTONOMY_FORCE_PROPOSAL_ID: 'PULSE-DIRECTIVE-CLARIFY',
      AUTONOMY_MIN_SIGNAL_QUALITY: '0',
      AUTONOMY_MIN_DIRECTIVE_FIT: '0',
      AUTONOMY_MIN_ACTIONABILITY_SCORE: '0',
      AUTONOMY_MIN_COMPOSITE_ELIGIBILITY: '0',
      AUTONOMY_ALLOWED_RISKS: 'low,medium,high',
      AUTONOMY_SCORE_ONLY_EVIDENCE: '1'
    };

    const r = runScript(repoRoot, ['evidence', testDate], env);
    assert.strictEqual(r.status, 0, `evidence run should pass: ${r.stderr}`);
    const out = parseLastJson(r.stdout);
    assert.ok(out && typeof out === 'object', 'expected JSON output');
    assert.strictEqual(out.result, 'score_only_evidence');
    assert.strictEqual(out.execution_target, 'directive');
    assert.ok(out.preview_summary && typeof out.preview_summary === 'object', 'expected preview_summary');
    assert.strictEqual(out.preview_summary.decision, 'DIRECTIVE_VALIDATE');
    assert.strictEqual(out.preview_summary.executable, true);
    assert.strictEqual(out.preview_summary.gate_decision, 'ALLOW');
    assert.strictEqual(out.preview_summary.file, 'client/config/directives/T1_make_jay_billionaire_v1.yaml');
    assert.ok(out.preview_verification && out.preview_verification.passed === true, 'expected passing preview_verification');

    console.log('directive_clarification_preview.integration.test.js: OK');
  } finally {
    if (backupExists) fs.writeFileSync(proposalsPath, backupBody, 'utf8');
    else if (fs.existsSync(proposalsPath)) fs.rmSync(proposalsPath, { force: true });
  }
}

try {
  run();
} catch (err) {
  console.error(`directive_clarification_preview.integration.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
