'use strict';

const { createOpsLaneBridge } = require('./rust_lane_bridge');

const bridge = createOpsLaneBridge(
  __dirname,
  'backlog_runtime_anchor',
  'backlog-runtime-anchor'
);

function runRustAnchor(laneId) {
  const normalized = String(laneId || '').trim().toUpperCase();
  const out = bridge.run(['build', `--lane-id=${normalized}`]);
  if (out && out.ok && out.payload && typeof out.payload === 'object' && out.payload.ok === true) {
    return out.payload;
  }
  return {
    ok: false,
    type: 'backlog_runtime_anchor_bridge_error',
    lane_id: normalized,
    error: String(
      (out && out.payload && (out.payload.error || out.payload.reason))
      || (out && (out.stderr || out.stdout))
      || 'rust_anchor_failed'
    ).trim().slice(0, 260)
  };
}

function createLaneModule(laneId) {
  const normalized = String(laneId || '').trim().toUpperCase();
  function buildAnchor() {
    return runRustAnchor(normalized);
  }
  function verifyAnchor() {
    const row = buildAnchor();
    return row && row.ok === true && String(row.lane_id || '') === normalized;
  }
  return {
    LANE_ID: normalized,
    buildAnchor,
    verifyAnchor
  };
}

module.exports = {
  createLaneModule,
  runRustAnchor
};

