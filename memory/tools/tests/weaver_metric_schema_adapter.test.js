#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { buildMetricSchema } = require(path.join(ROOT, 'systems', 'weaver', 'metric_schema.js'));

try {
  const schema = buildMetricSchema({
    policy_metric_schema: {
      include_builtin_metrics: false,
      default_primary_metric: 'novelty'
    },
    strategy: {},
    requested_metrics: 'novelty:1',
    adapter_rows: [
      {
        id: 'novelty_pack',
        enabled: true,
        metrics: [
          {
            metric_id: 'novelty',
            label: 'Novelty',
            default_weight: 0.4,
            value_currency: 'learning',
            tags: ['creative']
          }
        ]
      },
      {
        id: 'disabled_pack',
        enabled: false,
        metrics: [
          { metric_id: 'ignored_metric', default_weight: 0.9 }
        ]
      }
    ]
  });

  assert.ok(schema && typeof schema === 'object', 'schema should be returned');
  assert.strictEqual(Number(schema.adapter_rows_count || 0), 1, 'enabled adapter metrics should be counted');
  const novelty = (Array.isArray(schema.metrics) ? schema.metrics : []).find((row) => String(row.metric_id) === 'novelty');
  assert.ok(novelty, 'adapter metric should be present');
  assert.ok(
    Array.isArray(novelty.tags) && novelty.tags.includes('adapter:novelty_pack'),
    'adapter tag should be attached to metric row'
  );
  const ignored = (Array.isArray(schema.metrics) ? schema.metrics : []).find((row) => String(row.metric_id) === 'ignored_metric');
  assert.strictEqual(!!ignored, false, 'disabled adapter metrics should be ignored');

  console.log('weaver_metric_schema_adapter.test.js: OK');
} catch (err) {
  console.error(`weaver_metric_schema_adapter.test.js: FAIL: ${err.message}`);
  process.exit(1);
}

