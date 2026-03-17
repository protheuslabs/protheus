#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');

function resetModule(modulePath) {
  delete require.cache[require.resolve(modulePath)];
  return require(modulePath);
}

function main() {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'strategy-store-rust-'));
  const runtimeRoot = path.join(workspace, 'client', 'runtime');
  fs.mkdirSync(runtimeRoot, { recursive: true });

  process.env.PROTHEUS_WORKSPACE_ROOT = workspace;
  process.env.PROTHEUS_RUNTIME_ROOT = runtimeRoot;
  process.env.PROTHEUS_OPS_USE_PREBUILT = '0';
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = '120000';
  delete process.env.STRATEGY_STORE_PATH;

  const mod = resetModule(path.join(ROOT, 'client/runtime/systems/adaptive/strategy/strategy_store.ts'));

  const defaults = mod.defaultStrategyState();
  assert.equal(defaults.policy.max_profiles, 64);

  const draft = mod.defaultStrategyDraft({ name: 'Durable Queue' });
  assert.equal(draft.id, 'durable_queue');
  assert.equal(mod.normalizeMode('DEEP-thinker'), 'deep-thinker');
  assert.equal(mod.normalizeExecutionMode('EXECUTE'), 'execute');

  const ensured = mod.ensureStrategyState();
  assert.equal(Array.isArray(ensured.profiles), true);
  assert.equal(fs.existsSync(mod.STORE_ABS_PATH), true);

  const intake = mod.intakeSignal(null, {
    source: 'manual',
    kind: 'signal',
    summary: 'Investigate durable execution for adaptive strategy selection',
    text: 'Need a durable queue and strategy registry with clear ownership.',
    evidence_refs: ['doc://proof']
  });
  assert.equal(intake.action, 'queued');

  const qid = intake.queue_item.uid;
  const materialized = mod.materializeFromQueue(null, qid, {
    id: 'durable_queue',
    name: 'Durable Queue',
    draft: {
      objective: {
        primary: 'Ship durable queue ownership'
      }
    }
  });
  assert.equal(materialized.action, 'created');
  assert.equal(materialized.profile.id, 'durable_queue');

  const touched = mod.touchProfileUsage(null, 'durable_queue', '2026-03-17T12:00:00Z');
  assert.equal(touched.profile.usage.uses_total, 1);

  const mutated = mod.mutateStrategyState(null, (state) => {
    state.profiles[0].status = 'archived';
    state.profiles[0].created_ts = '2026-01-01T00:00:00Z';
    state.profiles[0].updated_ts = '2026-01-01T00:00:00Z';
    state.profiles[0].usage.last_used_ts = '2026-01-01T00:00:00Z';
    state.profiles[0].usage.uses_30d = 0;
    return state;
  });
  assert.equal(mutated.profiles[0].status, 'archived');

  const gcPreview = mod.evaluateGcCandidates(mutated, {
    inactive_days: 1,
    min_uses_30d: 1,
    protect_new_days: 0
  });
  assert.equal(gcPreview.candidates.length, 1);
  assert.equal(gcPreview.candidates[0].id, 'durable_queue');

  const gcApplied = mod.gcProfiles(null, {
    apply: true,
    inactive_days: 1,
    min_uses_30d: 1,
    protect_new_days: 0
  });
  assert.equal(gcApplied.removed.length, 1);
  assert.equal(gcApplied.state.profiles.length, 0);

  const mutationLogPath = path.join(runtimeRoot, 'local', 'state', 'security', 'adaptive_mutations.jsonl');
  const pointerPath = path.join(runtimeRoot, 'local', 'state', 'memory', 'adaptive_pointers.jsonl');
  const pointerIndexPath = path.join(runtimeRoot, 'local', 'state', 'memory', 'adaptive_pointer_index.json');
  assert.equal(fs.existsSync(mutationLogPath), true);
  assert.equal(fs.existsSync(pointerPath), true);
  assert.equal(fs.existsSync(pointerIndexPath), true);

  console.log(JSON.stringify({ ok: true, type: 'strategy_store_rust_bridge_test' }));
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
