#!/usr/bin/env node
// @ts-nocheck
'use strict';

// Layer ownership: core/layer2/autonomy + core/layer0/ops::assimilation-controller (authoritative)
// TypeScript compatibility shim only.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';

const require = createRequire(import.meta.url);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JS_ENTRY = path.join(__dirname, 'assimilation_controller.js');

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  const out = spawnSync(process.execPath, [JS_ENTRY, ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

export const { run } = require('./assimilation_controller.js');
