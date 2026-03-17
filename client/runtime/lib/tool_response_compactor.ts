#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer0/ops (authoritative)
// Thin TypeScript wrapper only.

const path = require('path');
const { createOpsLaneBridge } = require('./rust_lane_bridge.ts');

const CLIENT_ROOT = path.resolve(__dirname, '..');
const TOOL_RAW_DIR = path.join(CLIENT_ROOT, 'local', 'logs', 'tool_raw');
const COMPACTION_THRESHOLD_CHARS = 1200;
const COMPACTION_THRESHOLD_LINES = 40;

process.env.PROTHEUS_OPS_USE_PREBUILT = process.env.PROTHEUS_OPS_USE_PREBUILT || '0';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS = process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '120000';
const bridge = createOpsLaneBridge(__dirname, 'tool_response_compactor', 'tool-response-compactor-kernel');

function encodeBase64(value) {
  return Buffer.from(String(value == null ? '' : value), 'utf8').toString('base64');
}

function invoke(command, payload = {}, opts = {}) {
  const out = bridge.run([
    command,
    `--payload-base64=${encodeBase64(JSON.stringify(payload || {}))}`
  ]);
  const receipt = out && out.payload && typeof out.payload === 'object' ? out.payload : null;
  const payloadOut = receipt && typeof receipt.payload === 'object' ? receipt.payload : receipt;
  if (out.status !== 0) {
    const message = payloadOut && typeof payloadOut.error === 'string'
      ? payloadOut.error
      : (out && out.stderr ? String(out.stderr).trim() : `tool_response_compactor_kernel_${command}_failed`);
    if (opts.throwOnError !== false) throw new Error(message || `tool_response_compactor_kernel_${command}_failed`);
    return { ok: false, error: message || `tool_response_compactor_kernel_${command}_failed` };
  }
  if (!payloadOut || typeof payloadOut !== 'object') {
    const message = out && out.stderr
      ? String(out.stderr).trim() || `tool_response_compactor_kernel_${command}_bridge_failed`
      : `tool_response_compactor_kernel_${command}_bridge_failed`;
    if (opts.throwOnError !== false) throw new Error(message);
    return { ok: false, error: message };
  }
  return payloadOut;
}

function redactSecrets(content) {
  const out = invoke('redact', {
    root_dir: CLIENT_ROOT,
    data: typeof content === 'string' ? content : JSON.stringify(content)
  });
  return String(out.content || '');
}

function extractSummary(data, toolName) {
  const out = invoke('extract-summary', {
    root_dir: CLIENT_ROOT,
    data,
    tool_name: toolName || 'unknown'
  });
  return Array.isArray(out.summary) ? out.summary : [];
}

function compactToolResponse(data, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const out = invoke('compact', {
    root_dir: opts.rootDir || CLIENT_ROOT,
    data,
    tool_name: opts.toolName || 'unknown'
  });
  return out && typeof out === 'object'
    ? out
    : {
        compacted: false,
        content: redactSecrets(typeof data === 'string' ? data : JSON.stringify(data)),
        metrics: { chars: 0, lines: 0 }
      };
}

function redactSecretsOnly(content) {
  return redactSecrets(content);
}

module.exports = {
  TOOL_RAW_DIR,
  COMPACTION_THRESHOLD_CHARS,
  COMPACTION_THRESHOLD_LINES,
  compactToolResponse,
  redactSecrets,
  redactSecretsOnly,
  extractSummary
};

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    input += chunk;
  });
  process.stdin.on('end', () => {
    const result = compactToolResponse(input, { toolName: process.argv[2] || 'test' });
    console.log(result.content);
    if (result.metrics) {
      console.error(`\n[COMPACTOR METRICS] ${JSON.stringify(result.metrics, null, 2)}`);
    }
  });
}
