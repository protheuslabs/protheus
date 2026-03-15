#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { invokeOrchestration } = require('./core_bridge.ts');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const SCHEMA_PATH = path.join(__dirname, 'schemas', 'finding-v1.json');

const SEVERITY_ORDER = Object.freeze({
  critical: 5,
  high: 4,
  medium: 3,
  low: 2,
  info: 1,
});

const STATUS_ORDER = Object.freeze({
  confirmed: 5,
  open: 4,
  'needs-review': 3,
  resolved: 2,
  dismissed: 1,
});

function loadFindingSchema() {
  return JSON.parse(fs.readFileSync(SCHEMA_PATH, 'utf8'));
}

function normalizeFinding(finding) {
  const out = invokeOrchestration('schema.normalize_finding', { finding: finding || {} });
  if (out && out.ok && out.finding && typeof out.finding === 'object') {
    return out.finding;
  }
  return finding && typeof finding === 'object' ? finding : {};
}

function validateFinding(finding) {
  const out = invokeOrchestration('schema.validate_finding', { finding: finding || {} });
  if (out && typeof out.ok === 'boolean') {
    return {
      ok: out.ok,
      reason_code: String(out.reason_code || (out.ok ? 'finding_valid' : 'finding_invalid')),
    };
  }
  return {
    ok: false,
    reason_code: 'orchestration_bridge_error',
  };
}

module.exports = {
  ROOT,
  SCHEMA_PATH,
  SEVERITY_ORDER,
  STATUS_ORDER,
  loadFindingSchema,
  validateFinding,
  normalizeFinding,
};
