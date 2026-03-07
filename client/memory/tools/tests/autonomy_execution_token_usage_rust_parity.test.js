#!/usr/bin/env node
'use strict';

const path = require('path');
const assert = require('assert');

process.env.AUTONOMY_BACKLOG_AUTOSCALE_RUST_ENABLED = '1';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const controller = require(path.join(REPO_ROOT, 'systems', 'autonomy', 'autonomy_controller.js'));

function run() {
  const summary = {
    cost_estimate: {
      selected_model_tokens_est: 180
    },
    route_budget: {
      request_tokens_est: 160
    }
  };

  const withActual = controller.computeExecutionTokenUsage(
    summary,
    {
      token_usage: {
        prompt_tokens: 24,
        completion_tokens: 16,
        source: 'route_execute_metrics'
      }
    },
    140,
    120
  );
  assert.strictEqual(withActual.available, true, 'actual metrics should mark usage as available');
  assert.strictEqual(Number(withActual.actual_total_tokens), 40, 'actual tokens should include prompt + completion');
  assert.strictEqual(Number(withActual.estimated_tokens), 180, 'estimate should prefer selected model estimate');
  assert.strictEqual(Number(withActual.effective_tokens), 40, 'effective tokens should prefer actual usage');

  const fallback = controller.computeExecutionTokenUsage(summary, {}, 140, 120);
  assert.strictEqual(fallback.available, false, 'missing metrics should fall back to estimate');
  assert.strictEqual(String(fallback.source), 'estimated_fallback', 'fallback source should be explicit');
  assert.strictEqual(Number(fallback.estimated_tokens), 180, 'estimate should remain stable');
  assert.strictEqual(Number(fallback.effective_tokens), 180, 'effective tokens should match estimate when actual missing');

  console.log('autonomy_execution_token_usage_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_execution_token_usage_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
