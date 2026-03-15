#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer3/cognition + core/layer0/ops::legacy-retired-lane (authoritative)
// Thin compatibility wrapper only.
const { createCognitionModule, runAsMain } = require('../../../../client/cognition/shared/lib/legacy_retired_wrapper.ts');
const mod = createCognitionModule(__dirname, 'moltbook_publish_guard', 'COGNITION-SKILLS-MOLTBOOK-MOLTBOOK_PUBLISH_GUARD');
if (require.main === module) runAsMain(mod, process.argv.slice(2));
module.exports = mod;
