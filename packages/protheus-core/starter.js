#!/usr/bin/env node
'use strict';

const core = require('./index.js');

const out = {
  ok: true,
  starter: 'protheus-core-lite',
  spine: core.spineStatus([]),
  reflex: core.reflexStatus([]),
  gates: core.gateStatus([])
};

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(out.spine.ok && out.reflex.ok && out.gates.ok ? 0 : 1);
