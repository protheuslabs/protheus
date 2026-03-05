#!/usr/bin/env node
'use strict';

const payload = {
  ok: false,
  retired: true,
  error: 'legacy_retired:autotest_controller',
  replacement: 'protheus-ops autotest-controller'
};

process.stderr.write(`${JSON.stringify(payload)}\n`);
process.exit(2);
