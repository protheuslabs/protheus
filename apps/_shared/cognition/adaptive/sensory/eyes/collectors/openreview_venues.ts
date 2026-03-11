#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer3/cognition + core/layer0/ops::legacy-retired-lane (authoritative)
// TypeScript compatibility shim only.
const mod = require('./openreview_venues.ts');
if (require.main === module) mod.run(process.argv.slice(2));
module.exports = mod;
