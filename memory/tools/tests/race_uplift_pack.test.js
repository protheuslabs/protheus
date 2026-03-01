#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');

function run(scriptRel, args) {
  const script = path.join(ROOT, scriptRel);
  const r = spawnSync('node', [script, ...args], { cwd: ROOT, encoding: 'utf8' });
  let payload = null;
  try { payload = JSON.parse(String(r.stdout || '').trim()); } catch {}
  return { status: Number.isFinite(r.status) ? r.status : 1, payload, stderr: String(r.stderr || '') };
}

try {
  const checks = [
    ['systems/security/wasm_capability_microkernel.js', ['run', '--module=test']],
    ['systems/ops/event_sourced_control_plane.js', ['append', '--stream=control', '--event=mutation']],
    ['systems/routing/model_catalog_service.js', ['upsert', '--provider=local', '--model=qwen', '--latency_ms=120', '--cost_per_1k=0.01', '--quality=0.9', '--reliability=0.9']],
    ['systems/observability/thought_action_trace_contract.js', ['append', '--stage=intent', '--outcome=ok']],
    ['systems/autonomy/swarm_orchestration_runtime.js', ['run', '--objective=test', '--team_size=3', '--consensus=1']],
    ['systems/memory/cross_cell_exchange_plane.js', ['exchange', '--from=a', '--to=master', '--payload={}']],
    ['systems/symbiosis/soul_vector_substrate.js', ['refresh']],
    ['systems/memory/hybrid_memory_engine.js', ['ingest', '--objective=global', '--content=hello']],
    ['systems/assimilation/habit_adapter_finetune_lane.js', ['train', '--habit=h1', '--objective=o1', '--uplift=0.1']],
    ['systems/ops/observability_deployment_defaults.js', ['generate']],
    ['systems/ops/compatibility_conformance_program.js', ['run', '--integration=test']]
  ];

  for (const [scriptRel, args] of checks) {
    const res = run(scriptRel, args);
    assert.strictEqual(res.status, 0, `${scriptRel} failed: ${res.stderr}`);
    assert.ok(res.payload && res.payload.ok !== false, `${scriptRel} returned non-ok payload`);
  }

  console.log('race_uplift_pack.test.js: OK');
} catch (err) {
  console.error(`race_uplift_pack.test.js: FAIL: ${err.message}`);
  process.exit(1);
}
