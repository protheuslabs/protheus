#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { runGraphWorkflow } = require(path.join(ROOT, 'systems', 'graph', 'index.js'));

function fail(msg) {
  console.error(`❌ graph_phase6_rust_parity.test.js: ${msg}`);
  process.exit(1);
}

function parseJson(stdout) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function ensureReleaseBinary() {
  const out = spawnSync('cargo', ['build', '--manifest-path', 'core/layer0/graph/Cargo.toml', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 300)}`);
  }
}

function runDirect(yamlJson) {
  const encoded = Buffer.from(String(yamlJson || '{}'), 'utf8').toString('base64');
  const out = spawnSync('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    'core/layer0/graph/Cargo.toml',
    '--bin',
    'graph_core',
    '--',
    'run',
    `--yaml-base64=${encoded}`
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  if (Number(out.status) !== 0) {
    return {
      ok: false,
      error: String(out.stderr || out.stdout || '').slice(0, 260)
    };
  }
  const payload = parseJson(out.stdout);
  return payload && typeof payload === 'object'
    ? { ok: true, payload }
    : { ok: false, error: 'direct_parse_failed' };
}

function normalize(payload) {
  const warnings = Array.isArray(payload && payload.warnings) ? payload.warnings.slice() : [];
  return {
    workflow_id: String(payload && payload.workflow_id || ''),
    ordered_nodes: Array.isArray(payload && payload.ordered_nodes) ? payload.ordered_nodes.slice() : [],
    step_count: Number(payload && payload.step_count || 0),
    cyclic: Boolean(payload && payload.cyclic),
    policy_id: String(payload && payload.policy_id || ''),
    digest: String(payload && payload.digest || ''),
    warnings
  };
}

function seeded(seed) {
  let x = (seed >>> 0) ^ 0x9e3779b9;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return (x >>> 0) / 0xffffffff;
  };
}

function buildCase(seed) {
  const rnd = seeded(seed + 101);
  const nodeCount = 3 + Math.floor(rnd() * 6);
  const nodes = Array.from({ length: nodeCount }, (_, idx) => ({
    id: `n_${seed}_${idx}`,
    kind: idx % 2 === 0 ? 'task' : 'decision'
  }));
  const edges = [];
  for (let i = 1; i < nodeCount; i += 1) {
    edges.push({ from: nodes[i - 1].id, to: nodes[i].id });
  }
  if (rnd() > 0.55 && nodeCount > 3) {
    edges.push({ from: nodes[nodeCount - 1].id, to: nodes[1].id });
  }

  return {
    workflow_id: `wf_${seed}`,
    nodes,
    edges
  };
}

function main() {
  ensureReleaseBinary();

  const fixedCases = [
    {
      workflow_id: 'fixed_linear',
      nodes: [
        { id: 'collect', kind: 'task' },
        { id: 'score', kind: 'task' },
        { id: 'ship', kind: 'task' }
      ],
      edges: [
        { from: 'collect', to: 'score' },
        { from: 'score', to: 'ship' }
      ]
    },
    {
      workflow_id: 'fixed_cycle',
      nodes: [
        { id: 'a', kind: 'task' },
        { id: 'b', kind: 'task' },
        { id: 'c', kind: 'task' }
      ],
      edges: [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'c', to: 'a' }
      ]
    }
  ];

  const generated = Array.from({ length: 30 }, (_, idx) => buildCase(idx + 1));
  const allCases = fixedCases.concat(generated);

  for (const workflow of allCases) {
    const yamlJson = JSON.stringify(workflow);
    const wrapper = runGraphWorkflow(yamlJson, { allow_cli_fallback: true });
    if (!wrapper || wrapper.ok !== true || !wrapper.payload || typeof wrapper.payload !== 'object') {
      fail(`wrapper run failed for ${workflow.workflow_id}: ${JSON.stringify(wrapper || {})}`);
    }

    const direct = runDirect(yamlJson);
    if (!direct.ok || !direct.payload) {
      fail(`direct run failed for ${workflow.workflow_id}: ${JSON.stringify(direct || {})}`);
    }

    const normalizedWrapper = normalize(wrapper.payload);
    const normalizedDirect = normalize(direct.payload);
    assert.deepStrictEqual(normalizedWrapper, normalizedDirect, `parity mismatch for ${workflow.workflow_id}`);

    const repeat = runGraphWorkflow(yamlJson, { allow_cli_fallback: true });
    assert.ok(repeat && repeat.ok === true && repeat.payload, `repeat wrapper failed for ${workflow.workflow_id}`);
    assert.deepStrictEqual(normalize(repeat.payload), normalizedWrapper, `determinism mismatch for ${workflow.workflow_id}`);
  }

  console.log('graph_phase6_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
