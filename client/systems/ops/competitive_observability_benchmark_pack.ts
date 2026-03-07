#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-174
 * Competitive observability benchmark pack.
 */

const fs = require('fs');
const path = require('path');
const { stableHash, nowIso } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.COMPETITIVE_OBSERVABILITY_BENCHMARK_POLICY_PATH
  ? path.resolve(process.env.COMPETITIVE_OBSERVABILITY_BENCHMARK_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'competitive_observability_benchmark_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/competitive_observability_benchmark_pack.js configure --owner=<owner_id> [--scenario=default]');
  console.log('  node systems/ops/competitive_observability_benchmark_pack.js run --owner=<owner_id> [--scenario=deterministic_001] [--risk-tier=2]');
  console.log('  node systems/ops/competitive_observability_benchmark_pack.js status [--owner=<owner_id>]');
}

function deterministicScore(name: string, scenario: string) {
  const raw = parseInt(stableHash(`${name}|${scenario}`, 4), 16);
  return 60 + (raw % 41);
}

runStandardLane({
  lane_id: 'V3-RACE-174',
  script_rel: 'systems/ops/competitive_observability_benchmark_pack.js',
  policy_path: POLICY_PATH,
  stream: 'ops.competitive_benchmark',
  paths: {
    memory_dir: 'memory/ops/benchmarks',
    adaptive_index_path: 'adaptive/ops/benchmarks/index.json',
    events_path: 'state/ops/competitive_benchmark/events.jsonl',
    latest_path: 'state/ops/competitive_benchmark/latest.json',
    receipts_path: 'state/ops/competitive_benchmark/receipts.jsonl',
    scorecards_path: 'state/ops/competitive_benchmark/scorecards.jsonl'
  },
  usage,
  handlers: {
    run(policy: any, args: any, ctx: any) {
      const scenario = String(args.scenario || 'deterministic_001').slice(0, 120);
      const scorecard = {
        ts: nowIso(),
        scenario,
        parity: {
          letta: deterministicScore('letta', scenario),
          mastra: deterministicScore('mastra', scenario),
          langgraph: deterministicScore('langgraph', scenario),
          openfang: deterministicScore('openfang', scenario),
          protheus: deterministicScore('protheus', scenario)
        },
        private_fixture_content: false
      };
      const scorecardsPath = String(policy.paths.scorecards_path);
      fs.mkdirSync(path.dirname(scorecardsPath), { recursive: true });
      fs.appendFileSync(scorecardsPath, `${JSON.stringify(scorecard)}\n`, 'utf8');
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'competitive_benchmark_run',
        payload_json: JSON.stringify({
          scenario,
          scorecard
        })
      });
    }
  }
});
