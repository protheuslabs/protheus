#!/usr/bin/env node
'use strict';
export {};

const { runLegacyAlias } = require('../compat/legacy_alias_adapter');

runLegacyAlias({
  alias_rel: 'systems/state/event_stream.js',
  target_rel: 'systems/ops/event_sourced_control_plane.js'
});
