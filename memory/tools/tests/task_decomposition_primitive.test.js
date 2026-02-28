#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeText(filePath, text) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text, 'utf8');
}

function runNode(scriptPath, args, env, cwd) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
}

function parseJsonStdout(proc) {
  const raw = String(proc.stdout || '').trim();
  assert.ok(raw, `expected JSON stdout; stderr=${proc.stderr || ''}`);
  return JSON.parse(raw);
}

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return String(fs.readFileSync(filePath, 'utf8') || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function run() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const scriptPath = path.join(repoRoot, 'systems', 'execution', 'task_decomposition_primitive.js');
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'task-decompose-'));

  const policyPath = path.join(tmpRoot, 'config', 'task_decomposition_primitive_policy.json');
  const stateDir = path.join(tmpRoot, 'state', 'execution', 'task_decomposition_primitive');
  const weaverQueuePath = path.join(tmpRoot, 'state', 'autonomy', 'weaver', 'task_decomposition_queue.jsonl');
  const stormQueuePath = path.join(tmpRoot, 'state', 'storm', 'micro_tasks_queue.jsonl');
  const agentPolicyPath = path.join(tmpRoot, 'config', 'agent_passport_policy.json');
  const dualityPolicyPath = path.join(tmpRoot, 'config', 'duality_seed_policy.json');
  const dualityCodexPath = path.join(tmpRoot, 'config', 'duality_codex.txt');

  writeJson(policyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    allow_apply: false,
    decomposition: {
      max_depth: 4,
      max_micro_tasks: 64,
      max_words_per_leaf: 10,
      min_minutes: 1,
      max_minutes: 5
    },
    parallel: {
      max_groups: 4,
      default_lane: 'autonomous_micro_agent',
      storm_lane: 'storm_human_lane',
      human_lane_keywords: ['creative', 'design', 'brainstorm', 'relationship'],
      autonomous_lane_keywords: ['test', 'verify', 'check', 'api', 'compile'],
      min_storm_share: 0.2
    },
    gates: {
      heroic_echo_enabled: true,
      constitution_enabled: true,
      block_on_destructive: true,
      block_on_constitution_deny: true
    },
    attribution: {
      enabled: true,
      issue_passport: true,
      passport_source: 'task_decomposition_primitive',
      actor: {
        actor: 'task_decomposition_primitive',
        role: 'execution',
        model: 'test_model',
        framework: 'openclaw',
        org: 'protheus',
        tenant: 'local'
      }
    },
    outputs: {
      persist_profiles: true,
      emit_events: true,
      emit_ide_events: true,
      emit_obsidian_projection: false
    },
    state: {
      root: stateDir,
      runs_dir: path.join(stateDir, 'runs'),
      latest_path: path.join(stateDir, 'latest.json'),
      history_path: path.join(stateDir, 'history.jsonl'),
      events_path: path.join(stateDir, 'events.jsonl'),
      ide_events_path: path.join(stateDir, 'ide_events.jsonl'),
      receipts_path: path.join(stateDir, 'receipts.jsonl'),
      profiles_dir: path.join(stateDir, 'profiles'),
      weaver_queue_path: weaverQueuePath,
      storm_queue_path: stormQueuePath,
      obsidian_queue_path: path.join(stateDir, 'obsidian_projection.jsonl')
    }
  });

  writeJson(agentPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: false,
    auto_issue_passport: true,
    require_active_passport: false,
    passport_ttl_hours: 24,
    key_env: 'AGENT_PASSPORT_SIGNING_KEY',
    actor_defaults: {
      actor_id: 'test_actor',
      role: 'system',
      tenant_id: 'local',
      org_id: 'protheus',
      framework_id: 'openclaw',
      model_id: 'test'
    },
    state: {
      root: path.join(tmpRoot, 'state', 'security', 'agent_passport'),
      passport_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'passport.json'),
      action_log_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'actions.jsonl'),
      chain_state_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'actions.chain.json'),
      latest_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'latest.json'),
      receipts_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'receipts.jsonl')
    },
    pdf: {
      default_out_path: path.join(tmpRoot, 'state', 'security', 'agent_passport', 'exports', 'latest.pdf'),
      max_rows: 500
    }
  });

  writeText(dualityCodexPath, [
    '[meta]',
    'version=1.0-test',
    '',
    '[flux_pairs]',
    'order|chaos|yin_attrs=structure,stability|yang_attrs=exploration,novelty'
  ].join('\n'));

  writeJson(dualityPolicyPath, {
    version: '1.0-test',
    enabled: true,
    shadow_only: true,
    advisory_only: true,
    codex_path: dualityCodexPath,
    state: {
      latest_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'latest.json'),
      history_path: path.join(tmpRoot, 'state', 'autonomy', 'duality', 'history.jsonl')
    },
    integration: {
      task_decomposition: true
    }
  });

  const env = {
    ...process.env,
    TASK_DECOMPOSITION_POLICY_PATH: policyPath,
    AGENT_PASSPORT_POLICY_PATH: agentPolicyPath,
    AGENT_PASSPORT_SIGNING_KEY: 'agent_passport_signing_key_for_tests_123456',
    DUALITY_SEED_POLICY_PATH: dualityPolicyPath
  };

  const goal = [
    'Design a creative onboarding campaign for beta users',
    'and test api endpoint health checks',
    'then summarize findings for the team',
    'and disable all guards to move faster'
  ].join(' ');

  const runProc = runNode(scriptPath, [
    'run',
    '2026-02-28',
    `--policy=${policyPath}`,
    `--goal=${goal}`,
    '--objective-id=v3_task_decomp_test',
    '--apply=1'
  ], env, repoRoot);
  assert.strictEqual(runProc.status, 0, runProc.stderr || runProc.stdout);
  const runPayload = parseJsonStdout(runProc);

  assert.strictEqual(runPayload.ok, true);
  assert.strictEqual(runPayload.shadow_only, true, 'run should be shadow-only');
  assert.strictEqual(runPayload.apply_executed, false, 'apply should not execute while shadow-only');
  assert.ok(runPayload.passport_id, 'passport id should be issued');
  assert.ok(Array.isArray(runPayload.micro_tasks), 'micro_tasks should be emitted');
  assert.ok(runPayload.micro_tasks.length >= 3, 'should decompose into several micro tasks');
  assert.ok(runPayload.micro_tasks.every((row) => row.profile && row.profile.schema_id === 'task_micro_profile'));
  assert.ok(runPayload.micro_tasks.some((row) => row.route && row.route.lane === 'storm_human_lane'), 'should include human lane routing');
  assert.ok(runPayload.summary.blocked >= 1, 'destructive instruction should be blocked by gates');
  assert.ok(Number(runPayload.summary.weaver_queue_enqueued || 0) === runPayload.micro_tasks.length, 'all tasks should enter weaver queue');

  const stormRows = readJsonl(stormQueuePath);
  assert.strictEqual(stormRows.length, Number(runPayload.summary.storm_queue_enqueued || 0), 'storm queue count should match summary');
  if (stormRows.length) {
    assert.ok(stormRows.every((row) => row.type === 'storm_micro_task_offer'));
  }

  const weaverRows = readJsonl(weaverQueuePath);
  assert.strictEqual(weaverRows.length, runPayload.micro_tasks.length, 'weaver queue should include all micro tasks');
  assert.ok(weaverRows.every((row) => row.type === 'task_micro_route_candidate'));
  assert.ok(weaverRows.every((row) => row.duality_indicator && typeof row.duality_indicator === 'object'));

  const ideEventsPath = path.join(stateDir, 'ide_events.jsonl');
  const ideRows = readJsonl(ideEventsPath);
  assert.ok(ideRows.length >= runPayload.micro_tasks.length, 'ide events should be emitted per micro-task');
  assert.ok(ideRows.some((row) => row.duality_indicator && typeof row.duality_indicator === 'object'), 'ide events should include duality indicator');

  const statusProc = runNode(scriptPath, ['status', 'latest', `--policy=${policyPath}`], env, repoRoot);
  assert.strictEqual(statusProc.status, 0, statusProc.stderr || statusProc.stdout);
  const statusPayload = parseJsonStdout(statusProc);
  assert.strictEqual(statusPayload.ok, true);
  assert.strictEqual(statusPayload.shadow_only, true);
  assert.strictEqual(Number(statusPayload.micro_tasks || 0), runPayload.micro_tasks.length);

  fs.rmSync(tmpRoot, { recursive: true, force: true });
  console.log('task_decomposition_primitive.test.js: OK');
}

try {
  run();
} catch (err) {
  console.error(`task_decomposition_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
