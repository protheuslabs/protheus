#!/usr/bin/env node
'use strict';

const payload = {
  ok: false,
  retired: true,
  error: 'legacy_retired:strategy_mode_governor',
  replacement: 'protheus-ops strategy-mode-governor'
};

process.stderr.write(`${JSON.stringify(payload)}\n`);
process.exit(2);
