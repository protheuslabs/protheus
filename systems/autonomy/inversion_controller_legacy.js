#!/usr/bin/env node
'use strict';

const payload = {
  ok: false,
  retired: true,
  error: 'legacy_retired:inversion_controller',
  replacement: 'protheus-ops inversion-controller'
};

process.stderr.write(`${JSON.stringify(payload)}\n`);
process.exit(2);
