#!/usr/bin/env node
'use strict';

/**
 * Runtime anchor for BL-015.
 * Native execution delegated to Rust backlog-runtime-anchor lane.
 */

const { createLaneModule } = require('../../../lib/backlog_runtime_anchor_bridge');

const lane = createLaneModule('BL-015');
const { LANE_ID, buildAnchor, verifyAnchor } = lane;

module.exports = lane;

if (require.main === module) {
  console.log(JSON.stringify(buildAnchor(), null, 2));
}

export {};
