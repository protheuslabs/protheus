import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const policyValidator = require(path.join(ROOT, 'client/runtime/systems/memory/policy_validator.ts'));

describe('V6-TEST-COVERAGE-001 v6 memory policy validator client guards', () => {
  test('enforces V6-MEMORY-013..019 reject paths and valid lensmap', () => {
    const v013 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--path=local/workspace/memory/2026-03-15.md',
    ]);
    expect(v013.ok).toBe(false);
    expect(v013.reason_code).toBe('direct_file_read_forbidden');

    const v014 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--bootstrap=1',
      '--lazy-hydration=0',
    ]);
    expect(v014.ok).toBe(false);
    expect(v014.reason_code).toBe('bootstrap_requires_lazy_hydration');

    const v015 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--burn-threshold=250',
    ]);
    expect(v015.ok).toBe(false);
    expect(v015.reason_code).toBe('burn_slo_threshold_exceeded');

    const v016 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--top=999',
    ]);
    expect(v016.ok).toBe(false);
    expect(v016.reason_code).toBe('recall_budget_exceeded');

    const v017 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--scores-json=[0.7,0.9]',
      '--ids-json=["b","a"]',
    ]);
    expect(v017.ok).toBe(false);
    expect(v017.reason_code).toBe('ranking_not_descending');

    const v018 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--allow-stale=1',
    ]);
    expect(v018.ok).toBe(false);
    expect(v018.reason_code).toBe('stale_override_forbidden');

    const v019Fail = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--lensmap-annotation-json={"node_id":"n1","tags":[],"jots":[]}',
    ]);
    expect(v019Fail.ok).toBe(false);
    expect(v019Fail.reason_code).toBe('lensmap_annotation_missing_tags_or_jots');

    const v019Pass = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--lensmap-annotation-json={"node_id":"n1","tags":["memory"],"jots":["note"]}',
    ]);
    expect(v019Pass.ok).toBe(true);
    expect(v019Pass.reason_code).toBe('policy_ok');
  });

  test('blocks index bypass attempts before rust core path', () => {
    const result = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=s-vitest',
      '--bypass=1',
    ]);
    expect(result.ok).toBe(false);
    expect(result.reason_code).toBe('index_first_bypass_forbidden');

    const guard = policyValidator.guardFailureResult(result, { stage: 'client_preflight' });
    expect(guard.ok).toBe(false);
    expect(guard.status).toBe(2);
    expect(String(guard.stderr)).toContain('memory_policy_guard_reject:index_first_bypass_forbidden');
  });
});
