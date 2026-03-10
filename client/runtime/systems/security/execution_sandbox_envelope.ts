#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer2/runtime + core/layer0/ops::legacy-retired-lane (authoritative)
// TypeScript compatibility shim only.
const { createLegacyRetiredModule, runAsMain } = require('../../lib/legacy_retired_wrapper.js');
const mod = createLegacyRetiredModule(__dirname, 'execution_sandbox_envelope', 'RUNTIME-SYSTEMS-SECURITY-EXECUTION_SANDBOX_ENVELOPE');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
