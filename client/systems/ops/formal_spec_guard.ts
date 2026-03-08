#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STATE_DIR = path.join(ROOT, 'client', 'local', 'state', 'ops', 'formal_spec_guard');
const LATEST_PATH = path.join(STATE_DIR, 'latest.json');
const RECEIPTS_PATH = path.join(STATE_DIR, 'receipts.jsonl');

function usage() {
  console.log('Usage: node client/lib/ts_entrypoint.js client/systems/ops/formal_spec_guard.ts run|status [--strict=1|0]');
}

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: any = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
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

function toBool(v: any, fallback = false) {
  if (v == null) return fallback;
  const t = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(t)) return true;
  if (['0', 'false', 'no', 'off'].includes(t)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, value: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data == null ? fallback : data;
  } catch {
    return fallback;
  }
}

function exists(relPath: string) {
  return fs.existsSync(path.join(ROOT, relPath));
}

function readText(relPath: string) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

function hashOf(value: any) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function run(strict: boolean) {
  const requiredFiles = [
    'planes/spec/README.md',
    'planes/spec/tla/three_plane_boundary.tla',
    'planes/spec/tla/three_plane_boundary.cfg',
    'planes/contracts/README.md',
    'planes/contracts/conduit_envelope.schema.json'
  ];

  const missing = requiredFiles.filter((p) => !exists(p));

  const tlaPath = 'planes/spec/tla/three_plane_boundary.tla';
  const tlaTokens = [
    'NoDirectPlaneMutation',
    'ConduitInvariant',
    'SafetyAuthorityInvariant',
    'ConduitOnlyInvariant'
  ];
  const tlaMissingTokens: string[] = [];
  if (exists(tlaPath)) {
    const src = readText(tlaPath);
    for (const token of tlaTokens) {
      if (!src.includes(token)) tlaMissingTokens.push(token);
    }
  }

  const schemaPath = 'planes/contracts/conduit_envelope.schema.json';
  const schemaMissingFields: string[] = [];
  if (exists(schemaPath)) {
    try {
      const parsed = JSON.parse(readText(schemaPath));
      const required = Array.isArray(parsed.required) ? parsed.required : [];
      for (const key of ['domain', 'command', 'payload']) {
        if (!required.includes(key)) schemaMissingFields.push(key);
      }
    } catch {
      schemaMissingFields.push('__invalid_json__');
    }
  }

  const architecturePath = 'ARCHITECTURE.md';
  const architectureMissingRefs: string[] = [];
  if (exists(architecturePath)) {
    const arch = readText(architecturePath);
    if (!arch.includes('planes/spec')) architectureMissingRefs.push('planes/spec');
    if (!arch.includes('planes/contracts')) architectureMissingRefs.push('planes/contracts');
  } else {
    architectureMissingRefs.push('__missing_ARCHITECTURE__');
  }

  const ok = missing.length === 0
    && tlaMissingTokens.length === 0
    && schemaMissingFields.length === 0
    && architectureMissingRefs.length === 0;

  const payload = {
    ok,
    type: 'formal_spec_guard',
    ts: nowIso(),
    strict,
    required_files: requiredFiles,
    missing_files: missing,
    tla_missing_tokens: tlaMissingTokens,
    schema_missing_fields: schemaMissingFields,
    architecture_missing_refs: architectureMissingRefs,
    receipt_hash: ''
  } as any;
  payload.receipt_hash = hashOf(payload);

  writeJsonAtomic(LATEST_PATH, payload);
  appendJsonl(RECEIPTS_PATH, payload);

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!ok && strict) process.exit(1);
}

function status() {
  const payload = readJson(LATEST_PATH, {
    ok: false,
    type: 'formal_spec_guard',
    ts: nowIso(),
    reason: 'no_state'
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (!payload.ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'run').trim();
  const strict = toBool(args.strict, cmd === 'run');

  if (cmd === 'run') {
    run(strict);
    return;
  }
  if (cmd === 'status') {
    status();
    return;
  }

  usage();
  process.exit(2);
}

main();
