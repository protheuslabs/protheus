#!/usr/bin/env node
'use strict';

const assert = require('assert');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const { runSwarm } = require(path.join(ROOT, 'systems', 'swarm', 'index.js'));

function fail(msg) {
  console.error(`❌ swarm_phase7_rust_parity.test.js: ${msg}`);
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
  const out = spawnSync('cargo', ['build', '--manifest-path', 'core/layer0/swarm/Cargo.toml', '--release'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (Number(out.status) !== 0) {
    fail(`cargo build failed: ${(out.stderr || out.stdout || '').slice(0, 300)}`);
  }
}

function runDirect(requestJson) {
  const encoded = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');
  const out = spawnSync('cargo', [
    'run',
    '--quiet',
    '--manifest-path',
    'core/layer0/swarm/Cargo.toml',
    '--bin',
    'swarm_core',
    '--',
    'run',
    `--request-base64=${encoded}`
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

function round3(v) {
  return Math.round(Number(v || 0) * 1000) / 1000;
}

function normalize(payload) {
  const assignments = Array.isArray(payload && payload.assignments) ? payload.assignments.slice() : [];
  assignments.sort((a, b) => String(a.task_id || '').localeCompare(String(b.task_id || '')));
  return {
    swarm_id: String(payload && payload.swarm_id || ''),
    assignments: assignments.map((row) => ({
      task_id: String(row.task_id || ''),
      agent_id: String(row.agent_id || ''),
      score: round3(row.score)
    })),
    unassigned_tasks: Array.isArray(payload && payload.unassigned_tasks) ? payload.unassigned_tasks.slice().sort() : [],
    consensus_pct: round3(payload && payload.consensus_pct),
    sovereignty_index_pct: round3(payload && payload.sovereignty_index_pct),
    profile_id: String(payload && payload.profile_id || ''),
    digest: String(payload && payload.digest || '')
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
  const rnd = seeded(seed + 211);
  const skillPool = ['coding', 'research', 'ops', 'security', 'design'];
  const agentCount = 2 + Math.floor(rnd() * 4);
  const taskCount = 2 + Math.floor(rnd() * 6);

  const agents = Array.from({ length: agentCount }, (_, idx) => {
    const skills = [];
    for (let s = 0; s < skillPool.length; s += 1) {
      if (rnd() > 0.45) skills.push(skillPool[s]);
    }
    if (skills.length === 0) skills.push(skillPool[idx % skillPool.length]);
    return {
      id: `agent_${seed}_${idx}`,
      skills,
      capacity: 1 + Math.floor(rnd() * 4),
      reliability_pct: 70 + Math.floor(rnd() * 30)
    };
  });

  const tasks = Array.from({ length: taskCount }, (_, idx) => ({
    id: `task_${seed}_${idx}`,
    required_skill: skillPool[Math.floor(rnd() * skillPool.length)],
    weight: 1 + Math.floor(rnd() * 3),
    priority: 1 + Math.floor(rnd() * 9)
  }));

  return {
    swarm_id: `swarm_${seed}`,
    mode: rnd() > 0.5 ? 'deterministic' : 'balanced',
    agents,
    tasks
  };
}

function main() {
  ensureReleaseBinary();

  const fixedCases = [
    {
      swarm_id: 'fixed_swarm',
      mode: 'deterministic',
      agents: [
        { id: 'a1', skills: ['coding', 'research'], capacity: 3, reliability_pct: 91 },
        { id: 'a2', skills: ['coding'], capacity: 2, reliability_pct: 86 }
      ],
      tasks: [
        { id: 't1', required_skill: 'coding', weight: 2, priority: 8 },
        { id: 't2', required_skill: 'research', weight: 1, priority: 6 }
      ]
    },
    {
      swarm_id: 'fixed_unassigned',
      mode: 'deterministic',
      agents: [
        { id: 'a1', skills: ['ops'], capacity: 1, reliability_pct: 90 }
      ],
      tasks: [
        { id: 't1', required_skill: 'security', weight: 1, priority: 9 },
        { id: 't2', required_skill: 'ops', weight: 1, priority: 3 }
      ]
    }
  ];

  const generated = Array.from({ length: 28 }, (_, idx) => buildCase(idx + 1));
  const allCases = fixedCases.concat(generated);

  for (const request of allCases) {
    const requestJson = JSON.stringify(request);
    const wrapper = runSwarm(requestJson, { allow_cli_fallback: true });
    if (!wrapper || wrapper.ok !== true || !wrapper.payload || typeof wrapper.payload !== 'object') {
      fail(`wrapper run failed for ${request.swarm_id}: ${JSON.stringify(wrapper || {})}`);
    }

    const direct = runDirect(requestJson);
    if (!direct.ok || !direct.payload) {
      fail(`direct run failed for ${request.swarm_id}: ${JSON.stringify(direct || {})}`);
    }

    const normalizedWrapper = normalize(wrapper.payload);
    const normalizedDirect = normalize(direct.payload);
    assert.deepStrictEqual(normalizedWrapper, normalizedDirect, `parity mismatch for ${request.swarm_id}`);

    const repeat = runSwarm(requestJson, { allow_cli_fallback: true });
    assert.ok(repeat && repeat.ok === true && repeat.payload, `repeat wrapper failed for ${request.swarm_id}`);
    assert.deepStrictEqual(normalize(repeat.payload), normalizedWrapper, `determinism mismatch for ${request.swarm_id}`);
  }

  console.log('swarm_phase7_rust_parity.test.js: OK');
}

try {
  main();
} catch (err) {
  fail(err && err.message ? err.message : String(err));
}
