#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const SCRIPT = path.join(ROOT, 'client', 'runtime', 'systems', 'ops', 'top50_roi_sweep.ts');
const QUEUE_JSON = path.join(ROOT, 'docs', 'client', 'generated', 'RUST60_EXECUTION_QUEUE_261.json');

function parseLastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

const proc = spawnSync('node', [SCRIPT, '--max=20'], {
  cwd: ROOT,
  encoding: 'utf8',
});

assert.strictEqual(proc.status, 0, proc.stderr || proc.stdout);
const payload = parseLastJson(proc.stdout);
assert(payload, 'expected JSON payload');
assert.strictEqual(payload.ok, true);
assert.strictEqual(payload.type, 'top50_roi_sweep');
assert(fs.existsSync(QUEUE_JSON), 'expected refreshed queue json');
const queue = JSON.parse(fs.readFileSync(QUEUE_JSON, 'utf8'));
assert(queue.current_rust_percent >= 60, 'expected current rust percent to reflect live repo state');
assert.strictEqual(queue.rust_percent, queue.current_rust_percent, 'expected compatibility rust_percent alias');
assert(queue.bridge_wrappers_excluded > 0, 'expected bridge wrappers to be excluded');
assert(queue.extension_surfaces_excluded > 0, 'expected skill/app extension surfaces to be excluded');
assert(Array.isArray(queue.queue), 'expected compatibility queue alias');
assert(Array.isArray(queue.top_candidates), 'expected compatibility top_candidates alias');
assert.strictEqual(queue.queue.length, queue.lanes.length, 'expected queue alias to mirror lanes');
assert.strictEqual(queue.top_candidates.length, queue.top.length, 'expected top_candidates alias to mirror top');
assert(queue.top.every((lane) => fs.existsSync(path.join(ROOT, lane.path))), 'expected queue paths to exist');
assert(queue.top.every((lane) => !lane.path.endsWith('gated_self_improvement_loop.ts')), 'expected thin bridge wrappers excluded');
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/systems/autonomy/swarm_orchestration_runtime.ts'),
  'expected thin swarm bridge wrapper to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/systems/autonomy/swarm_repl_demo.ts'),
  'expected thin demo shells to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'adapters/cognition/skills/moltbook/moltbook_api.ts'),
  'expected flexible skill surface to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'adapters/cognition/skills/mcp/mcp_gateway.ts'),
  'expected skill gateway surface to be excluded from live queue'
);
assert(
  queue.top.every((lane) => !lane.path.startsWith('apps/')),
  'expected app shells to be excluded from live queue unless explicitly authoritative'
);
assert(
  queue.top.every((lane) => !lane.path.startsWith('packages/')),
  'expected package entrypoints to be excluded from live queue unless explicitly authoritative'
);
assert(
  queue.top.every((lane) => !lane.path.startsWith('adapters/importers/')),
  'expected importer adapter surfaces to be excluded from live queue unless explicitly authoritative'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/lib/test_compactor_benchmark.ts'),
  'expected benchmark harness surfaces to be excluded from live queue unless explicitly authoritative'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/patches/websocket-client-patch.ts'),
  'expected runtime patch surfaces to be excluded from live queue unless explicitly authoritative'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/lib/moltbook_api.ts'),
  'expected external API client surface to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/lib/tool_compactor_integration.ts'),
  'expected tool compactor integration wrapper to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/lib/command_output_compactor.ts'),
  'expected command output compactor wrapper to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/lib/eyes_catalog.ts'),
  'expected eyes catalog user-flex wrapper to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/lib/ts_entrypoint.ts'),
  'expected ts entrypoint bootstrap surface to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/runtime/systems/ops/f100_readiness_remediation.ts'),
  'expected thin remediation wrapper to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/cognition/orchestration/scratchpad.ts'),
  'expected thin cognition scratchpad wrapper to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/cognition/orchestration/taskgroup.ts'),
  'expected thin cognition taskgroup wrapper to be excluded from live queue'
);
assert(
  queue.top.every((lane) => !lane.path.startsWith('client/cognition/')),
  'expected cognition flex surfaces to be excluded from live queue'
);
assert(
  queue.top.every((lane) => !lane.path.startsWith('client/cli/bin/')),
  'expected CLI bin wrappers to be excluded from live queue'
);
assert(
  queue.top.every((lane) => !lane.path.startsWith('client/runtime/platform/')),
  'expected platform API wrappers to be excluded from live queue'
);
assert(
  queue.top.every((lane) => !lane.path.startsWith('adapters/cognition/collectors/')),
  'expected collector adapter surfaces to be excluded from live queue'
);
assert(
  queue.top.every((lane) => !lane.path.startsWith('adapters/cognition/skills/')),
  'expected skill script surfaces to be excluded from live queue'
);
assert(
  queue.top.every((lane) => lane.path !== 'client/lib/ts_entrypoint.ts'),
  'expected legacy ts entrypoint alias to be excluded from live queue'
);
console.log('top50_roi_sweep_runner.test.js: OK');
