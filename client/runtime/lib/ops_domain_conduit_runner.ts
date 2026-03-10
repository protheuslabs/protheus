#!/usr/bin/env node
'use strict';

const { runOpsDomainCommand } = require('./spine_conduit_bridge');

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v, fallback = false) {
  const raw = cleanText(v, 32).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
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

  // Keep all positional args when domain is provided via --domain=<name>.
  // The previous slice(1) dropped the first command token (e.g. "run"),
  // which broke domains that require explicit subcommands.
  const passArgs = Array.isArray(args._) ? args._.slice() : [];
  const skipRuntimeGate = toBool(
    args['skip-runtime-gate'],
    toBool(process.env.PROTHEUS_OPS_DOMAIN_SKIP_RUNTIME_GATE, true)
  );
  const stdioTimeoutMs = Number(
    args['stdio-timeout-ms']
      || process.env.PROTHEUS_OPS_DOMAIN_STDIO_TIMEOUT_MS
      || process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS
      || 120000
  );
  const timeoutMs = Number(
    args['timeout-ms']
      || process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS
      || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS
      || Math.max(stdioTimeoutMs + 1000, 125000)
  );
  const result = await runOpsDomainCommand(domain, passArgs, {
    runContext: args['run-context'] == null ? null : String(args['run-context']),
    skipRuntimeGate,
    stdioTimeoutMs: Number.isFinite(stdioTimeoutMs) ? stdioTimeoutMs : 120000,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 125000
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
