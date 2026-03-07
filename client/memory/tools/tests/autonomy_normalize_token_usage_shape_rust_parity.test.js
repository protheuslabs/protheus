#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const autonomyPath = path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js');
const bridgePath = path.join(REPO_ROOT, 'systems', 'autonomy', 'backlog_autoscale_rust_bridge.js');

function loadAutonomy(rustEnabled) {
  process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = rustEnabled ? '1' : '0';
  delete require.cache[autonomyPath];
  delete require.cache[bridgePath];
  return require(autonomyPath);
}

function normalize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    prompt_tokens: raw.prompt_tokens == null ? null : Number(raw.prompt_tokens),
    completion_tokens: raw.completion_tokens == null ? null : Number(raw.completion_tokens),
    total_tokens: raw.total_tokens == null ? null : Number(raw.total_tokens),
    source: String(raw.source || '')
  };
}

function run() {
  const usage = {
    input_tokens: 12,
    output_tokens: 6,
    tokens_used: null
  };
  const source = 'route_execute_metrics';

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);
  const tsOut = normalize(ts.normalizeTokenUsageShape(usage, source));
  const rustOut = normalize(rust.normalizeTokenUsageShape(usage, source));
  assert.deepStrictEqual(rustOut, tsOut, 'normalizeTokenUsageShape mismatch');

  console.log('autonomy_normalize_token_usage_shape_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_normalize_token_usage_shape_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
