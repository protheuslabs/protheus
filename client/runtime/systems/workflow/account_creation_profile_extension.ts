#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer2/runtime + core/layer0/ops::legacy-retired-lane (authoritative)
// TypeScript compatibility shim only.
const { createLegacyRetiredModule, runAsMain } = require('../../lib/legacy_retired_wrapper.js');
const mod = createLegacyRetiredModule(__dirname, 'account_creation_profile_extension', 'RUNTIME-SYSTEMS-WORKFLOW-ACCOUNT_CREATION_PROFILE_EXTENSION');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
