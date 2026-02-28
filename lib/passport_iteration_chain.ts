#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  sha256Hex,
  stableStringify
} = require('./integrity_hash_utility');

let passportModule = null;
try {
  passportModule = require('../systems/security/agent_passport.js');
} catch {
  passportModule = null;
}

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..');
const CHAIN_PATH = process.env.PASSPORT_ITERATION_CHAIN_PATH
  ? path.resolve(process.env.PASSPORT_ITERATION_CHAIN_PATH)
  : path.join(ROOT, 'state', 'security', 'passport_iteration_chain.jsonl');
const LATEST_PATH = process.env.PASSPORT_ITERATION_CHAIN_LATEST_PATH
  ? path.resolve(process.env.PASSPORT_ITERATION_CHAIN_LATEST_PATH)
  : path.join(ROOT, 'state', 'security', 'passport_iteration_chain.latest.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 160) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return String(fs.readFileSync(filePath, 'utf8') || '')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function nextChainState() {
  const rows = readJsonl(CHAIN_PATH);
  if (!rows.length) return { seq: 1, prev_hash: null };
  const latest = rows[rows.length - 1];
  return {
    seq: Number(latest.seq || 0) + 1,
    prev_hash: cleanText(latest.hash || '', 120) || null
  };
}

function recordIterationStep(args: AnyObj = {}) {
  const lane = normalizeToken(args.lane || 'iterative_repair', 120) || 'iterative_repair';
  const step = normalizeToken(args.step || 'step', 120) || 'step';
  const iteration = Number(args.iteration || 1);
  const objectiveId = normalizeToken(args.objective_id || args.objectiveId || '', 180) || null;
  const targetPath = cleanText(args.target_path || args.targetPath || '', 360) || null;
  const metadata = args.metadata && typeof args.metadata === 'object' ? args.metadata : {};

  const chainState = nextChainState();
  const body = {
    schema_id: 'passport_iteration_chain_event',
    schema_version: '1.0',
    ts: nowIso(),
    lane,
    step,
    iteration,
    objective_id: objectiveId,
    target_path: targetPath,
    metadata
  };
  const payloadHash = sha256Hex(stableStringify(body));
  const hash = sha256Hex(stableStringify({
    seq: chainState.seq,
    prev_hash: chainState.prev_hash,
    payload_hash: payloadHash
  }));
  const row = {
    ...body,
    seq: chainState.seq,
    prev_hash: chainState.prev_hash,
    payload_hash: payloadHash,
    hash
  };

  appendJsonl(CHAIN_PATH, row);

  let passport = { ok: false, skipped: true };
  if (passportModule && typeof passportModule.appendAction === 'function') {
    try {
      const actionPayload = {
        action_type: `iteration_${lane}_${step}`,
        objective_id: objectiveId,
        target: targetPath,
        status: normalizeToken(metadata.status || 'ok', 40) || 'ok',
        attempted: true,
        verified: metadata.verified === true,
        metadata: {
          iteration,
          seq: chainState.seq,
          hash
        }
      };
      const pass = passportModule.appendAction({
        source: 'iteration_chain',
        action: actionPayload
      });
      passport = pass && typeof pass === 'object' ? pass : { ok: false, skipped: true };
    } catch (err) {
      passport = {
        ok: false,
        error: cleanText(err && err.message ? err.message : err, 200)
      };
    }
  }

  const out = {
    ok: true,
    type: 'passport_iteration_chain_record',
    ts: nowIso(),
    lane,
    step,
    iteration,
    seq: chainState.seq,
    hash,
    prev_hash: chainState.prev_hash,
    chain_path: relPath(CHAIN_PATH),
    passport
  };
  writeJsonAtomic(LATEST_PATH, out);
  return out;
}

function status() {
  const rows = readJsonl(CHAIN_PATH);
  const latest = rows.length ? rows[rows.length - 1] : null;
  return {
    ok: true,
    type: 'passport_iteration_chain_status',
    ts: nowIso(),
    total_events: rows.length,
    latest: latest
      ? {
        seq: Number(latest.seq || 0),
        hash: latest.hash || null,
        lane: latest.lane || null,
        step: latest.step || null,
        iteration: latest.iteration || null,
        ts: latest.ts || null
      }
      : null,
    chain_path: relPath(CHAIN_PATH),
    latest_path: relPath(LATEST_PATH)
  };
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'record') {
    const metadataRaw = cleanText(args['metadata-json'] || args.metadata_json || '', 20000);
    let metadata = {};
    if (metadataRaw) {
      try { metadata = JSON.parse(metadataRaw); } catch { metadata = {}; }
    }
    out = recordIterationStep({
      lane: args.lane,
      step: args.step,
      iteration: args.iteration,
      objective_id: args['objective-id'] || args.objective_id,
      target_path: args['target-path'] || args.target_path,
      metadata
    });
  } else {
    out = status();
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  recordIterationStep,
  status
};
