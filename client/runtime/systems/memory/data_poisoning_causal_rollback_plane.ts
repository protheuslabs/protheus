#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer2/runtime + core/layer0/ops::legacy-retired-lane (authoritative)
// TypeScript compatibility shim only.
const { createLegacyRetiredModule, runAsMain } = require('../../lib/legacy_retired_wrapper.js');
const mod = createLegacyRetiredModule(__dirname, 'data_poisoning_causal_rollback_plane', 'RUNTIME-SYSTEMS-MEMORY-DATA_POISONING_CAUSAL_ROLLBACK_PLANE');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
