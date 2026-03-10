#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/runtime + core/layer0/ops::legacy-retired-lane (authoritative)
// Thin compatibility wrapper only.
const { createLegacyRetiredModule, runAsMain } = require('../../lib/legacy_retired_wrapper.js');
const mod = createLegacyRetiredModule(__dirname, 'skin_protection_layer', 'RUNTIME-SYSTEMS-SECURITY-SKIN_PROTECTION_LAYER');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
