#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer2/runtime + core/layer0/ops::legacy-retired-lane (authoritative)
// TypeScript compatibility shim only.
const { createLegacyRetiredModule, runAsMain } = require('../../lib/legacy_retired_wrapper.js');
const mod = createLegacyRetiredModule(__dirname, 'supply_chain_reproducible_build_plane', 'RUNTIME-SYSTEMS-SECURITY-SUPPLY_CHAIN_REPRODUCIBLE_BUILD_PLANE');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
