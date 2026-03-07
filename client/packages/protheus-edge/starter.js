#!/usr/bin/env node
'use strict';

const edge = require('./index.js');

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
const mode = String(flags.mode || 'status').trim().toLowerCase();
const options = {
  owner: flags.owner,
  max_mb: flags['max-mb'] || flags.max_mb,
  max_ms: flags['max-ms'] || flags.max_ms,
  policy: flags.policy
};

let out;
if (mode === 'edge') out = edge.edgeRuntime('start', { ...options, apply: 0 });
else if (mode === 'contract') out = edge.edgeContract(options);
else out = edge.edgeStatusBundle(options);

process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
process.exit(out && out.ok === false ? 1 : 0);
