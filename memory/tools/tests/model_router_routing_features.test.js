#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { spawnSync } = require('child_process');

function mkDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, obj) {
  mkDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
}

function writeJsonl(filePath, rows) {
  mkDir(path.dirname(filePath));
  const body = (rows || []).map((r) => JSON.stringify(r)).join('\n');
  fs.writeFileSync(filePath, body + (body ? '\n' : ''), 'utf8');
}

function writeHealthSnapshot(stateDir, records) {
  const now = Date.now();
  const host = {};
  for (const [model, rec] of Object.entries(records || {})) {
    host[model] = {
      model,
      available: true,
      follows_instructions: true,
      latency_ms: 1200,
      checked_ms: now,
      ...(rec || {})
    };
  }
  writeJson(path.join(stateDir, 'model_health.json'), {
    schema_version: 2,
    updated_at: new Date(now).toISOString(),
    active_runtime: 'host',
    runtimes: { host },
    records: host
  });
}

function runEval(repoRoot, code, env) {
  return spawnSync('node', ['-e', code], {
    cwd: repoRoot,
    encoding: 'utf8',
    env
  });
}

function makeEnv(base, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, budgetDate) {
  return {
    ...process.env,
    ...base,
    ROUTER_RUNTIME_SCOPE: 'host',
    ROUTER_CONFIG_PATH: cfgPath,
    ROUTER_MODE_ADAPTERS_PATH: adaptersPath,
    ROUTER_STATE_DIR: stateDir,
    ROUTER_AUTONOMY_RUNS_DIR: runsDir,
    ROUTER_BUDGET_DIR: budgetDir,
    ROUTER_BUDGET_TODAY: budgetDate,
    ROUTER_PROBE_TTL_MS: '3600000'
  };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function runCaseFastPath(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  mkDir(runsDir);
  mkDir(budgetDir);

  writeJson(cfgPath, {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: ['ollama/smallthinker', 'ollama/kimi-k2.5:cloud'],
      model_profiles: {
        'ollama/smallthinker': { tiers: [1], roles: ['chat', 'general'], class: 'cheap_local' },
        'ollama/kimi-k2.5:cloud': { tiers: [2, 3], roles: ['chat', 'general'], class: 'cloud_anchor' }
      },
      communication_fast_path: {
        enabled: true,
        match_mode: 'heuristic',
        max_chars: 32,
        max_words: 4,
        max_newlines: 0,
        disallow_regexes: ['https?:\\/\\/', '\\b(node|git|npm)\\b'],
        slot: 'grunt',
        prefer_model: 'ollama/smallthinker',
        fallback_slot: 'fallback',
        skip_outcome_scan: true
      },
      router_budget_policy: { enabled: false },
      slot_selection: [
        {
          when: { risk: 'low', complexity: ['low', 'medium'] },
          use_slot: 'grunt',
          prefer_model: 'ollama/kimi-k2.5:cloud',
          fallback_slot: 'fallback'
        }
      ],
      local_probe_policy: {
        default: { timeout_ms: 8000, max_latency_ms: 8000, accept_ok_token: true }
      }
    }
  });
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true, follows_instructions: true, latency_ms: 900 }
  });

  const env = makeEnv({}, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, todayStr());
  const r = runEval(repoRoot, `
    const router = require('./systems/routing/model_router.js');
    const d = router.routeDecision({ risk: 'low', complexity: 'low', intent: 'ok', task: 'ok', mode: 'normal' });
    process.stdout.write(JSON.stringify(d));
  `, env);
  assert.strictEqual(r.status, 0, `fast-path eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.fast_path && out.fast_path.matched, true, 'fast path should match for short low-structure chat');
  assert.strictEqual(out.selected_model, 'ollama/smallthinker', 'fast path should prefer cheap local model');
  assert.strictEqual(out.slot, 'grunt', 'fast path should pin grunt slot');
}

function runCaseOutcomeContext(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  mkDir(runsDir);
  mkDir(budgetDir);

  writeJson(cfgPath, {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: ['ollama/smallthinker', 'ollama/qwen3:4b'],
      model_profiles: {
        'ollama/smallthinker': { tiers: [1, 2], roles: ['general'], class: 'cheap_local' },
        'ollama/qwen3:4b': { tiers: [1, 2], roles: ['general'], class: 'cheap_local' }
      },
      communication_fast_path: { enabled: false },
      router_budget_policy: { enabled: false },
      slot_selection: [
        {
          when: { risk: 'medium', complexity: ['low', 'medium'] },
          use_slot: 'agent',
          fallback_slot: 'master'
        }
      ],
      local_probe_policy: {
        default: { timeout_ms: 8000, max_latency_ms: 8000, accept_ok_token: true }
      }
    }
  });
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true, follows_instructions: true, latency_ms: 1100 },
    'ollama/qwen3:4b': { available: true, follows_instructions: true, latency_ms: 1150 }
  });

  const day = todayStr();
  const runFile = path.join(runsDir, `${day}.jsonl`);
  const rows = [];
  for (let i = 0; i < 8; i++) {
    rows.push({
      ts: `${day}T05:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      capability_key: 'proposal:other',
      route_summary: { selected_model: 'ollama/smallthinker', route_role: 'planning' },
      verification: { passed: true },
      outcome: 'shipped'
    });
    rows.push({
      ts: `${day}T06:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      capability_key: 'proposal:other',
      route_summary: { selected_model: 'ollama/qwen3:4b', route_role: 'planning' },
      verification: { passed: false },
      outcome: 'no_change'
    });
  }
  for (let i = 0; i < 4; i++) {
    rows.push({
      ts: `${day}T07:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      capability_key: 'proposal:collector_remediation',
      route_summary: { selected_model: 'ollama/smallthinker', route_role: 'planning' },
      verification: { passed: false },
      outcome: 'no_change'
    });
    rows.push({
      ts: `${day}T08:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      capability_key: 'proposal:collector_remediation',
      route_summary: { selected_model: 'ollama/qwen3:4b', route_role: 'planning' },
      verification: { passed: true },
      outcome: 'shipped'
    });
  }
  writeJsonl(runFile, rows);

  const env = makeEnv({}, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, day);
  const r = runEval(repoRoot, `
    const router = require('./systems/routing/model_router.js');
    const target = router.routeDecision({
      risk: 'medium',
      complexity: 'medium',
      intent: 'plan remediation',
      task: 'plan remediation approach',
      capability: 'proposal:collector_remediation',
      mode: 'normal'
    });
    const other = router.routeDecision({
      risk: 'medium',
      complexity: 'medium',
      intent: 'plan other task',
      task: 'plan backlog review',
      capability: 'proposal:other',
      mode: 'normal'
    });
    process.stdout.write(JSON.stringify({ target, other }));
  `, env);
  assert.strictEqual(r.status, 0, `outcome-context eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.target.selected_model, 'ollama/qwen3:4b', 'capability-specific success should lift qwen for remediation capability');
  assert.strictEqual(out.other.selected_model, 'ollama/smallthinker', 'capability-specific success should keep smallthinker for other capability');
}

function runCaseTaskTypeOutcomeContext(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  mkDir(runsDir);
  mkDir(budgetDir);

  writeJson(cfgPath, {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: ['ollama/smallthinker', 'ollama/qwen3:4b'],
      model_profiles: {
        'ollama/smallthinker': { tiers: [1, 2], roles: ['general'], class: 'cheap_local' },
        'ollama/qwen3:4b': { tiers: [1, 2], roles: ['general'], class: 'cheap_local' }
      },
      communication_fast_path: { enabled: false },
      router_budget_policy: { enabled: false },
      slot_selection: [
        {
          when: { risk: 'medium', complexity: ['low', 'medium'] },
          use_slot: 'agent',
          fallback_slot: 'master'
        }
      ],
      local_probe_policy: {
        default: { timeout_ms: 8000, max_latency_ms: 8000, accept_ok_token: true }
      }
    }
  });
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true, follows_instructions: true, latency_ms: 1100 },
    'ollama/qwen3:4b': { available: true, follows_instructions: true, latency_ms: 1100 }
  });

  const day = todayStr();
  const runFile = path.join(runsDir, `${day}.jsonl`);
  const rows = [];
  for (let i = 0; i < 6; i++) {
    rows.push({
      ts: `${day}T09:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      execution_target: 'route',
      proposal_type: 'external_intel',
      capability_key: 'proposal:external_intel',
      route_summary: { selected_model: 'ollama/smallthinker', route_role: 'general', route_class: 'default' },
      verification: { passed: true },
      outcome: 'shipped'
    });
    rows.push({
      ts: `${day}T10:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      execution_target: 'route',
      proposal_type: 'external_intel',
      capability_key: 'proposal:external_intel',
      route_summary: { selected_model: 'ollama/qwen3:4b', route_role: 'general', route_class: 'default' },
      verification: { passed: false },
      outcome: 'no_change'
    });
  }
  for (let i = 0; i < 6; i++) {
    rows.push({
      ts: `${day}T11:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      execution_target: 'route',
      proposal_type: 'external_intel',
      capability_key: 'proposal:external_intel',
      route_summary: { selected_model: 'ollama/smallthinker', route_role: 'general', route_class: 'focus' },
      verification: { passed: false },
      outcome: 'no_change'
    });
    rows.push({
      ts: `${day}T12:${String(i).padStart(2, '0')}:00.000Z`,
      type: 'autonomy_run',
      result: 'executed',
      execution_target: 'route',
      proposal_type: 'external_intel',
      capability_key: 'proposal:external_intel',
      route_summary: { selected_model: 'ollama/qwen3:4b', route_role: 'general', route_class: 'focus' },
      verification: { passed: true },
      outcome: 'shipped'
    });
  }
  writeJsonl(runFile, rows);

  const env = makeEnv({}, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, day);
  const r = runEval(repoRoot, `
    const router = require('./systems/routing/model_router.js');
    const focus = router.routeDecision({
      risk: 'medium',
      complexity: 'medium',
      intent: 'analyze external intel',
      task: 'analyze external intel',
      capability: 'proposal:external_intel',
      routeClass: 'focus',
      mode: 'normal'
    });
    const base = router.routeDecision({
      risk: 'medium',
      complexity: 'medium',
      intent: 'analyze external intel',
      task: 'analyze external intel',
      capability: 'proposal:external_intel',
      routeClass: 'default',
      mode: 'normal'
    });
    process.stdout.write(JSON.stringify({ focus, base }));
  `, env);
  assert.strictEqual(r.status, 0, `task-type outcome eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.focus.task_type, 'class:focus', 'route class should produce deterministic task_type');
  assert.strictEqual(out.base.task_type, 'cap:proposal_external_intel', 'default route should derive capability-family task_type');
  assert.strictEqual(out.focus.selected_model, 'ollama/qwen3:4b', 'task-type success should lift qwen for focus tasks');
  assert.strictEqual(out.base.selected_model, 'ollama/smallthinker', 'default task-type should keep smallthinker');
}

function runCaseBudgetPressure(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  mkDir(runsDir);
  mkDir(budgetDir);

  const day = todayStr();
  writeJson(path.join(budgetDir, `${day}.json`), {
    date: day,
    token_cap: 100,
    used_est: 95
  });

  writeJson(cfgPath, {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: ['ollama/smallthinker', 'ollama/kimi-k2.5:cloud'],
      model_profiles: {
        'ollama/smallthinker': { tiers: [1, 2], roles: ['chat', 'general'], class: 'cheap_local' },
        'ollama/kimi-k2.5:cloud': { tiers: [2, 3], roles: ['chat', 'general'], class: 'cloud_anchor' }
      },
      communication_fast_path: { enabled: false },
      router_budget_policy: {
        enabled: true,
        allow_strategy_override: false,
        state_dir: budgetDir,
        soft_ratio: 0.5,
        hard_ratio: 0.8,
        cloud_penalty_soft: 6,
        cloud_penalty_hard: 25,
        cheap_local_bonus_soft: 2,
        cheap_local_bonus_hard: 8
      },
      slot_selection: [
        {
          when: { risk: 'medium', complexity: ['medium', 'high'] },
          use_slot: 'agent',
          prefer_model: 'ollama/kimi-k2.5:cloud',
          fallback_slot: 'master'
        }
      ],
      local_probe_policy: {
        default: { timeout_ms: 8000, max_latency_ms: 8000, accept_ok_token: true }
      }
    }
  });
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true, follows_instructions: true, latency_ms: 1300 }
  });

  const env = makeEnv({ SYSTEM_BUDGET_DEFAULT_DAILY_TOKEN_CAP: '100' }, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, day);
  const r = runEval(repoRoot, `
    const router = require('./systems/routing/model_router.js');
    const d = router.routeDecision({
      risk: 'medium',
      complexity: 'medium',
      intent: 'summarize status',
      task: 'summarize this weekly status update',
      mode: 'normal'
    });
    process.stdout.write(JSON.stringify(d));
  `, env);
  assert.strictEqual(r.status, 0, `budget-pressure eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.budget && out.budget.pressure, 'hard', 'budget state should detect hard pressure');
  assert.strictEqual(out.selected_model, 'ollama/smallthinker', 'hard budget pressure should downgrade from cloud to cheap local');
}

function runCaseProjectedBudgetFromRequest(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  mkDir(runsDir);
  mkDir(budgetDir);

  const day = todayStr();
  writeJson(path.join(budgetDir, `${day}.json`), {
    date: day,
    token_cap: 1000,
    used_est: 500
  });

  writeJson(cfgPath, {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: ['ollama/smallthinker', 'ollama/kimi-k2.5:cloud'],
      model_profiles: {
        'ollama/smallthinker': { tiers: [2], roles: ['chat', 'general'], class: 'cheap_local' },
        'ollama/kimi-k2.5:cloud': { tiers: [2], roles: ['chat', 'general'], class: 'cloud_anchor' }
      },
      communication_fast_path: { enabled: false },
      router_budget_policy: {
        enabled: true,
        allow_strategy_override: false,
        state_dir: budgetDir,
        soft_ratio: 0.75,
        hard_ratio: 0.9,
        cloud_penalty_soft: 4,
        cloud_penalty_hard: 25,
        cheap_local_bonus_soft: 2,
        cheap_local_bonus_hard: 8
      },
      slot_selection: [
        {
          when: { risk: 'medium', complexity: ['medium', 'high'] },
          use_slot: 'agent',
          prefer_model: 'ollama/kimi-k2.5:cloud',
          fallback_slot: 'master'
        }
      ],
      local_probe_policy: {
        default: { timeout_ms: 8000, max_latency_ms: 8000, accept_ok_token: true }
      }
    }
  });
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true, follows_instructions: true, latency_ms: 1300 }
  });

  const env = makeEnv({ SYSTEM_BUDGET_DEFAULT_DAILY_TOKEN_CAP: '1000' }, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, day);
  const r = runEval(repoRoot, `
    const router = require('./systems/routing/model_router.js');
    const d = router.routeDecision({
      risk: 'medium',
      complexity: 'medium',
      intent: 'summarize status',
      task: 'summarize this weekly status update',
      mode: 'normal',
      tokensEst: 500
    });
    process.stdout.write(JSON.stringify(d));
  `, env);
  assert.strictEqual(r.status, 0, `projected-budget eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.budget && out.budget.pressure, 'none', 'current budget pressure should be none before projection');
  assert.strictEqual(out.budget && out.budget.projected_pressure, 'hard', 'projected budget pressure should be hard after request estimate');
  assert.strictEqual(out.selected_model, 'ollama/smallthinker', 'projected hard pressure should downgrade to cheap local');
  assert.strictEqual(
    Number(out.cost_estimate && out.cost_estimate.request_tokens_est || 0),
    500,
    'decision should expose request token estimate used for projected budget'
  );
}

function runCaseFallbackClassification(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  mkDir(runsDir);
  mkDir(budgetDir);

  writeJson(cfgPath, {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: ['ollama/smallthinker', 'ollama/kimi-k2.5:cloud'],
      model_profiles: {
        'ollama/smallthinker': { tiers: [1], roles: ['chat', 'general'], class: 'cheap_local' },
        'ollama/kimi-k2.5:cloud': { tiers: [2, 3], roles: ['chat', 'general'], class: 'cloud_anchor' }
      },
      communication_fast_path: {
        enabled: true,
        match_mode: 'heuristic',
        max_chars: 48,
        max_words: 8,
        max_newlines: 0,
        disallow_regexes: ['https?:\\/\\/', '\\b(node|git|npm)\\b']
      },
      fallback_classification_policy: {
        enabled: true,
        only_when_medium_medium: true,
        prefer_chat_fast_path: true
      },
      router_budget_policy: { enabled: false },
      slot_selection: [
        {
          when: { risk: 'low', complexity: ['low', 'medium'] },
          use_slot: 'grunt',
          prefer_model: 'ollama/smallthinker',
          fallback_slot: 'fallback'
        },
        {
          when: { risk: 'medium', complexity: ['medium', 'high'] },
          use_slot: 'agent',
          prefer_model: 'ollama/kimi-k2.5:cloud',
          fallback_slot: 'master'
        }
      ],
      local_probe_policy: {
        default: { timeout_ms: 8000, max_latency_ms: 8000, accept_ok_token: true }
      }
    }
  });
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true, follows_instructions: true, latency_ms: 900 }
  });

  const env = makeEnv({}, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, todayStr());
  const r = runEval(repoRoot, `
    const router = require('./systems/routing/model_router.js');
    const d = router.routeDecision({
      risk: 'medium',
      complexity: 'medium',
      intent: 'status',
      task: 'quick status',
      mode: 'normal'
    });
    process.stdout.write(JSON.stringify(d));
  `, env);
  assert.strictEqual(r.status, 0, `fallback-classification eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.classification && out.classification.fallback_applied, true, 'generic medium/medium should apply fallback classification');
  assert.strictEqual(out.risk, 'low', 'fallback classification should lower risk to low for short generic prompts');
  assert.strictEqual(out.complexity, 'low', 'fallback classification should lower complexity to low for short generic prompts');
}

function runCaseEyesSignalInfluence(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  const eyesRegistryPath = path.join(root, 'state', 'sensory', 'eyes', 'registry.json');
  mkDir(runsDir);
  mkDir(budgetDir);

  writeJson(cfgPath, {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: ['ollama/smallthinker', 'ollama/kimi-k2.5:cloud'],
      model_profiles: {
        'ollama/smallthinker': { tiers: [1, 2], roles: ['planning', 'general'], class: 'cheap_local' },
        'ollama/kimi-k2.5:cloud': { tiers: [2, 3], roles: ['planning', 'general'], class: 'cloud_anchor' }
      },
      communication_fast_path: { enabled: false },
      fallback_classification_policy: { enabled: false },
      eyes_signal_policy: {
        enabled: true,
        registry_path: eyesRegistryPath,
        min_non_stub_eyes: 2,
        degraded_fail_ratio: 0.5,
        degraded_error_rate: 0.4,
        local_bonus_degraded: 16,
        cloud_penalty_degraded: 8
      },
      router_budget_policy: { enabled: false },
      slot_selection: [
        {
          when: { risk: 'medium', complexity: ['medium', 'high'] },
          use_slot: 'agent',
          prefer_model: 'ollama/kimi-k2.5:cloud',
          fallback_slot: 'master'
        }
      ],
      local_probe_policy: {
        default: { timeout_ms: 8000, max_latency_ms: 8000, accept_ok_token: true }
      }
    }
  });
  writeJson(adaptersPath, { mode_routing: {} });
  writeHealthSnapshot(stateDir, {
    'ollama/smallthinker': { available: true, follows_instructions: true, latency_ms: 1200 }
  });
  writeJson(eyesRegistryPath, {
    eyes: [
      { id: 'hn_frontpage', parser_type: 'hn_rss', error_rate: 0.85, consecutive_failures: 2, status: 'probation', score_ema: 40 },
      { id: 'moltbook_feed', parser_type: 'moltbook_hot', error_rate: 0.7, consecutive_failures: 3, status: 'failing', score_ema: 35 }
    ]
  });

  const env = makeEnv({}, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, todayStr());
  const r = runEval(repoRoot, `
    const router = require('./systems/routing/model_router.js');
    const d = router.routeDecision({
      risk: 'medium',
      complexity: 'medium',
      intent: 'plan remediation',
      task: 'plan remediation flow',
      mode: 'normal'
    });
    process.stdout.write(JSON.stringify(d));
  `, env);
  assert.strictEqual(r.status, 0, `eyes-signal eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.eyes_signal && out.eyes_signal.network_degraded, true, 'eyes signal should detect degraded sensory network');
  assert.strictEqual(out.selected_model, 'ollama/smallthinker', 'degraded sensory network should bias to local fallback model');
}

function runCasePromptCacheInfluence(repoRoot, root) {
  const cfgPath = path.join(root, 'config', 'agent_routing_rules.json');
  const adaptersPath = path.join(root, 'config', 'model_adapters.json');
  const stateDir = path.join(root, 'state', 'routing');
  const runsDir = path.join(root, 'state', 'autonomy', 'runs');
  const budgetDir = path.join(root, 'state', 'autonomy', 'daily_budget');
  const cacheIndexPath = path.join(stateDir, 'prompt_cache_index.json');
  mkDir(runsDir);
  mkDir(budgetDir);

  writeJson(cfgPath, {
    version: 1,
    routing: {
      default_anchor_model: 'ollama/kimi-k2.5:cloud',
      spawn_model_allowlist: ['qwen3-coder:480b-cloud', 'ollama/kimi-k2.5:cloud'],
      model_profiles: {
        'qwen3-coder:480b-cloud': { tiers: [2, 3], roles: ['planning', 'general'], class: 'cloud_specialist' },
        'ollama/kimi-k2.5:cloud': { tiers: [2, 3], roles: ['planning', 'general'], class: 'cloud_anchor' }
      },
      communication_fast_path: { enabled: false },
      fallback_classification_policy: { enabled: false },
      prompt_cache_policy: {
        enabled: true,
        index_path: cacheIndexPath,
        window_minutes: 180,
        min_hits: 2,
        cache_friendly_bonus: 14,
        cloud_anchor_extra_bonus: 4,
        non_friendly_cloud_penalty: 6,
        eligible_classes: ['cloud_anchor'],
        cache_friendly_models: ['ollama/kimi-k2.5:cloud']
      },
      router_budget_policy: { enabled: false },
      slot_selection: [
        {
          when: { risk: 'medium', complexity: ['medium', 'high'] },
          use_slot: 'agent',
          prefer_model: 'qwen3-coder:480b-cloud',
          fallback_slot: 'master'
        }
      ]
    }
  });
  writeJson(adaptersPath, { mode_routing: {} });

  const env = makeEnv({}, cfgPath, adaptersPath, stateDir, runsDir, budgetDir, todayStr());
  const r = runEval(repoRoot, `
    const router = require('./systems/routing/model_router.js');
    const base = {
      risk: 'medium',
      complexity: 'medium',
      intent: 'plan integration rollout',
      task: 'plan integration rollout for router improvements',
      mode: 'normal'
    };
    router.routeDecision(base);
    router.routeDecision(base);
    const third = router.routeDecision(base);
    process.stdout.write(JSON.stringify(third));
  `, env);
  assert.strictEqual(r.status, 0, `prompt-cache eval failed: ${r.stderr}`);
  const out = JSON.parse(String(r.stdout || '{}'));
  assert.strictEqual(out.prompt_cache && out.prompt_cache.eligible, true, 'third repeated prompt should become cache eligible');
  assert.strictEqual(out.selected_model, 'ollama/kimi-k2.5:cloud', 'cache-friendly anchor model should win once cache signal becomes eligible');
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const tmpRoot = path.join(__dirname, 'temp_model_router_routing_features');
  if (fs.existsSync(tmpRoot)) fs.rmSync(tmpRoot, { recursive: true, force: true });
  mkDir(tmpRoot);

  runCaseFastPath(repoRoot, path.join(tmpRoot, 'fast_path'));
  runCaseOutcomeContext(repoRoot, path.join(tmpRoot, 'outcome_context'));
  runCaseTaskTypeOutcomeContext(repoRoot, path.join(tmpRoot, 'task_type_outcome_context'));
  runCaseBudgetPressure(repoRoot, path.join(tmpRoot, 'budget_pressure'));
  runCaseProjectedBudgetFromRequest(repoRoot, path.join(tmpRoot, 'projected_budget'));
  runCaseFallbackClassification(repoRoot, path.join(tmpRoot, 'fallback_classification'));
  runCaseEyesSignalInfluence(repoRoot, path.join(tmpRoot, 'eyes_signal_influence'));
  runCasePromptCacheInfluence(repoRoot, path.join(tmpRoot, 'prompt_cache_influence'));

  console.log('model_router_routing_features.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`model_router_routing_features.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
