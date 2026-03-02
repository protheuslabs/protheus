#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-132
 * Civic duty allocation engine.
 */

const path = require('path');
const {
  readJson,
  clampNumber,
  normalizeToken
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.CIVIC_DUTY_ALLOCATION_POLICY_PATH
  ? path.resolve(process.env.CIVIC_DUTY_ALLOCATION_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'civic_duty_allocation_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/civic_duty_allocation_engine.js configure --owner=<owner_id> --duty-pct=<0..0.5> [--focus=objective_id]');
  console.log('  node systems/autonomy/civic_duty_allocation_engine.js allocate --owner=<owner_id> [--objective=<id>] [--risk-tier=2] [--approved=1]');
  console.log('  node systems/autonomy/civic_duty_allocation_engine.js status [--owner=<owner_id>]');
}

function pickObjective(policy: any, requestedId: string | null) {
  const catalogPath = policy.objectives && policy.objectives.catalog_path
    ? String(policy.objectives.catalog_path)
    : '';
  const payload = readJson(catalogPath, { objectives: [] });
  const objectives = Array.isArray(payload && payload.objectives) ? payload.objectives : [];
  const requested = requestedId ? objectives.find((row: any) => normalizeToken(row.id, 120) === requestedId) : null;
  if (requested) return requested;
  return objectives
    .slice()
    .sort((a: any, b: any) => Number(b.priority || 0) - Number(a.priority || 0))[0] || null;
}

runStandardLane({
  lane_id: 'V3-RACE-132',
  script_rel: 'systems/autonomy/civic_duty_allocation_engine.js',
  policy_path: POLICY_PATH,
  stream: 'autonomy.civic_duty',
  paths: {
    memory_dir: 'memory/civic_duty',
    adaptive_index_path: 'adaptive/civic_duty/index.json',
    events_path: 'state/autonomy/civic_duty/events.jsonl',
    latest_path: 'state/autonomy/civic_duty/latest.json',
    receipts_path: 'state/autonomy/civic_duty/receipts.jsonl'
  },
  usage,
  handlers: {
    allocate(policy: any, args: any, ctx: any) {
      const owner = normalizeToken(args.owner || args.owner_id, 120);
      if (!owner) return { ok: false, error: 'missing_owner' };
      const requested = normalizeToken(args.objective || '', 120) || null;
      const objective = pickObjective(policy, requested);
      if (!objective) {
        return {
          ok: false,
          error: 'missing_objective_catalog',
          catalog_path: policy.objectives && policy.objectives.catalog_path ? policy.objectives.catalog_path : null
        };
      }
      const dutyPct = clampNumber(
        args['duty-pct'] != null ? args['duty-pct'] : args.duty_pct,
        0,
        1,
        Number(policy.constraints && policy.constraints.default_duty_pct || 0.1)
      );
      if (dutyPct > Number(policy.constraints && policy.constraints.max_duty_pct || 0.5)) {
        return {
          ok: false,
          error: 'duty_pct_above_max',
          duty_pct: dutyPct,
          max_duty_pct: Number(policy.constraints && policy.constraints.max_duty_pct || 0.5)
        };
      }
      return ctx.cmdRecord(policy, {
        ...args,
        owner,
        event: 'civic_duty_allocate',
        payload_json: JSON.stringify({
          objective_id: normalizeToken(objective.id || 'public_good_default', 120) || 'public_good_default',
          objective_title: String(objective.title || objective.id || 'Untitled objective').slice(0, 220),
          objective_priority: Number(objective.priority || 0),
          duty_pct: dutyPct,
          bounded_by_budget_gate: true,
          bounded_by_risk_tier_gate: true
        })
      });
    }
  }
});
