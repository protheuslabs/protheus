#!/usr/bin/env node
'use strict';
export {};

const { runSingularitySeedCycle } = require('./index.js');

type AnyObj = Record<string, any>;

const DRIFT_THRESHOLD_PCT = 2.0;

function runSovereigntyGuardedCycle(opts: AnyObj = {}) {
  const result = runSingularitySeedCycle(opts);
  if (!result || result.ok !== true || !result.payload || typeof result.payload !== 'object') {
    return {
      ok: false,
      error: result && result.error ? String(result.error) : 'cycle_execution_failed',
      fail_closed: true
    };
  }

  const payload = result.payload;
  const maxDrift = Number(payload.max_drift_pct || 0);
  const failClosed = Boolean(payload.fail_closed) || maxDrift > DRIFT_THRESHOLD_PCT;

  return {
    ok: !failClosed,
    fail_closed: failClosed,
    threshold_pct: DRIFT_THRESHOLD_PCT,
    max_drift_pct: maxDrift,
    sovereignty_index: Number(payload.sovereignty_index || 0),
    cycle: payload
  };
}

module.exports = {
  runSovereigntyGuardedCycle,
  DRIFT_THRESHOLD_PCT
};
