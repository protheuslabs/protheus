#!/usr/bin/env node
'use strict';
export {};

/**
 * Orchestron-branded entrypoint alias for workflow_controller.
 * Keeps legacy controller path stable while exposing a clearer public command.
 */

const controller = require('./workflow_controller');

function main() {
  if (controller && typeof controller.main === 'function') {
    return controller.main();
  }
  process.stdout.write(`${JSON.stringify({
    ok: false,
    type: 'orchestron_controller',
    error: 'workflow_controller_main_missing'
  })}\n`);
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'orchestron_controller',
      error: String(err && err.message ? err.message : err || 'orchestron_controller_failed')
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  ...controller,
  main
};

