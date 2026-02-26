#!/usr/bin/env node
/**
 * Compatibility launcher.
 *
 * Canonical visualizer server now lives in:
 *   agent-holo-viz/server/system_visualizer_server.js
 */
const fs = require('fs');
const path = require('path');

const sidecarMain = path.join(__dirname, '..', '..', 'agent-holo-viz', 'server', 'system_visualizer_server.js');
if (!fs.existsSync(sidecarMain)) {
  process.stderr.write(
    '[visualizer] sidecar repo not found at agent-holo-viz/. ' +
    'Create/populate /Users/jay/.openclaw/workspace/agent-holo-viz first.\n'
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
