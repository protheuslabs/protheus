#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer3/cognition + core/layer0/ops::legacy-retired-lane (authoritative)
// Thin compatibility wrapper only.
const { createCognitionModule, runAsMain } = require('../../../../client/cognition/shared/lib/legacy_retired_wrapper.ts');
const mod = createCognitionModule(__dirname, 'mcp_gateway', 'COGNITION-SKILLS-MCP-MCP_GATEWAY');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
