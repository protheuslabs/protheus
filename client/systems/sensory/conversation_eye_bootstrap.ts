#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const fs = require('fs');
const { resolveCatalogPath, ensureCatalog, setCatalog } = require('../../lib/eyes_catalog');

const WORKSPACE_ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..', '..');
const ROOT = fs.existsSync(path.join(WORKSPACE_ROOT, 'client'))
  ? path.join(WORKSPACE_ROOT, 'client')
  : path.join(__dirname, '..', '..');
const EYE_ID = 'conversation_eye';

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  const raw = String(v == null ? '' : v).trim().toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (!token) continue;
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq > 2) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
    const next = String(argv[i + 1] || '');
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = '1';
    }
  }
  return out;
}

function defaultConversationEye() {
  return {
    id: EYE_ID,
    name: 'Conversation Eye',
    status: 'active',
    cadence_hours: 1,
    allowed_domains: ['local.workspace'],
    budgets: {
      max_items: 6,
      max_seconds: 8,
      max_bytes: 65536,
      max_requests: 1,
      max_rows: 96
    },
    parser_type: 'conversation_eye',
    topics: ['conversation', 'decision', 'insight', 'directive', 't1'],
    error_rate: 0,
    score_ema: 50,
    updated_ts: nowIso()
  };
}

function mergeEye(current: any, incoming: any) {
  const base = current && typeof current === 'object' ? { ...current } : {};
  return {
    ...base,
    ...incoming,
    id: EYE_ID,
    parser_type: 'conversation_eye',
    allowed_domains: ['local.workspace'],
    topics: ['conversation', 'decision', 'insight', 'directive', 't1'],
    budgets: {
      ...(base.budgets && typeof base.budgets === 'object' ? base.budgets : {}),
      ...(incoming.budgets && typeof incoming.budgets === 'object' ? incoming.budgets : {})
    },
    updated_ts: nowIso()
  };
}

function ensureConversationEye(apply = true) {
  const catalogPath = resolveCatalogPath(ROOT);
  const catalog = ensureCatalog(catalogPath, {
    source: 'systems/sensory/conversation_eye_bootstrap.ts',
    reason: 'ensure_catalog_for_conversation_eye'
  });
  const eyes = Array.isArray(catalog && catalog.eyes) ? catalog.eyes.slice() : [];
  const idx = eyes.findIndex((eye: any) => cleanText(eye && eye.id, 80) === EYE_ID);
  const desired = mergeEye(idx >= 0 ? eyes[idx] : null, defaultConversationEye());
  const nextEyes = eyes.slice();
  if (idx >= 0) nextEyes[idx] = desired;
  else nextEyes.push(desired);
  const changed = JSON.stringify(nextEyes) !== JSON.stringify(eyes);
  if (apply && changed) {
    setCatalog(catalogPath, { ...catalog, eyes: nextEyes }, {
      source: 'systems/sensory/conversation_eye_bootstrap.ts',
      reason: 'ensure_default_conversation_eye'
    });
  }
  return {
    ok: true,
    type: 'conversation_eye_bootstrap',
    action: apply ? 'ensure' : 'plan',
    changed,
    applied: apply && changed,
    eye_id: EYE_ID,
    catalog_path: catalogPath,
    eye_count_before: eyes.length,
    eye_count_after: nextEyes.length
  };
}

function statusConversationEye() {
  const catalogPath = resolveCatalogPath(ROOT);
  const catalog = ensureCatalog(catalogPath, {
    source: 'systems/sensory/conversation_eye_bootstrap.ts',
    reason: 'status_conversation_eye'
  });
  const eyes = Array.isArray(catalog && catalog.eyes) ? catalog.eyes : [];
  const eye = eyes.find((entry: any) => cleanText(entry && entry.id, 80) === EYE_ID) || null;
  return {
    ok: true,
    type: 'conversation_eye_bootstrap',
    action: 'status',
    catalog_path: catalogPath,
    installed: !!eye,
    eye
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node client/systems/sensory/conversation_eye_bootstrap.js ensure [--apply=1]');
  console.log('  node client/systems/sensory/conversation_eye_bootstrap.js plan');
  console.log('  node client/systems/sensory/conversation_eye_bootstrap.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase() || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }
  if (cmd === 'status') {
    process.stdout.write(`${JSON.stringify(statusConversationEye(), null, 2)}\n`);
    process.exit(0);
  }
  if (cmd === 'plan') {
    process.stdout.write(`${JSON.stringify(ensureConversationEye(false), null, 2)}\n`);
    process.exit(0);
  }
  if (cmd === 'ensure') {
    const apply = toBool(args.apply, true);
    process.stdout.write(`${JSON.stringify(ensureConversationEye(apply), null, 2)}\n`);
    process.exit(0);
  }
  process.stdout.write(`${JSON.stringify({
    ok: false,
    error: `unknown_command:${cmd}`,
    usage: 'node client/systems/sensory/conversation_eye_bootstrap.js ensure|plan|status'
  }, null, 2)}\n`);
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  ensureConversationEye,
  statusConversationEye
};
