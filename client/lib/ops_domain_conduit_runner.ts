#!/usr/bin/env node
'use strict';

const { runOpsDomainCommand } = require('./spine_conduit_bridge');

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const domain = cleanText(args.domain || args._[0] || '', 120);
  if (!domain) {
    const out = {
      ok: false,
      type: 'ops_domain_conduit_bridge_error',
      reason: 'missing_domain',
      routed_via: 'conduit'
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(2);
  }

  const passArgs = Array.isArray(args._) && args._.length > 1 ? args._.slice(1) : [];
  const result = await runOpsDomainCommand(domain, passArgs, {
    runContext: args['run-context'] == null ? null : String(args['run-context'])
  });

  if (result && result.payload) {
    process.stdout.write(`${JSON.stringify(result.payload)}\n`);
  } else {
    process.stdout.write(`${JSON.stringify(result || { ok: false, type: 'ops_domain_conduit_bridge_error', reason: 'missing_result' })}\n`);
  }
  process.exit(Number.isFinite(result && result.status) ? Number(result.status) : 1);
}

main().catch((err) => {
  const out = {
    ok: false,
    type: 'ops_domain_conduit_bridge_error',
    reason: cleanText(err && err.message ? err.message : err, 220),
    routed_via: 'conduit'
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  process.exit(1);
});

