#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const focusPath = path.join(repoRoot, 'adaptive', 'sensory', 'eyes', 'focus_triggers.json');
  const before = fs.existsSync(focusPath) ? fs.readFileSync(focusPath, 'utf8') : null;

  try {
    if (fs.existsSync(focusPath)) fs.rmSync(focusPath, { force: true });
    const store = require('../../../systems/adaptive/sensory/eyes/focus_trigger_store.js');

    const ensured = store.ensureFocusState();
    assert.ok(ensured && typeof ensured === 'object', 'ensure should return object');
    assert.strictEqual(Array.isArray(ensured.triggers), true, 'triggers should be array');
    assert.strictEqual(typeof ensured.policy.refresh_hours, 'number', 'policy.refresh_hours should exist');
    assert.strictEqual(typeof ensured.policy.lens_refresh_hours, 'number', 'lens policy should exist');

    const mutated = store.mutateFocusState(null, (state) => {
      const next = { ...state };
      next.triggers = Array.isArray(next.triggers) ? next.triggers.slice() : [];
      next.triggers.push({
        key: 'token:alpha',
        pattern: 'alpha',
        source: 'manual',
        status: 'active',
        weight: 88
      });
      next.eye_lenses = {
        ...(next.eye_lenses || {}),
        'TeSt-Eye': {
          include_terms: ['Routing', 'Routing', 'Reliability'],
          exclude_terms: ['Noise', 'noise'],
          term_weights: { routing: 30, reliability: 12, invalid: 99 }
        }
      };
      return next;
    }, { reason: 'focus_trigger_store_test' });

    const hit = (mutated.triggers || []).find((t) => t && t.key === 'token:alpha');
    assert.ok(hit, 'manual trigger should exist after mutate');
    assert.ok(/^[A-Za-z0-9]+$/.test(String(hit.uid || '')), 'trigger uid should be alnum');
    assert.strictEqual(Number(hit.weight), 88, 'manual trigger weight should persist');
    assert.ok(mutated.eye_lenses && mutated.eye_lenses['test-eye'], 'lens should be normalized under canonical eye id');
    assert.deepStrictEqual(mutated.eye_lenses['test-eye'].include_terms, ['routing', 'reliability'], 'lens include terms should be normalized + deduped');

    const loaded = store.readFocusState();
    const loadedHit = (loaded.triggers || []).find((t) => t && t.key === 'token:alpha');
    assert.ok(loadedHit, 'trigger should persist on read');
    assert.ok(loaded.eye_lenses && loaded.eye_lenses['test-eye'], 'lens should persist on read');
    console.log('focus_trigger_store.test.js: OK');
  } finally {
    if (before == null) {
      if (fs.existsSync(focusPath)) fs.rmSync(focusPath, { force: true });
    } else {
      fs.mkdirSync(path.dirname(focusPath), { recursive: true });
      fs.writeFileSync(focusPath, before, 'utf8');
    }
  }
}

try {
  run();
} catch (err) {
  console.error(`focus_trigger_store.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
