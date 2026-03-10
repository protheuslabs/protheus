#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer2/runtime + core/layer0/ops::legacy-retired-lane (authoritative)
// TypeScript compatibility shim only.
const { createLegacyRetiredModule, runAsMain } = require('../../lib/legacy_retired_wrapper.js');
const mod = createLegacyRetiredModule(__dirname, 'objective_value_currency_propagation_baseline', 'RUNTIME-SYSTEMS-AUTONOMY-OBJECTIVE_VALUE_CURRENCY_PROPAGATION_BASELINE');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
