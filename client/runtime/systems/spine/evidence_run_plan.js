#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/spine::evidence_run_plan (authoritative)
const { createOpsLaneBridge } = require('../../lib/rust_lane_bridge');

process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_DOMAIN_BRIDGE_TIMEOUT_MS || '1200';
process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS =
  process.env.PROTHEUS_OPS_LOCAL_TIMEOUT_MS || '1500';

const bridge = createOpsLaneBridge(__dirname, 'evidence_run_plan', 'spine');
const COMMAND = 'evidence-run-plan';

function toPressure(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return s === 'soft' || s === 'hard' ? s : 'none';
}

function clampConfigured(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return 2;
  const i = Math.floor(n);
  if (i < 0) return 0;
  if (i > 6) return 6;
  return i;
}

function localFallbackPlan(configuredRunsRaw, budgetPressureRaw, projectedPressureRaw) {
  const configuredRuns = clampConfigured(configuredRunsRaw);
  const budgetPressure = toPressure(budgetPressureRaw);
  const projectedPressure = toPressure(projectedPressureRaw);
  const pressureThrottle = budgetPressure !== 'none' || projectedPressure !== 'none';
  const evidenceRuns = pressureThrottle ? Math.min(configuredRuns, 1) : configuredRuns;
  return {
    configured_runs: configuredRuns,
    budget_pressure: budgetPressure,
    projected_pressure: projectedPressure,
    pressure_throttle: pressureThrottle,
    evidence_runs: evidenceRuns
  };
}

function computeEvidenceRunPlan(configuredRunsRaw, budgetPressureRaw, projectedPressureRaw) {
  const args = [
    COMMAND,
    `--configured-runs=${String(configuredRunsRaw == null ? '' : configuredRunsRaw)}`,
    `--budget-pressure=${toPressure(budgetPressureRaw)}`,
    `--projected-pressure=${toPressure(projectedPressureRaw)}`
  ];
  const out = bridge.run(args);
  const plan = out && out.payload && out.payload.plan ? out.payload.plan : null;
  return plan || localFallbackPlan(configuredRunsRaw, budgetPressureRaw, projectedPressureRaw);
}

function runCore(args = []) {
  const out = bridge.run([COMMAND, ...(Array.isArray(args) ? args : [])]);
  if (out && out.stdout) process.stdout.write(out.stdout);
  if (out && out.stderr) process.stderr.write(out.stderr);
  if (out && out.payload && !out.stdout) process.stdout.write(`${JSON.stringify(out.payload)}\n`);
  return out;
}

if (require.main === module) {
  const out = runCore(process.argv.slice(2));
  process.exit(Number.isFinite(out && out.status) ? Number(out.status) : 1);
}

module.exports = {
  lane: bridge.lane,
  run: (args = []) => bridge.run([COMMAND, ...args]),
  computeEvidenceRunPlan
};
