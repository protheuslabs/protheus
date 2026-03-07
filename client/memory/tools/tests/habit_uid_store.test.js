#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const {
  normalizeRegistry,
  ensureHabitUid,
  defaultRegistry
} = require(path.join(__dirname, '..', '..', '..', 'habits', 'scripts', 'habit_uid_store.js'));

function run() {
  const base = defaultRegistry();
  base.habits = [
    { id: 'alpha_habit', uid: '' },
    { id: 'beta_habit', uid: 'NOT-ALNUM' },
    { id: 'gamma_habit', uid: 'dupuid123' },
    { id: 'delta_habit', uid: 'dupuid123' }
  ];

  const normalized = normalizeRegistry(base);
  assert.strictEqual(Array.isArray(normalized.registry.habits), true);
  assert.strictEqual(normalized.registry.habits.length, 4);
  assert.strictEqual(normalized.changed, true, 'registry should be marked changed');

  const uids = normalized.registry.habits.map((h) => String(h.uid || ''));
  const uniq = new Set(uids);
  assert.strictEqual(uniq.size, uids.length, 'habit uids must be unique');
  assert.ok(uids.every((u) => /^[A-Za-z0-9]+$/.test(u)), 'habit uids must be alnum');

  const used = new Set();
  const uidA = ensureHabitUid({ id: 'repeatable_habit' }, 0, used);
  const uidB = ensureHabitUid({ id: 'repeatable_habit' }, 1, new Set());
  assert.strictEqual(uidA, uidB, 'stable uid derivation should be deterministic per id');

  console.log('habit_uid_store.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`habit_uid_store.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

