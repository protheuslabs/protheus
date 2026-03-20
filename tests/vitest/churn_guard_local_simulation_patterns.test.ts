import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, test } from 'vitest';

const ROOT = process.cwd();
const GUARD_PATH = path.join(ROOT, 'tests/tooling/scripts/ci/churn_guard.mjs');
const tempDirs: string[] = [];

function createFixtureRepo(): string {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'churn-guard-local-'));
  execSync('git init -q', { cwd: repoRoot });
  execSync('git config user.email "codex@example.com"', { cwd: repoRoot });
  execSync('git config user.name "Codex"', { cwd: repoRoot });
  fs.writeFileSync(path.join(repoRoot, 'README.md'), '# fixture\n');
  execSync('git add README.md', { cwd: repoRoot });
  execSync('git commit -qm "fixture"', { cwd: repoRoot });
  return repoRoot;
}

function runGuard(repoRoot: string, args: string[] = []) {
  return spawnSync(process.execPath, [GUARD_PATH, ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const repoRoot = tempDirs.pop();
    if (repoRoot) {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  }
});

describe('local simulation churn patterns', () => {
  test('fails on root-level swarm scratch files and codex worktrees', () => {
    const repoRoot = createFixtureRepo();
    tempDirs.push(repoRoot);

    fs.writeFileSync(path.join(repoRoot, 'cell-worker.swarm'), 'scratch\n');
    fs.writeFileSync(path.join(repoRoot, 'swarm_master.py'), 'print("scratch")\n');
    fs.mkdirSync(path.join(repoRoot, '.codex_worktrees', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, '.codex_worktrees', 'tmp', 'note.txt'), 'nested\n');

    const result = runGuard(repoRoot, ['--strict=1']);
    expect(result.status).toBe(1);

    const payload = JSON.parse(result.stderr);
    expect(payload.summary.local_simulation_churn).toBe(3);
    expect(payload.summary.other).toBe(0);
  });

  test('classifies benchmark report artifacts as generated report churn', () => {
    const repoRoot = createFixtureRepo();
    tempDirs.push(repoRoot);

    const reportPath = path.join(
      repoRoot,
      'docs',
      'client',
      'reports',
      'benchmark_matrix_run_2026-03-06.json',
    );
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, '{"run":"current"}\n');
    execSync('git add .', { cwd: repoRoot });
    execSync('git commit -qm "seed report"', { cwd: repoRoot });

    fs.writeFileSync(reportPath, '{"run":"drift"}\n');
    fs.writeFileSync(
      path.join(repoRoot, 'docs', 'client', 'reports', 'benchmark_matrix_resample_2026-03-19.json'),
      '{"resample":"noise"}\n',
    );

    const result = runGuard(repoRoot, ['--strict=1']);
    expect(result.status).toBe(1);

    const payload = JSON.parse(result.stderr);
    expect(payload.summary.generated_report_churn).toBe(2);
    expect(payload.summary.other).toBe(0);
  });
});
