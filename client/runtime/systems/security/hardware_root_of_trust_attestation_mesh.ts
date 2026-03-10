#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer2/runtime + core/layer0/ops::legacy-retired-lane (authoritative)
// TypeScript compatibility shim only.
const { createLegacyRetiredModule, runAsMain } = require('../../lib/legacy_retired_wrapper.js');
const mod = createLegacyRetiredModule(__dirname, 'hardware_root_of_trust_attestation_mesh', 'RUNTIME-SYSTEMS-SECURITY-HARDWARE_ROOT_OF_TRUST_ATTESTATION_MESH');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
