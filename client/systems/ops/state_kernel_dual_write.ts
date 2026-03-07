#!/usr/bin/env node
'use strict';
export {};

/**
 * state_kernel_dual_write.js
 *
 * Dual-write wrapper for phased zero-downtime cutover.
 */

const fs = require('fs');
const path = require('path');

const stateKernel = require('./state_kernel');
const cutover = require('./state_kernel_cutover');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function effectiveMode() {
  const pol = cutover.loadPolicy(cutover.DEFAULT_POLICY_PATH);
  const st = cutover.loadState(pol);
  const mode = normalizeToken(st.mode || pol.default_mode, 80) || 'dual_write';
  return { mode, policy: pol, state: st };
}

function writeMirror(args: AnyObj = {}) {
  const modeCtx = effectiveMode();
  const mode = modeCtx.mode;
  const fsPath = cleanText(args['fs-path'] || args.fs_path || '', 520);
  const payload = (() => {
    const txt = cleanText(args['payload-json'] || args.payload_json || '', 2000000);
    if (!txt) return {};
    try { return JSON.parse(txt); } catch { return { raw: txt }; }
  })();
  const organId = normalizeToken(args['organ-id'] || args.organ_id || '', 120)
    || normalizeToken(path.basename(fsPath || 'dual_write_target').replace(/\.[a-z0-9]+$/i, ''), 120)
    || 'dual_write_target';

  const writes: AnyObj = {
    mode,
    wrote_fs: false,
    wrote_sqlite: false
  };

  if (mode === 'fs_only' || mode === 'dual_write') {
    if (!fsPath) throw new Error('fs_path_required_for_fs_write_modes');
    const abs = path.isAbsolute(fsPath) ? fsPath : path.join(ROOT, fsPath);
    writeJsonAtomic(abs, payload);
    writes.wrote_fs = true;
    writes.fs_path = rel(abs);
  }

  if (mode !== 'fs_only') {
    const kernelPolicy = stateKernel.loadPolicy(stateKernel.DEFAULT_POLICY_PATH);
    const out = stateKernel.setOrganState(kernelPolicy, {
      'organ-id': organId,
      'state-json': JSON.stringify(payload)
    });
    writes.wrote_sqlite = out.ok === true;
    writes.sqlite = out;
  }

  if (mode === 'read_cutover' && fsPath) {
    // Keep fallback mirror active during read-cutover validation window.
    const abs = path.isAbsolute(fsPath) ? fsPath : path.join(ROOT, fsPath);
    writeJsonAtomic(abs, payload);
    writes.wrote_fs = true;
    writes.fs_path = rel(abs);
  }

  return {
    ok: true,
    type: 'state_kernel_dual_write_mirror',
    ts: nowIso(),
    organ_id: organId,
    ...writes
  };
}

function enqueueMirror(args: AnyObj = {}) {
  const modeCtx = effectiveMode();
  const mode = modeCtx.mode;
  const queueName = normalizeToken(args['queue-name'] || args.queue_name || '', 120) || 'default';
  const payloadJson = cleanText(args['payload-json'] || args.payload_json || '', 1200000) || '{}';
  const fsQueuePath = cleanText(args['fs-queue-path'] || args.fs_queue_path || '', 520);

  const out: AnyObj = {
    ok: true,
    type: 'state_kernel_dual_write_enqueue',
    ts: nowIso(),
    mode,
    queue_name: queueName,
    wrote_fs: false,
    wrote_sqlite: false
  };

  if (mode === 'fs_only' || mode === 'dual_write' || mode === 'read_cutover') {
    if (fsQueuePath) {
      const abs = path.isAbsolute(fsQueuePath) ? fsQueuePath : path.join(ROOT, fsQueuePath);
      appendJsonl(abs, {
        ts: nowIso(),
        queue_name: queueName,
        payload: (() => { try { return JSON.parse(payloadJson); } catch { return { raw: payloadJson }; } })()
      });
      out.wrote_fs = true;
      out.fs_queue_path = rel(abs);
    }
  }

  if (mode !== 'fs_only') {
    const kernelPolicy = stateKernel.loadPolicy(stateKernel.DEFAULT_POLICY_PATH);
    const sqlite = stateKernel.enqueueTask(kernelPolicy, {
      'queue-name': queueName,
      'payload-json': payloadJson,
      priority: args.priority
    });
    out.wrote_sqlite = sqlite.ok === true;
    out.sqlite = sqlite;
  }

  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/state_kernel_dual_write.js status');
  console.log('  node systems/ops/state_kernel_dual_write.js mirror --organ-id=<id> --payload-json=<json> [--fs-path=state/path.json]');
  console.log('  node systems/ops/state_kernel_dual_write.js enqueue --queue-name=<name> --payload-json=<json> [--fs-queue-path=state/path.jsonl] [--priority=N]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }

  let out: AnyObj;
  try {
    if (cmd === 'status') {
      const modeCtx = effectiveMode();
      out = {
        ok: true,
        type: 'state_kernel_dual_write_status',
        ts: nowIso(),
        mode: modeCtx.mode,
        cutover_policy_path: rel(modeCtx.policy.policy_path),
        cutover_state_path: rel(modeCtx.policy.state_path)
      };
    } else if (cmd === 'mirror') {
      out = writeMirror(args);
    } else if (cmd === 'enqueue') {
      out = enqueueMirror(args);
    } else {
      out = { ok: false, type: 'state_kernel_dual_write', error: `unknown_command:${cmd}` };
    }
  } catch (err) {
    out = {
      ok: false,
      type: 'state_kernel_dual_write',
      error: cleanText(err && (err as AnyObj).message ? (err as AnyObj).message : err || 'state_kernel_dual_write_failed', 260)
    };
  }

  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  effectiveMode,
  writeMirror,
  enqueueMirror
};
