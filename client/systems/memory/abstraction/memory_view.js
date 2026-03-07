#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });

const { createDomainProxy } = require('../../../lib/legacy_conduit_proxy');

const runDomain = createDomainProxy(__dirname, 'MEMORY_ABSTRACTION_VIEW', 'memory-ambient');

const raw = process.argv.slice(2);
const cmd = raw.length ? raw[0] : 'status';
const out = runDomain([cmd, ...raw.slice(1)]);
if (out && out.payload) {
  process.stdout.write(`${JSON.stringify(out.payload)}\n`);
}
process.exit(out && out.ok === true ? 0 : 1);
