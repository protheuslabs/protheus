#!/usr/bin/env node
'use strict';

const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const { runSovereigntyGuardedCycle } = require(path.join(ROOT, 'systems', 'singularity_seed', 'orchestrator.js'));

function main() {
  const result = runSovereigntyGuardedCycle({
    allow_cli_fallback: true,
    request: {
      drift_overrides: []
    }
  });

  const payload = {
    ok: Boolean(result && result.ok),
    fail_closed: Boolean(result && result.fail_closed),
    max_drift_pct: Number(result && result.max_drift_pct || 0),
    sovereignty_index: Number(result && result.sovereignty_index || 0),
    cycle_id: String(result && result.cycle && result.cycle.cycle_id || ''),
    loop_count: Array.isArray(result && result.cycle && result.cycle.outcomes)
      ? result.cycle.outcomes.length
      : 0,
    status: String(result && result.cycle && result.cycle.status || '')
  };

  console.log(JSON.stringify(payload, null, 2));

  if (!payload.ok) {
    process.exit(1);
  }
}

main();
