import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();

describe('churn commit gate wiring', () => {
  test('pre-commit hook enforces churn commit gate', () => {
    const hookPath = path.join(ROOT, '.githooks/pre-commit');
    const hook = fs.readFileSync(hookPath, 'utf8');
    expect(hook.includes('ops:churn:commit-gate')).toBe(true);
  });

  test('package scripts expose churn commit gate command', () => {
    const packageJsonPath = path.join(ROOT, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    const cmd = String(pkg?.scripts?.['ops:churn:commit-gate'] || '');
    expect(cmd).toContain('churn_guard.mjs');
    expect(cmd).toContain('--commit-gate=1');
    expect(cmd).toContain('--strict=1');
  });
});
