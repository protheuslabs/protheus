#!/usr/bin/env node
'use strict';

const payload = {
  ok: false,
  retired: true,
  error: 'legacy_retired:contract_check',
  replacement: 'protheus-ops contract-check'
};

process.stderr.write(`${JSON.stringify(payload)}\n`);
process.exit(2);
