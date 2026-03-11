#!/usr/bin/env node
'use strict';

// TypeScript compatibility shim only.
// Layer ownership: apps/agent-holo-viz (authoritative)

/**
 * Compatibility launcher.
 *
 * Canonical visualizer server now lives in:
 *   client/runtime/local/workspaces/agent-holo-viz/server/system_visualizer_server.js
 */
const fs = require('fs');
const path = require('path');

const sidecarMain = path.join(
  __dirname,
  '..',
  '..',
  'local',
  'workspaces',
  'agent-holo-viz',
  'server',
  'system_visualizer_server.js'
);
if (!fs.existsSync(sidecarMain)) {
  process.stderr.write(
    '[visualizer] sidecar repo not found at client/runtime/local/workspaces/agent-holo-viz/. ' +
    'Create/populate $OPENCLAW_WORKSPACE/client/runtime/local/workspaces/agent-holo-viz first.\n'
  );
  process.exit(1);
}

const mod = require(sidecarMain);
if (mod && typeof mod.main === 'function') {
  mod.main();
} else {
  process.stderr.write('[visualizer] invalid sidecar server module (missing main export).\n');
  process.exit(1);
}
