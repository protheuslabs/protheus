#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const RUNBOOK = path.join(ROOT, 'docs', 'OPERATOR_RUNBOOK.md');

function main() {
  const text = fs.readFileSync(RUNBOOK, 'utf8');
  const required = [
    '## BL-034 Incident Contract',
    'routing_degraded',
    'schema_drift',
    'sensory_starvation',
    'autonomy_stall',
    'rollback drill',
    'emergency_stop.js engage',
    'improvement_controller.js evaluate',
    'rollback_drill_<YYYY-MM-DD>.md'
  ];
  for (const token of required) {
    assert.ok(text.includes(token), `missing runbook token: ${token}`);
  }
  console.log('operator_runbook_bl034_contract.test.js: OK');
}

try { main(); } catch (err) { console.error(`operator_runbook_bl034_contract.test.js: FAIL: ${err.message}`); process.exit(1); }
