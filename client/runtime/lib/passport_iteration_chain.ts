#!/usr/bin/env node
'use strict';
export {};

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only.

const path = require('path');
const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

function runtimeRoot() {
  if (process.env.PROTHEUS_RUNTIME_ROOT) {
    return path.resolve(String(process.env.PROTHEUS_RUNTIME_ROOT));
  }
  return path.resolve(__dirname, '..');
}

function cleanText(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v, maxLen = 160) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

const ROOT = runtimeRoot();
const CHAIN_PATH = process.env.PASSPORT_ITERATION_CHAIN_PATH
  ? path.resolve(String(process.env.PASSPORT_ITERATION_CHAIN_PATH))
  : path.join(ROOT, 'local', 'state', 'security', 'passport_iteration_chain.jsonl');
const LATEST_PATH = process.env.PASSPORT_ITERATION_CHAIN_LATEST_PATH
  ? path.resolve(String(process.env.PASSPORT_ITERATION_CHAIN_LATEST_PATH))
  : path.join(ROOT, 'local', 'state', 'security', 'passport_iteration_chain.latest.json');

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'passport_iteration_chain', 'passport-iteration-chain-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const out = bridge.run([
    command,
    `--payload-base64=${encodeBase64(JSON.stringify(payload && typeof payload === 'object' ? payload : {}))}`
  ]);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && receipt.payload && typeof receipt.payload === 'object'
    ? receipt.payload
    : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `passport_iteration_chain_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `passport_iteration_chain_kernel_${command}_failed`);
    return { ok: false, error: message || `passport_iteration_chain_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `passport_iteration_chain_kernel_${command}_bridge_failed`
      : `passport_iteration_chain_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function recordIterationStep(args = {}) {
  return invoke('record', {
    root: ROOT,
    chain_path: CHAIN_PATH,
    latest_path: LATEST_PATH,
    lane: normalizeToken(args.lane || 'iterative_repair', 120) || 'iterative_repair',
    step: normalizeToken(args.step || 'step', 120) || 'step',
    iteration: Number(args.iteration || 1),
    objective_id: normalizeToken(args.objective_id || args.objectiveId || '', 180) || null,
    target_path: cleanText(args.target_path || args.targetPath || '', 360) || null,
    metadata: args.metadata && typeof args.metadata === 'object' ? args.metadata : {}
  });
}

function status() {
  return invoke('status', {
    root: ROOT,
    chain_path: CHAIN_PATH,
    latest_path: LATEST_PATH
  });
}

function parseArgs(argv) {
  const out = { _: [] };
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
  let out;
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
