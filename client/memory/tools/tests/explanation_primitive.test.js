#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function write(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
}

function writeJson(filePath, value) {
  write(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function parseJson(stdout) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(script, cwd, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd,
    env,
    encoding: 'utf8'
  });
  return {
    status: Number(r.status || 0),
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(r.stdout)
  };
}

function main() {
  const repoRoot = path.resolve(__dirname, '..', '..', '..');
  const script = path.join(repoRoot, 'systems', 'primitives', 'explanation_primitive.js');
  const canonicalModulePath = path.join(repoRoot, 'systems', 'primitives', 'canonical_event_log.js');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'explanation-primitive-'));
  const policyPath = path.join(tmp, 'config', 'explanation_primitive_policy.json');
  const passportPolicyPath = path.join(tmp, 'config', 'agent_passport_policy.json');
  const canonicalDir = path.join(tmp, 'state', 'runtime', 'canonical_events');

  process.env.CANONICAL_EVENT_LOG_DIR = canonicalDir;
  const { appendCanonicalEvent } = require(canonicalModulePath);
  appendCanonicalEvent({
    event_id: 'evt_root',
    type: 'workflow_start',
    payload: { objective_id: 'obj_demo' }
  });
  appendCanonicalEvent({
    event_id: 'evt_decide',
    type: 'policy_decision',
    payload: { objective_id: 'obj_demo', parent_event_id: 'evt_root', decision: 'deny' }
  });

  writeJson(path.join(tmp, 'state', 'memory', 'causal_temporal_graph', 'state.json'), {
    schema_id: 'causal_temporal_graph_state',
    schema_version: '1.0',
    edges: [
      { source_event_id: 'evt_root', target_event_id: 'evt_decide', relation: 'declared_parent', weight: 1 }
    ]
  });

  writeJson(passportPolicyPath, {
    version: '1.0',
    enabled: true,
    shadow_only: false,
    auto_link_from_receipts: true,
    auto_issue_passport: true,
    passport_ttl_hours: 168,
    key_env: 'AGENT_PASSPORT_SIGNING_KEY',
    actor_defaults: {
      actor_id: 'test_operator',
      role: 'system',
      tenant_id: 'local',
      org_id: 'protheus',
      framework_id: 'openclaw',
      model_id: 'test_model'
    },
    state: {
      root: path.join(tmp, 'state', 'security', 'agent_passport'),
      passport_path: path.join(tmp, 'state', 'security', 'agent_passport', 'passport.json'),
      action_log_path: path.join(tmp, 'state', 'security', 'agent_passport', 'actions.jsonl'),
      chain_state_path: path.join(tmp, 'state', 'security', 'agent_passport', 'actions.chain.json'),
      latest_path: path.join(tmp, 'state', 'security', 'agent_passport', 'latest.json'),
      receipts_path: path.join(tmp, 'state', 'security', 'agent_passport', 'receipts.jsonl')
    },
    pdf: {
      default_out_path: path.join(tmp, 'state', 'security', 'agent_passport', 'exports', 'latest_passport.pdf'),
      max_rows: 2000
    }
  });

  writeJson(policyPath, {
    schema_id: 'explanation_primitive_policy',
    schema_version: '1.0',
    enabled: true,
    shadow_only: false,
    require_event_id: true,
    require_proof_links: true,
    require_event_replayable: true,
    allow_latest_pointer: true,
    passport_export: {
      enabled: true,
      source: 'explanation_test'
    },
    paths: {
      canonical_events: canonicalDir,
      causal_graph_state: path.join(tmp, 'state', 'memory', 'causal_temporal_graph', 'state.json'),
      index_path: path.join(tmp, 'state', 'primitives', 'explanation_primitive', 'index.json'),
      latest_path: path.join(tmp, 'state', 'primitives', 'explanation_primitive', 'latest.json'),
      artifacts_dir: path.join(tmp, 'state', 'primitives', 'explanation_primitive', 'artifacts'),
      receipts_path: path.join(tmp, 'state', 'primitives', 'explanation_primitive', 'receipts.jsonl')
    }
  });

  const env = {
    ...process.env,
    EXPLANATION_PRIMITIVE_ROOT: tmp,
    EXPLANATION_PRIMITIVE_POLICY_PATH: policyPath,
    AGENT_PASSPORT_POLICY_PATH: passportPolicyPath,
    AGENT_PASSPORT_SIGNING_KEY: 'agent_passport_signing_key_for_test_123456'
  };

  const explain = run(script, repoRoot, [
    'explain',
    '--event-id=evt_decide',
    '--category=policy_denial',
    '--decision=deny',
    '--objective-id=obj_demo',
    '--summary=Denied external action due to policy gate.',
    '--narrative=Policy root denied this request because confidence was below threshold.',
    '--proof-link=https://example.test/policy-reason',
    `--policy=${policyPath}`
  ], env);

  assert.strictEqual(explain.status, 0, explain.stderr || 'explain command should pass');
  assert.ok(explain.payload && explain.payload.ok === true, 'explain payload should be ok');
  const explanationId = String(explain.payload.explanation_id || '');
  assert.ok(explanationId.startsWith('exp_'), 'explanation id should be generated');

  const artifactPath = path.join(tmp, explain.payload.artifact_path);
  assert.ok(fs.existsSync(artifactPath), 'artifact file should exist');
  const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
  assert.strictEqual(String(artifact.event_ref && artifact.event_ref.event_id || ''), 'evt_decide', 'artifact should bind to event');
  assert.ok(Array.isArray(artifact.proof_links) && artifact.proof_links.length >= 3, 'artifact should include proof links');

  const verify = run(script, repoRoot, ['verify', `--explanation-id=${explanationId}`, '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(verify.status, 0, verify.stderr || 'verify command should pass');
  assert.ok(verify.payload && verify.payload.ok === true, 'verify payload should be ok');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.ok(Number(status.payload.counts && status.payload.counts.artifact_files || 0) >= 1, 'status should report artifacts');

  const passportActionsPath = path.join(tmp, 'state', 'security', 'agent_passport', 'actions.jsonl');
  const actionRows = fs.existsSync(passportActionsPath)
    ? fs.readFileSync(passportActionsPath, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line))
    : [];
  assert.ok(actionRows.some((row) => String(row && row.action && row.action.action_type || '') === 'explanation_artifact'), 'passport should include explanation action');

  console.log('explanation_primitive.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`explanation_primitive.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
