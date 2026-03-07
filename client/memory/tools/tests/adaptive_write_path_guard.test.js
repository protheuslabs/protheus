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
    () => layerStore.setJson('/tmp/not_under_adaptive.json', {}),
    /outside adaptive root/
  );
  assert.throws(
    () => layerStore.mutateJson('/tmp/not_under_adaptive.json', (cur) => cur || {}),
    /outside adaptive root/
  );

  assert.throws(
    () => catalogStore.setCatalog('/tmp/not_catalog.json', catalogStore.defaultCatalog()),
    /override denied/
  );
  assert.throws(
    () => catalogStore.mutateCatalog('/tmp/not_catalog.json', (cur) => cur),
    /override denied/
  );

  assert.throws(
    () => focusStore.setFocusState('/tmp/not_focus.json', focusStore.defaultFocusState()),
    /override denied/
  );
  assert.throws(
    () => focusStore.mutateFocusState('/tmp/not_focus.json', (cur) => cur),
    /override denied/
  );

  assert.throws(
    () => habitStore.setHabitState('/tmp/not_habit.json', habitStore.defaultHabitState()),
    /override denied/
  );
  assert.throws(
    () => habitStore.mutateHabitState('/tmp/not_habit.json', (cur) => cur),
    /override denied/
  );

  assert.throws(
    () => reflexStore.setReflexState('/tmp/not_reflex.json', reflexStore.defaultReflexState()),
    /override denied/
  );
  assert.throws(
    () => reflexStore.mutateReflexState('/tmp/not_reflex.json', (cur) => cur),
    /override denied/
  );

  assert.throws(
    () => strategyStore.setStrategyState('/tmp/not_strategy.json', strategyStore.defaultStrategyState()),
    /override denied/
  );
  assert.throws(
    () => strategyStore.mutateStrategyState('/tmp/not_strategy.json', (cur) => cur),
    /override denied/
  );

  console.log('adaptive_write_path_guard.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`adaptive_write_path_guard.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
