#!/usr/bin/env node
'use strict';

/**
 * request_ingress.js — source-aware command ingress wrapper
 *
 * Purpose:
 * - Stamp REQUEST_SOURCE + REQUEST_ACTION consistently
 * - Optionally attach signed request envelope when REQUEST_GATE_SECRET is configured
 *
 * Usage:
 *   node systems/security/request_ingress.js run --source=slack --action=propose -- node systems/spine/spine.js eyes
 *   node systems/security/request_ingress.js run --source=slack --action=apply --guard-files=config/agent_routing_rules.json -- node systems/security/guard.js --files=config/agent_routing_rules.json
 *   node systems/security/request_ingress.js print-env --source=slack --action=apply [--guard-files=path1,path2]
 */

const { spawnSync } = require('child_process');
const {
  stampGuardEnv,
  normalizeKeyId,
  secretKeyEnvVarName
} = require('../../lib/request_envelope.js');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/request_ingress.js run --source=<local|slack|...> --action=<apply|propose|dry_run|audit> [--guard-files=p1,p2] [--key-id=<id>] -- <command> [args...]');
  console.log('  node systems/security/request_ingress.js print-env --source=<local|slack|...> --action=<...> [--guard-files=p1,p2] [--key-id=<id>]');
  console.log('  node systems/security/request_ingress.js --help');
}

function parseArgs(argv) {
  const out = { _: [], raw: Array.isArray(argv) ? argv.slice(0) : [] } as Record<string, any>;
  for (let i = 0; i < out.raw.length; i++) {
    const a = out.raw[i];
    if (a === '--') {
      out.separator = i;
      break;
    }
    if (!a.startsWith('--')) {
      out._.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq >= 0) {
      out[a.slice(2, eq)] = a.slice(eq + 1);
      continue;
    }
    const k = a.slice(2);
    const n = out.raw[i + 1];
    if (n != null && !String(n).startsWith('--')) {
      out[k] = n;
      i += 1;
    } else {
      out[k] = true;
    }
  }
  return out;
}

function normalizeLower(v, fallback) {
  const s = String(v || '').trim().toLowerCase();
  return s || String(fallback || '').trim().toLowerCase();
}

function parseGuardFiles(v) {
  return String(v || '')
    .split(',')
    .map((x) => String(x || '').trim())
    .filter(Boolean);
}

function isRemoteSource(source) {
  return ['slack', 'discord', 'webhook', 'email', 'api', 'remote', 'moltbook'].includes(String(source || ''));
}

function buildStampedEnv(baseEnv, source, action, guardFiles, keyId) {
  return stampGuardEnv(baseEnv, {
    source,
    action,
    files: guardFiles,
    kid: keyId,
    secret: String(baseEnv.REQUEST_GATE_SECRET || '').trim()
  });
}

function cmdPrintEnv(args) {
  const source = normalizeLower(args.source, 'local');
  const action = normalizeLower(args.action, 'apply');
  const guardFiles = parseGuardFiles(args['guard-files'] || args.guard_files);
  const keyId = normalizeKeyId(args['key-id'] || args.key_id || process.env.REQUEST_KEY_ID);
  const env = buildStampedEnv(process.env, source, action, guardFiles, keyId);
  const out = {
    REQUEST_SOURCE: env.REQUEST_SOURCE || null,
    REQUEST_ACTION: env.REQUEST_ACTION || null,
    REQUEST_KEY_ID: env.REQUEST_KEY_ID || null,
    REQUEST_TS: env.REQUEST_TS || null,
    REQUEST_NONCE: env.REQUEST_NONCE || null,
    REQUEST_SIG: env.REQUEST_SIG || null,
    signed: !!(env.REQUEST_SIG && env.REQUEST_TS && env.REQUEST_NONCE),
    guard_files: guardFiles
  };
  process.stdout.write(JSON.stringify(out) + '\n');
}

function cmdRun(args) {
  const source = normalizeLower(args.source, 'local');
  const action = normalizeLower(args.action, 'apply');
  const guardFiles = parseGuardFiles(args['guard-files'] || args.guard_files);
  const keyId = normalizeKeyId(args['key-id'] || args.key_id || process.env.REQUEST_KEY_ID);
  const sep = Number.isInteger(args.separator) ? args.separator : -1;
  const cmd = sep >= 0 ? args.raw.slice(sep + 1) : [];

  if (!cmd.length) {
    console.error('request_ingress: missing command after --');
    process.exit(2);
  }

  if (isRemoteSource(source) && action !== 'propose' && action !== 'proposal' && action !== 'dry_run' && action !== 'audit') {
    const kidVar = keyId ? secretKeyEnvVarName(keyId) : '';
    const hasSecret = String(process.env.REQUEST_GATE_SECRET || (kidVar ? process.env[kidVar] : '') || '').trim().length > 0;
    if (!hasSecret) {
      console.error(`request_ingress: REQUEST_GATE_SECRET${kidVar ? ` or ${kidVar}` : ''} is required for remote direct actions`);
      process.exit(1);
    }
  }

  const env = buildStampedEnv(process.env, source, action, guardFiles, keyId);
  const r = spawnSync(cmd[0], cmd.slice(1), {
    stdio: 'inherit',
    env
  });
  process.exit(r.status == null ? 1 : r.status);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'print-env') return cmdPrintEnv(args);
  if (cmd === 'run') return cmdRun(args);

  console.error(`request_ingress: unknown command '${cmd}'`);
  usage();
  process.exit(2);
}

main();
export {};
