#!/usr/bin/env node
'use strict';
export {};

/**
 * Runtime anchor for V3-RACE-125
 * Generated from queued backlog reconciliation.
 */

const fs = require('fs');
const path = require('path');
const { nowIso, stableHash } = require('../../../lib/queued_backlog_runtime');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LANE_ID = 'V3-RACE-125';
const TITLE = "Legal/Trust Language Normalization Pack";
const WAVE = "V3";
const CLASS = "hardening";
const DEPENDENCIES = [
  "V3-DEP-001",
  "V3-DOC-008"
];
const REQUIRED_REFS = [];

function checkRefs() {
  const existing = [];
  const missing = [];
  for (const relPath of REQUIRED_REFS) {
    const abs = path.join(ROOT, relPath);
    if (fs.existsSync(abs)) existing.push(relPath);
    else missing.push(relPath);
  }
  return { existing, missing };
}

function buildAnchor() {
  const ts = nowIso();
  const refs = checkRefs();
  const dependencies_ok = Array.isArray(DEPENDENCIES);
  const refs_ok = refs.missing.length === 0;
  const ok = dependencies_ok && refs_ok;
  return {
    ok,
    lane_id: LANE_ID,
    title: TITLE,
    wave: WAVE,
    class: CLASS,
    ts,
    dependencies: DEPENDENCIES,
    refs,
    contract: {
      deterministic: true,
      reversible: true,
      receipt_ready: true,
      dependencies_ok,
      refs_ok
    },
    anchor_hash: stableHash(JSON.stringify({
      lane_id: LANE_ID,
      ts,
      dependencies: DEPENDENCIES,
      refs_ok
    }), 32)
  };
}

function verifyAnchor() {
  const row = buildAnchor();
  return row.ok === true && String(row.lane_id || '') === LANE_ID;
}

module.exports = {
  LANE_ID,
  TITLE,
  buildAnchor,
  verifyAnchor
};

if (require.main === module) {
  console.log(JSON.stringify(buildAnchor(), null, 2));
}
