#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const PROTHEUSCTL = path.join(ROOT, 'systems', 'ops', 'protheusctl.js');

function run(args, workspace) {
  const proc = spawnSync(process.execPath, [PROTHEUSCTL, ...args], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { OPENCLAW_WORKSPACE: workspace }),
    encoding: 'utf8'
  });
  return {
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function ensureHeavyDynamicContext(personaDir) {
  const longBody = 'drift parity sovereignty evidence '.repeat(180);
  const correspondencePath = path.join(personaDir, 'correspondence.md');
  const memoryPath = path.join(personaDir, 'memory.md');
  fs.appendFileSync(
    correspondencePath,
    `\n## 2026-03-03 - Re: heavy dynamic context\n\n${longBody}\n`,
    'utf8'
  );
  fs.appendFileSync(
    memoryPath,
    `\n### node:heavy-context-${Date.now()}\n- date: 2026-03-03\n- tags: [drift,context,budget]\n\n${longBody}\n`,
    'utf8'
  );
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

try {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-persona-budget-'));
  fs.mkdirSync(path.join(tmpRoot, 'personas'), { recursive: true });

  for (const persona of ['vikram_menon', 'rohan_kapoor']) {
    fs.cpSync(path.join(ROOT, 'personas', persona), path.join(tmpRoot, 'personas', persona), { recursive: true });
    ensureHeavyDynamicContext(path.join(tmpRoot, 'personas', persona));
  }

  let out = run([
    'lens',
    'vikram_menon',
    '--max-context-tokens=460',
    '--context-budget-mode=trim',
    'Should we prioritize memory or security first?'
  ], tmpRoot);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('**Context Guard Action:** `trimmed`'), 'trim mode should trim over-budget context');

  let telemetryRows = readJsonl(path.join(tmpRoot, 'personas', 'organization', 'telemetry.jsonl'));
  let budgetRows = telemetryRows.filter((row) => row && row.metric === 'context_budget_guard' && row.persona_id === 'vikram_menon');
  assert.ok(budgetRows.length >= 1, 'trim run should emit context_budget_guard telemetry for vikram');
  assert.ok(budgetRows.some((row) => Number(row.trimmed || 0) === 1), 'trim telemetry row should mark trimmed=1');

  let correspondence = fs.readFileSync(path.join(tmpRoot, 'personas', 'vikram_menon', 'correspondence.md'), 'utf8');
  assert.ok(correspondence.includes('Re: context budget guard'), 'trim run should append correspondence guard entry');
  assert.ok(correspondence.includes('Action: trimmed'), 'trim correspondence entry should record trimmed action');

  out = run([
    'lens',
    'vikram_menon',
    '--max-context-tokens=460',
    '--context-budget-mode=reject',
    'Should we prioritize memory or security first?'
  ], tmpRoot);
  assert.notStrictEqual(out.status, 0, 'reject mode should fail when context exceeds budget');
  assert.ok(out.stderr.includes('context_budget_exceeded'), 'reject mode should surface explicit context budget error');

  telemetryRows = readJsonl(path.join(tmpRoot, 'personas', 'organization', 'telemetry.jsonl'));
  budgetRows = telemetryRows.filter((row) => row && row.metric === 'context_budget_guard' && row.persona_id === 'vikram_menon');
  assert.ok(budgetRows.some((row) => Number(row.rejected || 0) === 1), 'reject run should emit rejected context budget telemetry');

  correspondence = fs.readFileSync(path.join(tmpRoot, 'personas', 'vikram_menon', 'correspondence.md'), 'utf8');
  assert.ok(correspondence.includes('Action: rejected'), 'reject run should append rejected guard entry');

  out = run([
    'lens',
    'vikram_menon',
    'rohan_kapoor',
    '--max-context-tokens=460',
    '--context-budget-mode=trim',
    'Prioritize memory or security first?'
  ], tmpRoot);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Lens Response: Multi Persona'), 'multi-persona run should still succeed under trim mode');

  out = run([
    'lens',
    'trigger',
    'drift-alert',
    '--persona=vikram_menon',
    '--max-context-tokens=460',
    '--context-budget-mode=trim',
    'Drift alert review for budget enforcement'
  ], tmpRoot);
  assert.strictEqual(out.status, 0, out.stderr || out.stdout);
  assert.ok(out.stdout.includes('# Trigger: drift-alert'), 'drift-alert trigger should execute under budget guard');

  telemetryRows = readJsonl(path.join(tmpRoot, 'personas', 'organization', 'telemetry.jsonl'));
  const triggerBudgetRows = telemetryRows.filter((row) => row && row.metric === 'context_budget_guard' && row.invocation === 'trigger_drift_alert');
  assert.ok(triggerBudgetRows.length >= 1, 'trigger path should emit context budget guard telemetry');

  console.log('personas_context_budget_guard.test.js: OK');
} catch (err) {
  console.error(`personas_context_budget_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
