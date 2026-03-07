#!/usr/bin/env node
'use strict';

const assert = require('assert');

function run() {
  const layerStore = require('../../../systems/adaptive/core/layer_store.js');
  const catalogStore = require('../../../systems/adaptive/sensory/eyes/catalog_store.js');
  const focusStore = require('../../../systems/adaptive/sensory/eyes/focus_trigger_store.js');
  const habitStore = require('../../../systems/adaptive/habits/habit_store.js');
  const reflexStore = require('../../../systems/adaptive/reflex/reflex_store.js');
  const strategyStore = require('../../../systems/adaptive/strategy/strategy_store.js');

  assert.throws(
    () => layerStore.resolveAdaptivePath('/tmp/not_under_adaptive.json'),
    /outside adaptive root/
  );

  assert.throws(
    () => catalogStore.readCatalog('/tmp/not_catalog.json'),
    /override denied/
  );
  assert.throws(
    () => focusStore.readFocusState('/tmp/not_focus.json'),
    /override denied/
  );
  assert.throws(
    () => habitStore.readHabitState('/tmp/not_habits.json'),
    /override denied/
  );
  assert.throws(
    () => reflexStore.readReflexState('/tmp/not_reflex.json'),
    /override denied/
  );
  assert.throws(
    () => strategyStore.readStrategyState('/tmp/not_strategy.json'),
    /override denied/
  );

  console.log('adaptive_layer_boundary_guards.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`adaptive_layer_boundary_guards.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
