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

function normalize(rowsRaw) {
  return (Array.isArray(rowsRaw) ? rowsRaw : [])
    .map((rowRaw) => {
      const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
      return {
        id: String(row.id || ''),
        tier: Number(row.tier || 0),
        title: String(row.title || ''),
        tier_weight: Number(row.tier_weight || 0),
        min_share: Number(row.min_share || 0),
        phrases: (Array.isArray(row.phrases) ? row.phrases : []).map((x) => String(x || '')).sort(),
        tokens: (Array.isArray(row.tokens) ? row.tokens : []).map((x) => String(x || '')).sort(),
        value_currencies: (Array.isArray(row.value_currencies) ? row.value_currencies : [])
          .map((x) => String(x || ''))
          .sort(),
        primary_currency: row.primary_currency ? String(row.primary_currency) : null
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function run() {
  const directives = [
    {
      id: 'T1_MEMORY',
      tier: 1,
      data: {
        metadata: {
          id: 'T1_MEMORY',
          description: 'Improve memory durability and recall quality',
          value_currency: 'quality'
        },
        intent: {
          primary: 'Increase memory reliability',
          value_currencies: ['time_savings']
        },
        scope: {
          included: ['durability guardrails', 'recall quality']
        },
        success_metrics: {
          leading: ['reduced regressions'],
          lagging: ['higher recall score']
        }
      }
    },
    {
      id: 'T2_OPS',
      tier: 2,
      data: {
        metadata: {
          id: 'T2_OPS',
          description: 'Reduce operational toil for repeatable runs'
        },
        intent: {
          primary: 'Improve runtime operations'
        }
      }
    }
  ];

  const ts = loadAutonomy(false);
  const rust = loadAutonomy(true);

  const tsOut = normalize(ts.compileDirectivePulseObjectives(directives));
  const rustOut = normalize(rust.compileDirectivePulseObjectives(directives));
  assert.deepStrictEqual(rustOut, tsOut, 'compileDirectivePulseObjectives mismatch');

  console.log('autonomy_compile_directive_pulse_objectives_rust_parity.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`autonomy_compile_directive_pulse_objectives_rust_parity.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
