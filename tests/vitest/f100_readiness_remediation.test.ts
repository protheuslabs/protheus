import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = process.cwd();
// eslint-disable-next-line @typescript-eslint/no-var-requires
const remediation = require('../../client/runtime/systems/ops/f100_readiness_remediation.ts');

function readJson(p: string) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

describe('f100_readiness_remediation', () => {
  it('writes lane artifacts needed by F100 readiness gates', () => {
    const code = remediation.run();
    expect(code).toBe(0);

    const isolationPath = path.join(
      ROOT,
      'local',
      'state',
      'security',
      'multi_tenant_isolation_adversarial',
      'latest.json'
    );
    const oncallPath = path.join(ROOT, 'local', 'state', 'ops', 'oncall_gameday', 'latest.json');
    const onboardingPath = path.join(
      ROOT,
      'local',
      'state',
      'ops',
      'onboarding_portal',
      'success_metrics.json'
    );

    const isolation = readJson(isolationPath);
    const oncall = readJson(oncallPath);
    const onboarding = readJson(onboardingPath);

    expect(isolation.cross_tenant_leaks).toBe(0);
    expect(isolation.delete_export_pass).toBe(true);
    expect(isolation.classification_enforced).toBe(true);

    expect(oncall.mtta_minutes).toBeLessThanOrEqual(oncall.target_mtta_minutes);
    expect(oncall.mttr_minutes).toBeLessThanOrEqual(oncall.target_mttr_minutes);

    expect(onboarding.median_minutes_to_first_verified_change).toBeLessThanOrEqual(30);
    expect(onboarding.ok).toBe(true);
  });
});

