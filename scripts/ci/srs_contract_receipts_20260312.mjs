#!/usr/bin/env node
/* eslint-disable no-console */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const ROOT = resolve('.');
const BIN = resolve(ROOT, 'target/debug/protheus-ops');
const OUT_JSON = 'core/local/artifacts/srs_contract_receipts_20260312.json';
const OUT_MD = 'local/workspace/archive/docs-workspace/SRS_CONTRACT_RECEIPTS_20260312.md';

const checks = [
  {
    id: 'V6-EVAL-001.1',
    argv: ['ab-lane-eval', 'enable-neuralavb', '--enabled=1'],
    expectedType: 'ab_lane_eval_neuralavb_enable',
  },
  {
    id: 'V6-EVAL-001.2',
    argv: [
      'ab-lane-eval',
      'experiment-loop',
      '--build-score=0.84',
      '--experiment-score=0.82',
      '--evaluate-score=0.83',
      '--baseline-cost-usd=8',
      '--run-cost-usd=2',
      '--baseline-accuracy=0.93',
      '--run-accuracy=0.929',
      '--iterations=1',
    ],
    expectedType: 'ab_lane_eval_experiment_loop',
  },
  {
    id: 'V6-EVAL-001.3',
    argv: ['ab-lane-eval', 'benchmark-neuralavb'],
    expectedType: 'ab_lane_eval_neuralavb_benchmark',
  },
  {
    id: 'V6-EVAL-001.4',
    argv: ['protheusctl', 'eval', 'enable', 'neuralavb', '--enabled=1'],
    expectedType: 'ab_lane_eval_neuralavb_enable',
  },
  {
    id: 'V6-ECONOMY-001.1',
    argv: ['llm-economy-organ', 'virtuals-acp', '--action=earn', '--apply=1'],
    expectedType: 'llm_economy_virtuals_acp',
  },
  {
    id: 'V6-ECONOMY-001.2',
    argv: ['llm-economy-organ', 'bankrbot-defi', '--strategy=stable', '--apply=1'],
    expectedType: 'llm_economy_bankrbot_defi',
  },
  {
    id: 'V6-ECONOMY-001.3',
    argv: ['llm-economy-organ', 'jobs-marketplace', '--source=nookplot', '--apply=1'],
    expectedType: 'llm_economy_jobs_marketplace',
  },
  {
    id: 'V6-ECONOMY-001.4',
    argv: ['llm-economy-organ', 'skills-marketplace', '--source=heurist', '--apply=1'],
    expectedType: 'llm_economy_skills_marketplace',
  },
  {
    id: 'V6-ECONOMY-001.5',
    argv: ['llm-economy-organ', 'fairscale-credit', '--delta=2.5', '--apply=1'],
    expectedType: 'llm_economy_fairscale_credit',
  },
  {
    id: 'V6-ECONOMY-001.6',
    argv: ['llm-economy-organ', 'mining-hand', '--network=litcoin', '--hours=4', '--apply=1'],
    expectedType: 'llm_economy_mining_hand',
  },
  {
    id: 'V6-ECONOMY-001.7',
    argv: [
      'llm-economy-organ',
      'trade-router',
      '--chain=solana',
      '--symbol=SOL/USDC',
      '--side=buy',
      '--qty=0.1',
      '--apply=1',
    ],
    expectedType: 'llm_economy_trade_router',
  },
  {
    id: 'V6-ECONOMY-001.8',
    argv: ['protheusctl', 'economy', 'enable', 'all', '--apply=1'],
    expectedType: 'llm_economy_organ_enable',
  },
  {
    id: 'V6-ECONOMY-002.1',
    argv: [
      'llm-economy-organ',
      'upgrade-trading-hand',
      '--mode=analysis',
      '--symbol=SOL/USD',
      '--apply=1',
    ],
    expectedType: 'llm_economy_organ_trading_hand_upgrade',
  },
  {
    id: 'V6-ECONOMY-002.2',
    argv: [
      'llm-economy-organ',
      'debate-bullbear',
      '--symbol=SOL/USD',
      '--bull-score=0.71',
      '--bear-score=0.43',
      '--apply=1',
    ],
    expectedType: 'llm_economy_organ_bullbear_debate',
  },
  {
    id: 'V6-ECONOMY-002.3',
    argv: [
      'llm-economy-organ',
      'alpaca-execute',
      '--mode=analysis',
      '--symbol=SOL/USD',
      '--side=buy',
      '--qty=0.5',
      '--apply=1',
    ],
    expectedType: 'llm_economy_organ_alpaca_execute',
  },
  {
    id: 'V6-ECONOMY-002.4',
    argv: ['llm-economy-organ', 'dashboard'],
    expectedType: 'llm_economy_organ_dashboard',
  },
  {
    id: 'V6-ECONOMY-002.5',
    argv: ['llm-economy-organ', 'model-support-refresh', '--apply=1'],
    expectedType: 'llm_economy_model_support_refresh',
  },
  {
    id: 'V6-MODEL-003.1',
    argv: ['model-router', 'compact-context', '--max-lines=20', '--source=soul,memory,task'],
    expectedType: 'model_router_compact_context',
  },
  {
    id: 'V6-MODEL-003.2',
    argv: ['model-router', 'decompose-task', '--task=ship ml eval harness with receipts'],
    expectedType: 'model_router_decompose_task',
  },
  {
    id: 'V6-MODEL-003.3',
    argv: ['model-router', 'adapt-repo', '--repo=.', '--strategy=reuse-first'],
    expectedType: 'model_router_adapt_repo',
  },
  {
    id: 'V6-MODEL-003.4',
    argv: ['protheusctl', 'agent', 'reset', '--scope=routing'],
    expectedType: 'model_router_agent_reset',
  },
  {
    id: 'V6-MODEL-003.5',
    argv: ['protheusctl', 'model', 'use', 'cheap'],
    expectedType: 'model_router_optimize_cheap',
  },
  {
    id: 'V6-MODEL-003.6',
    argv: [
      'model-router',
      'night-schedule',
      '--start-hour=0',
      '--end-hour=6',
      '--timezone=America/Denver',
      '--cheap-model=minimax/m2.5',
    ],
    expectedType: 'model_router_night_schedule',
  },
  {
    id: 'V6-NETWORK-004.1',
    argv: ['p2p-gossip-seed', 'compute-proof', '--share=1', '--matmul-size=32', '--credits=2'],
    expectedType: 'p2p_gossip_seed_compute_proof',
  },
  {
    id: 'V6-NETWORK-004.2',
    argv: ['p2p-gossip-seed', 'dashboard'],
    expectedType: 'p2p_gossip_seed_dashboard',
  },
  {
    id: 'V6-NETWORK-004.3',
    argv: ['p2p-gossip-seed', 'gossip', '--topic=ranking', '--breakthrough=listnet-rediscovered'],
    expectedType: 'p2p_gossip_seed_breakthrough',
  },
  {
    id: 'V6-NETWORK-004.4',
    argv: ['p2p-gossip-seed', 'idle-rss', '--feed=tech', '--note=inter-agent-commented'],
    expectedType: 'p2p_gossip_seed_idle_rss',
  },
  {
    id: 'V6-NETWORK-004.5',
    argv: ['p2p-gossip-seed', 'ranking-evolve', '--metric=ndcg@10', '--delta=0.04'],
    expectedType: 'p2p_gossip_seed_ranking_evolve',
  },
  {
    id: 'V6-NETWORK-004.6',
    argv: ['protheusctl', 'network', 'join', 'hyperspace', '--apply=1'],
    expectedType: 'p2p_gossip_seed_join',
  },
  {
    id: 'V6-COGNITION-012.1',
    argv: ['protheusctl', 'skills', 'enable', 'perplexity-mode', '--apply=1'],
    expectedType: 'assimilation_controller_skills_enable',
  },
  {
    id: 'V6-COGNITION-012.2',
    argv: ['protheusctl', 'skill', 'create', '--task=triage github issues'],
    expectedType: 'assimilation_controller_skill_create',
  },
  {
    id: 'V6-COGNITION-012.3',
    argv: [
      'protheusctl',
      'skills',
      'spawn-subagents',
      '--task=triage backlog',
      '--roles=researcher,executor,reviewer',
    ],
    expectedType: 'assimilation_controller_skills_spawn_subagents',
  },
  {
    id: 'V6-COGNITION-012.4',
    argv: [
      'protheusctl',
      'skills',
      'computer-use',
      '--action=collect screenshot',
      '--target=dashboard',
      '--apply=1',
    ],
    expectedType: 'assimilation_controller_skills_computer_use',
  },
  {
    id: 'V6-COGNITION-012.5',
    argv: ['protheusctl', 'skills', 'dashboard'],
    expectedType: 'assimilation_controller_skills_dashboard',
  },
  {
    id: 'V6-COCKPIT-026.1',
    argv: ['protheusctl', 'chat', 'nano', '--q=teach me nanochat', '--top=3'],
    expectedType: 'nano_chat_mode',
  },
  {
    id: 'V6-COCKPIT-026.2',
    argv: ['protheusctl', 'train', 'nano', '--depth=12', '--profile=edu'],
    expectedType: 'nano_train_mode',
  },
  {
    id: 'V6-COCKPIT-026.3',
    argv: ['protheusctl', 'nano', 'fork', '--target=.nanochat/fork-harness'],
    expectedType: 'nano_fork_mode',
  },
  {
    id: 'V6-COCKPIT-026.4',
    argv: ['protheusctl', 'chat', 'nano', '--q=boundary check', '--top=2'],
    expectedType: 'nano_chat_mode',
  },
  {
    id: 'V6-MEMORY-011.1',
    argv: ['protheusctl', 'memory', 'taxonomy'],
    expectedType: 'memory_taxonomy_4w',
  },
  {
    id: 'V6-MEMORY-011.2',
    argv: ['protheusctl', 'memory', 'enable', 'metacognitive'],
    expectedType: 'memory_metacognitive_enable',
  },
  {
    id: 'V6-MEMORY-011.3',
    argv: ['protheusctl', 'memory', 'share', '--scope=task', '--target=shadow-a', '--consent=true'],
    expectedType: 'memory_share',
  },
  {
    id: 'V6-MEMORY-011.4',
    argv: ['protheusctl', 'memory', 'evolve', '--generation=2'],
    expectedType: 'memory_evolve',
  },
  {
    id: 'V6-MEMORY-011.5',
    argv: ['protheusctl', 'memory', 'taxonomy'],
    expectedType: 'memory_taxonomy_4w',
  },
  {
    id: 'V6-MEMORY-012.1',
    argv: ['protheusctl', 'memory', 'enable', 'causality'],
    expectedType: 'memory_causality_enable',
  },
  {
    id: 'V6-MEMORY-012.2',
    argv: ['protheusctl', 'memory', 'causal-retrieve', '--q=event', '--depth=2'],
    expectedType: 'memory_causal_retrieve',
  },
  {
    id: 'V6-MEMORY-012.3',
    argv: ['protheusctl', 'memory', 'benchmark', 'ama'],
    expectedType: 'memory_benchmark_ama',
  },
  {
    id: 'V6-MEMORY-012.4',
    argv: ['protheusctl', 'memory', 'fuse'],
    expectedType: 'memory_fuse',
  },
  {
    id: 'V6-MEMORY-012.5',
    argv: ['protheusctl', 'memory', 'enable', 'causality'],
    expectedType: 'memory_causality_enable',
  },
];

function parseJsonPayload(raw) {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // fall back to line scanning for mixed-output commands
  }
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {
      // continue
    }
  }
  return null;
}

function collectTypes(node, out) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectTypes(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  if (typeof node.type === 'string' && node.type) out.add(node.type);
  for (const value of Object.values(node)) collectTypes(value, out);
}

function collectReceiptHashes(node, out) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const item of node) collectReceiptHashes(item, out);
    return;
  }
  if (typeof node !== 'object') return;
  if (typeof node.receipt_hash === 'string' && node.receipt_hash) out.add(node.receipt_hash);
  for (const value of Object.values(node)) collectReceiptHashes(value, out);
}

function ensureBinary() {
  if (existsSync(BIN)) return;
  execFileSync('cargo', ['build', '-q', '-p', 'protheus-ops-core', '--bin', 'protheus-ops'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
}

function runCheck(check) {
  const startedAt = new Date().toISOString();
  try {
    const raw = execFileSync(BIN, check.argv, {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024 * 32,
    });
    const payload = parseJsonPayload(raw);
    if (!payload || typeof payload !== 'object') {
      return {
        ...check,
        ok: false,
        startedAt,
        finishedAt: new Date().toISOString(),
        error: 'json_payload_not_found',
      };
    }
    const allTypes = new Set();
    collectTypes(payload, allTypes);
    const hashes = new Set();
    collectReceiptHashes(payload, hashes);
    const ok = allTypes.has(check.expectedType);
    return {
      ...check,
      ok,
      startedAt,
      finishedAt: new Date().toISOString(),
      observedTypes: [...allTypes].sort(),
      observedReceiptHashes: [...hashes].sort(),
      payload,
      error: ok ? null : `expected_type_missing:${check.expectedType}`,
    };
  } catch (error) {
    const stdout = String(error?.stdout ?? '');
    const stderr = String(error?.stderr ?? '');
    const payload = parseJsonPayload(stdout) ?? parseJsonPayload(stderr);
    const allTypes = new Set();
    collectTypes(payload, allTypes);
    const hashes = new Set();
    collectReceiptHashes(payload, hashes);
    const ok = payload && allTypes.has(check.expectedType);
    return {
      ...check,
      ok,
      startedAt,
      finishedAt: new Date().toISOString(),
      observedTypes: [...allTypes].sort(),
      observedReceiptHashes: [...hashes].sort(),
      payload,
      error: ok
        ? null
        : `command_failed:${error?.status ?? 'unknown'}:${error?.message ?? 'unknown_error'}`,
    };
  }
}

function writeReports(results, summary) {
  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(
    OUT_JSON,
    `${JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary,
        results: results.map((r) => ({
          id: r.id,
          ok: r.ok,
          expectedType: r.expectedType,
          observedTypes: r.observedTypes ?? [],
          observedReceiptHashes: r.observedReceiptHashes ?? [],
          argv: r.argv,
          error: r.error,
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
        })),
      },
      null,
      2,
    )}\n`,
  );

  const lines = [];
  lines.push('# SRS Contract Receipts (2026-03-12 Intake)');
  lines.push('');
  lines.push(`- Total checks: **${summary.total}**`);
  lines.push(`- Passed: **${summary.passed}**`);
  lines.push(`- Failed: **${summary.failed}**`);
  lines.push(`- Report JSON: \`${OUT_JSON}\``);
  lines.push('');
  lines.push('| ID | Result | Expected Type | Observed Types | Receipt Hash Count |');
  lines.push('|---|---|---|---|---:|');
  for (const r of results) {
    lines.push(
      `| ${r.id} | ${r.ok ? 'PASS' : 'FAIL'} | ${r.expectedType} | ${(r.observedTypes ?? []).join(', ')} | ${(r.observedReceiptHashes ?? []).length} |`,
    );
  }
  lines.push('');
  if (summary.failed > 0) {
    lines.push('## Failures');
    lines.push('');
    for (const r of results.filter((row) => !row.ok)) {
      lines.push(`- \`${r.id}\`: ${r.error ?? 'unknown_error'}`);
    }
  }
  mkdirSync(dirname(OUT_MD), { recursive: true });
  writeFileSync(OUT_MD, `${lines.join('\n')}\n`);
}

function main() {
  ensureBinary();
  const results = checks.map(runCheck);
  const summary = {
    total: results.length,
    passed: results.filter((row) => row.ok).length,
    failed: results.filter((row) => !row.ok).length,
  };
  writeReports(results, summary);
  console.log(
    JSON.stringify(
      {
        ok: summary.failed === 0,
        type: 'srs_contract_receipts_20260312',
        out_json: OUT_JSON,
        out_markdown: OUT_MD,
        summary,
      },
      null,
      2,
    ),
  );
  if (summary.failed > 0) process.exit(1);
}

main();
