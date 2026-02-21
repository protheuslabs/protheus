#!/usr/bin/env node
'use strict';

// Compatibility shim: keep legacy post CLI entrypoint but route all publishing
// through the guarded publisher to enforce verification + receipts.

const { run } = require('./moltbook_publish_guard');

run(process.argv.slice(2))
  .then((r) => process.exit(r.exitCode))
  .catch((err) => {
    const msg = String(err && err.message ? err.message : err);
    process.stdout.write(JSON.stringify({ ok: false, error: msg }) + '\n');
    process.exit(1);
  });
