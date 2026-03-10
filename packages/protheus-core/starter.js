#!/usr/bin/env node
'use strict';

const core = require('./index.js');

function parseFlags(argv) {
  const out = {};
  for (const tok of argv) {
    const raw = String(tok || '').trim();
    if (!raw.startsWith('--')) continue;
    const idx = raw.indexOf('=');
    if (idx < 0) out[raw.slice(2)] = true;
    else out[raw.slice(2, idx)] = raw.slice(idx + 1);
  }
  return out;
}

const flags = parseFlags(process.argv.slice(2));
const mode = String(flags.mode || '').trim().toLowerCase();
const options = {
  spine: flags.spine,
  reflex: flags.reflex,
  gates: flags.gates,
  timeout_ms: flags['timeout-ms'] || flags.timeout_ms,
  max_mb: flags['max-mb'] || flags.max_mb,
  max_ms: flags['max-ms'] || flags.max_ms
};

const out = mode === 'contract'
  ? core.coldStartContract(options)
  : core.coreStatus(options);

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(out.ok ? 0 : 1);
