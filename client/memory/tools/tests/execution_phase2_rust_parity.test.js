#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { runWorkflowLegacySpec } = require(path.join(ROOT, 'systems', 'execution', 'legacy_runtime.js'));

function fail(msg) {
  console.error(`❌ execution_phase2_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function normalizeReceipt(raw) {
  const state = raw && raw.state && typeof raw.state === 'object' ? raw.state : {};
  return {
    workflow_id: String(raw && raw.workflow_id || ''),
    status: String(raw && raw.status || ''),
    deterministic: Boolean(raw && raw.deterministic),
    replayable: Boolean(raw && raw.replayable),
    processed_steps: Number(raw && raw.processed_steps || 0),
    pause_reason: raw && raw.pause_reason ? String(raw.pause_reason) : null,
    event_digest: String(raw && raw.event_digest || ''),
    events: Array.isArray(raw && raw.events) ? raw.events.slice() : [],
    state: {
      cursor: Number(state.cursor || 0),
      paused: Boolean(state.paused),
      completed: Boolean(state.completed),
      last_step_id: state.last_step_id == null ? null : String(state.last_step_id),
      processed_step_ids: Array.isArray(state.processed_step_ids) ? state.processed_step_ids.slice() : [],
      processed_events: Number(state.processed_events || 0),
      digest: String(state.digest || '')
    },
    metadata: raw && raw.metadata && typeof raw.metadata === 'object' ? { ...raw.metadata } : {},
    warnings: Array.isArray(raw && raw.warnings) ? raw.warnings.slice() : []
  };
}

function parsePayload(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runRust(spec) {
  const bin = path.join(ROOT, 'target', 'release', 'execution_core');
  const encoded = Buffer.from(JSON.stringify(spec || {}), 'utf8').toString('base64');
  const out = spawnSync(bin, ['run', `--yaml-base64=${encoded}`], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  const payload = parsePayload(out.stdout);
  if (Number(out.status) !== 0 || !payload || typeof payload !== 'object') {
    fail(`rust runner failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
  return normalizeReceipt(payload);
}

function runLegacy(spec) {
  return normalizeReceipt(runWorkflowLegacySpec(spec));
}

function seeded(seed) {
  let x = (seed >>> 0) ^ 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function buildChaosSpec(seed) {
  const rnd = seeded(seed + 1);
  const steps = [];
  const stepCount = 3 + Math.floor(rnd() * 5);
  for (let i = 0; i < stepCount; i += 1) {
    steps.push({
      id: `s_${seed}_${i}`,
      kind: i % 2 ? 'task' : 'command',
      action: i % 3 ? 'analyze' : 'route',
      command: `cmd_${seed}_${i}_${Math.floor(rnd() * 1000)}`,
      pause_after: false,
      params: {
        shard: String(Math.floor(rnd() * 3)),
        priority: String(Math.floor(rnd() * 4))
      }
    });
  }
  return {
    workflow_id: `chaos_${seed}`,
    deterministic_seed: `seed_${seed}`,
    steps,
    metadata: {
      lane: 'phase2',
      cohort: seed % 2 ? 'odd' : 'even'
    }
  };
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', 'core/layer2/execution/Cargo.toml', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 260)}`);
  }
}

function main() {
  ensureReleaseBinary();

  const baseSpec = {
    workflow_id: 'phase2_base',
    deterministic_seed: 'phase2_seed',
    steps: [
      { id: 'collect', kind: 'task', action: 'collect_data', command: 'collect --source=eyes' },
      { id: 'score', kind: 'task', action: 'score', command: 'score --strategy=deterministic' },
      { id: 'ship', kind: 'task', action: 'ship', command: 'ship --mode=canary' }
    ],
    metadata: {
      owner: 'execution_phase2',
      ring: 'canary'
    }
  };

  const rustBase = runRust(baseSpec);
  const legacyBase = runLegacy(baseSpec);
  assert.deepStrictEqual(rustBase, legacyBase, 'base parity should match exactly');

  const pausedSpec = {
    ...baseSpec,
    workflow_id: 'phase2_pause',
    pause_after_step: 'score'
  };
  const rustPaused = runRust(pausedSpec);
  const legacyPaused = runLegacy(pausedSpec);
  assert.deepStrictEqual(rustPaused, legacyPaused, 'paused parity should match exactly');
  assert.strictEqual(rustPaused.status, 'paused', 'pause run should be paused');

  const resumedSpec = {
    ...baseSpec,
    workflow_id: 'phase2_pause',
    pause_after_step: null,
    resume: rustPaused.state
  };
  const rustResumed = runRust(resumedSpec);
  const legacyResumed = runLegacy(resumedSpec);
  assert.deepStrictEqual(rustResumed, legacyResumed, 'resume parity should match exactly');
  assert.strictEqual(rustResumed.status, 'completed', 'resume run should complete');

  for (let i = 0; i < 40; i += 1) {
    const spec = buildChaosSpec(i);
    const rustA = runRust(spec);
    const rustB = runRust(spec);
    const legacy = runLegacy(spec);
    assert.deepStrictEqual(rustA, rustB, `rust drift detected on chaos case ${i}`);
    assert.deepStrictEqual(rustA, legacy, `legacy parity mismatch on chaos case ${i}`);
  }

  console.log('execution_phase2_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
