#!/usr/bin/env node

// TypeScript compatibility shim only.
// Layer ownership: core/layer0/ops + core/layer1/policy (authoritative)

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const THIS_FILE = fileURLToPath(import.meta.url);
const THIS_DIR = path.dirname(THIS_FILE);
const WORKSPACE_ROOT = path.resolve(THIS_DIR, '..', '..', '..', '..');
const GUARD_SCRIPT = path.resolve(WORKSPACE_ROOT, 'tests/tooling/scripts/ci/dependency_boundary_guard.mjs');

export function run(argv = []) {
  const args = Array.isArray(argv) ? argv.map((v) => String(v)) : [];
  const res = spawnSync(process.execPath, [GUARD_SCRIPT, ...args], {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
  });
  if (typeof res.status === 'number' && res.status !== 0) {
    process.exit(res.status);
  }
  if (res.error) throw res.error;
  return { ok: true, delegated_to: 'tests/tooling/scripts/ci/dependency_boundary_guard.mjs' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === THIS_FILE) {
  run(process.argv.slice(2));
}
