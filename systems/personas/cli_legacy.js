#!/usr/bin/env node
'use strict';

const payload = {
  ok: false,
  retired: true,
  error: 'legacy_retired:personas_cli',
  replacement: 'protheus-ops personas-cli'
};

process.stderr.write(`${JSON.stringify(payload)}\n`);
process.exit(2);
