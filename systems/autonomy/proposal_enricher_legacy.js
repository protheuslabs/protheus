#!/usr/bin/env node
'use strict';

const payload = {
  ok: false,
  retired: true,
  error: 'legacy_retired:proposal_enricher',
  replacement: 'protheus-ops proposal-enricher'
};

process.stderr.write(`${JSON.stringify(payload)}\n`);
process.exit(2);
