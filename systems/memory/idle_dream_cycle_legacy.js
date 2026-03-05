#!/usr/bin/env node
'use strict';

const payload = {
  ok: false,
  retired: true,
  error: 'legacy_retired:idle_dream_cycle',
  replacement: 'systems/memory/rust/bin idle_dream_cycle'
};

process.stderr.write(`${JSON.stringify(payload)}\n`);
process.exit(2);
