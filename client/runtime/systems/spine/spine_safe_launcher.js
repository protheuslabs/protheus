#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops::spine (authoritative)
// Compatibility launcher wrapper that preserves `run --mode=<x>` and `status`.
const spine = require('./spine.js');

function normalizeArgs(argv) {
  const args = Array.isArray(argv) ? argv.slice() : [];
  const cmd = String(args[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'run') {
    const modeFlag = args.find((row) => String(row || '').startsWith('--mode='));
    const mode = modeFlag ? String(modeFlag).split('=').slice(1).join('=').trim().toLowerCase() : '';
    const normalizedMode = mode === 'eyes' ? 'eyes' : 'daily';
    const tail = args
      .slice(cmd ? 1 : 0)
      .filter((row) => !String(row || '').startsWith('--mode='));
    return [normalizedMode, ...tail];
  }
  if (cmd === 'status') return ['status', ...args.slice(1)];
  return args;
}

async function run(args = [], opts = {}) {
  return spine.run(normalizeArgs(args), opts);
}

if (require.main === module) {
  process.env.PROTHEUS_CONDUIT_STARTUP_PROBE = '0';
  process.env.PROTHEUS_CONDUIT_COMPAT_FALLBACK = '0';
  run(process.argv.slice(2))
    .then((out) => {
      if (out && out.payload) process.stdout.write(`${JSON.stringify(out.payload)}\n`);
      if (out && out.stderr) process.stderr.write(out.stderr.endsWith('\n') ? out.stderr : `${out.stderr}\n`);
      process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
    })
    .catch((error) => {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          type: 'spine_safe_launcher_wrapper_error',
          error: String(error && error.message ? error.message : error)
        })}\n`
      );
      process.exit(1);
    });
}

module.exports = {
  run
};
