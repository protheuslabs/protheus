#!/usr/bin/env node
'use strict';

const payload = {
  ok: false,
  retired: true,
  error: 'legacy_retired:autotest_doctor',
  replacement: 'protheus-ops autotest-doctor'
};

process.stderr.write(`${JSON.stringify(payload)}\n`);
process.exit(2);
