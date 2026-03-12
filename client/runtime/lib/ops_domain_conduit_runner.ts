#!/usr/bin/env node
'use strict';

const { runOpsDomainCommand } = require('./spine_conduit_bridge.ts');

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

function buildPassArgs(parsedArgs) {
  if (!parsedArgs || !Array.isArray(parsedArgs._)) return [];
  const positional = parsedArgs._.slice();
  const controlKeys = new Set([
    '_',
    'domain',
    'run-context',
    'skip-runtime-gate',
    'stdio-timeout-ms',
    'timeout-ms'
  ]);
  const forwardedFlags = [];
  for (const [key, value] of Object.entries(parsedArgs)) {
    if (controlKeys.has(key)) continue;
    if (value === true) {
      forwardedFlags.push(`--${key}`);
      continue;
    }
    if (value == null || value === false) continue;
    forwardedFlags.push(`--${key}=${String(value)}`);
  }
  // --domain=<name> keeps positional arguments untouched (`run --mode=daily`).
  if (parsedArgs.domain != null && String(parsedArgs.domain).trim()) {
    return positional.concat(forwardedFlags);
  }
  // Positional domain (`spine run`) should not leak the domain token into payload args.
  const args = positional.length ? positional.slice(1) : [];
  return args.concat(forwardedFlags);
}

function buildRunOptions(parsedArgs) {
  const skipRuntimeGate = toBool(
    parsedArgs['skip-runtime-gate'],
    toBool(process.env.PROTHEUS_OPS_DOMAIN_SKIP_RUNTIME_GATE, true)
  );
  const stdioTimeoutMs = Number(
    parsedArgs['stdio-timeout-ms']
      || process.env.PROTHEUS_OPS_DOMAIN_STDIO_TIMEOUT_MS
      || process.env.PROTHEUS_CONDUIT_STDIO_TIMEOUT_MS
      || 120000
  );
  const timeoutMs = Number(
    parsedArgs['timeout-ms']
      || process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS
      || process.env.PROTHEUS_CONDUIT_BRIDGE_TIMEOUT_MS
      || Math.max(stdioTimeoutMs + 1000, 125000)
  );
  return {
    runContext: parsedArgs['run-context'] == null ? null : String(parsedArgs['run-context']),
    skipRuntimeGate,
    stdioTimeoutMs: Number.isFinite(stdioTimeoutMs) ? stdioTimeoutMs : 120000,
    timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : 125000
  };
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const domain = cleanText(args.domain || args._[0] || '', 120);
  if (!domain) {
    return {
      status: 2,
      payload: {
        ok: false,
        type: 'ops_domain_conduit_bridge_error',
        reason: 'missing_domain',
        routed_via: 'conduit'
      }
    };
  }

  const result = await runOpsDomainCommand(domain, buildPassArgs(args), buildRunOptions(args));
  return {
    status: Number.isFinite(result && result.status) ? Number(result.status) : 1,
    payload: result && result.payload
      ? result.payload
      : (result || {
        ok: false,
        type: 'ops_domain_conduit_bridge_error',
        reason: 'missing_result'
      }),
    result
  };
}

async function main() {
  const out = await run(process.argv.slice(2));
  const payload = out && out.payload
    ? out.payload
    : {
      ok: false,
      type: 'ops_domain_conduit_bridge_error',
      reason: 'missing_result',
      routed_via: 'conduit'
    };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

if (require.main === module) {
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
}

module.exports = {
  cleanText,
  toBool,
  parseArgs,
  buildPassArgs,
  buildRunOptions,
  run,
  main
};
