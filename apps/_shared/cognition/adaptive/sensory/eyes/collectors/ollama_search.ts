#!/usr/bin/env node
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

// Layer ownership: core/layer3/cognition + core/layer0/ops::legacy-retired-lane (authoritative)
// Thin compatibility wrapper only.
const require = createRequire(import.meta.url);
const { createCognitionModule, laneIdFromCognitionPath, runAsMain } = require('../../../../lib/legacy_retired_wrapper.ts');
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const laneId = laneIdFromCognitionPath(__filename);
const mod = createCognitionModule(__dirname, path.basename(__filename, '.ts'), laneId);
if (process.argv[1] && path.resolve(process.argv[1]) === __filename) runAsMain(mod, process.argv.slice(2));
export default mod;
