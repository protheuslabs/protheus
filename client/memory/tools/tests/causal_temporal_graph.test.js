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

function appendJsonl(filePath, rows) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = rows.map((row) => JSON.stringify(row)).join('\n');
  fs.writeFileSync(filePath, `${body}\n`, 'utf8');
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

function run(script, root, args, env) {
  const r = spawnSync(process.execPath, [script, ...args], {
    cwd: root,
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
  const script = path.join(repoRoot, 'systems', 'memory', 'causal_temporal_graph.js');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'causal-temporal-'));

  const policyPath = path.join(tmp, 'config', 'causal_temporal_memory_policy.json');
  const eventsDir = path.join(tmp, 'state', 'runtime', 'canonical_events');
  const statePath = path.join(tmp, 'state', 'memory', 'causal_temporal_graph', 'state.json');

  writeJson(policyPath, {
    schema_id: 'causal_temporal_memory_policy',
    schema_version: '1.0',
    enabled: true,
    strict_requires_events: true,
    allow_counterfactual_query: true,
    max_events: 100,
    default_query_depth: 4,
    max_query_depth: 8,
    canonical_events_path: eventsDir,
    state_path: statePath,
    latest_query_path: path.join(tmp, 'state', 'memory', 'causal_temporal_graph', 'latest_query.json'),
    receipts_path: path.join(tmp, 'state', 'memory', 'causal_temporal_graph', 'receipts.jsonl')
  });

  appendJsonl(path.join(eventsDir, '2026-02-27.jsonl'), [
    {
      schema_id: 'canonical_runtime_event',
      schema_version: '1.0',
      ts: '2026-02-27T10:00:00.000Z',
      date: '2026-02-27',
      seq: 1,
      event_id: 'evt_root',
      prev_hash: null,
      type: 'workflow_start',
      run_id: 'run_1',
      workflow_id: 'wf_1',
      payload: {}
    },
    {
      schema_id: 'canonical_runtime_event',
      schema_version: '1.0',
      ts: '2026-02-27T10:00:01.000Z',
      date: '2026-02-27',
      seq: 2,
      event_id: 'evt_mid',
      prev_hash: 'hash_1',
      type: 'step_execute',
      run_id: 'run_1',
      workflow_id: 'wf_1',
      payload: {
        parent_event_id: 'evt_root'
      }
    },
    {
      schema_id: 'canonical_runtime_event',
      schema_version: '1.0',
      ts: '2026-02-27T10:00:02.000Z',
      date: '2026-02-27',
      seq: 3,
      event_id: 'evt_leaf',
      prev_hash: 'hash_2',
      type: 'step_execute',
      run_id: 'run_1',
      workflow_id: 'wf_1',
      payload: {
        depends_on_event_ids: ['evt_mid']
      }
    }
  ]);

  const env = {
    ...process.env,
    CAUSAL_TEMPORAL_GRAPH_ROOT: tmp,
    CAUSAL_TEMPORAL_GRAPH_POLICY_PATH: policyPath
  };

  const build = run(script, repoRoot, ['build', '--strict=1', `--policy=${policyPath}`], env);
  assert.strictEqual(build.status, 0, build.stderr || 'build should pass in strict mode');
  assert.ok(build.payload && build.payload.ok === true, 'build payload should be ok');
  assert.strictEqual(Number(build.payload.event_count || 0), 3, 'event count should equal canonical rows');
  assert.ok(Number(build.payload.edge_count || 0) >= 2, 'edge count should be populated');
  assert.ok(fs.existsSync(statePath), 'graph state should be written');

  const why = run(script, repoRoot, ['query', '--mode=why', '--event-id=evt_leaf', `--policy=${policyPath}`], env);
  assert.strictEqual(why.status, 0, why.stderr || 'why query should pass');
  assert.ok(why.payload && why.payload.ok === true, 'why payload should be ok');
  const whyIds = new Set((why.payload.canonical_event_ids || []).map((v) => String(v)));
  assert.ok(whyIds.has('evt_mid'), 'why query should include causal parent event');

  const whatIf = run(script, repoRoot, ['query', '--mode=what-if', '--event-id=evt_root', '--assume-ok=0', `--policy=${policyPath}`], env);
  assert.strictEqual(whatIf.status, 0, whatIf.stderr || 'what-if query should pass');
  assert.ok(whatIf.payload && whatIf.payload.ok === true, 'what-if payload should be ok');
  const impacted = new Set((whatIf.payload.impacted || []).map((row) => String(row.event_id || '')));
  assert.ok(impacted.has('evt_mid'), 'what-if should include downstream event evt_mid');
  assert.ok(impacted.has('evt_leaf'), 'what-if should include downstream event evt_leaf');

  const status = run(script, repoRoot, ['status', `--policy=${policyPath}`], env);
  assert.strictEqual(status.status, 0, status.stderr || 'status should pass');
  assert.ok(status.payload && status.payload.ok === true, 'status payload should be ok');
  assert.strictEqual(Number(status.payload.graph_summary.event_count || 0), 3, 'status should reflect event count');

  console.log('causal_temporal_graph.test.js: OK');
}

try {
  main();
} catch (err) {
  console.error(`causal_temporal_graph.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
