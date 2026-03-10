#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer2/runtime + core/layer0/ops::legacy-retired-lane (authoritative)
// TypeScript compatibility shim only.
const { createLegacyRetiredModule, runAsMain } = require('../../lib/legacy_retired_wrapper.js');
const mod = createLegacyRetiredModule(__dirname, 'rsi_git_patch_self_mod_gate', 'RUNTIME-SYSTEMS-SECURITY-RSI_GIT_PATCH_SELF_MOD_GATE');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
