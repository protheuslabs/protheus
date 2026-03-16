import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';

const ROOT = process.cwd();
const require = createRequire(import.meta.url);
const BRIDGE_PATH = path.join(ROOT, 'client/runtime/lib/rust_lane_bridge.ts');
const MODULE_PATH = path.join(ROOT, 'client/runtime/systems/memory/memory_efficiency_plane.ts');

type BridgeResult = {
  ok: boolean;
  status: number;
  stdout: string;
  stderr: string;
  payload: Record<string, unknown>;
};

function withBridgeStub(stubRun: () => BridgeResult, testFn: (moduleRef: any) => void) {
  const bridgeModule = require(BRIDGE_PATH);
  const originalCreateOpsLaneBridge = bridgeModule.createOpsLaneBridge;
  const originalCreateManifestLaneBridge = bridgeModule.createManifestLaneBridge;

  bridgeModule.createOpsLaneBridge = function createOpsLaneBridgeStub() {
    return {
      lane: 'memory-guard-vitest-lane',
      run: stubRun,
    };
  };
  bridgeModule.createManifestLaneBridge = function createManifestLaneBridgeStub() {
    return {
      lane: 'memory-guard-vitest-manifest-lane',
      run: stubRun,
      runCli() {},
    };
  };

  delete require.cache[MODULE_PATH];
  try {
    testFn(require(MODULE_PATH));
  } finally {
    delete require.cache[MODULE_PATH];
    bridgeModule.createOpsLaneBridge = originalCreateOpsLaneBridge;
    bridgeModule.createManifestLaneBridge = originalCreateManifestLaneBridge;
  }
}

describe('V6-TEST-COVERAGE-001 client memory guard integration', () => {
  test('blocks rust-core bypass before bridge invocation', () => {
    let bridgeCalls = 0;
    withBridgeStub(
      () => {
        bridgeCalls += 1;
        return {
          ok: true,
          status: 0,
          stdout: '',
          stderr: '',
          payload: { ok: true, type: 'stub_bridge' },
        };
      },
      (memoryEfficiencyPlane) => {
        const bypassResult = memoryEfficiencyPlane.run([
          'query-index',
          '--session-id=session-security-test',
          '--bypass=1',
        ]);
        expect(bypassResult.status).toBe(2);
        expect(bypassResult.payload?.reason).toBe('index_first_bypass_forbidden');
        expect(bridgeCalls).toBe(0);

        const validResult = memoryEfficiencyPlane.run([
          'query-index',
          '--session-id=session-security-test',
          '--top=5',
          '--max-files=1',
        ]);
        expect(validResult.status).toBe(0);
        expect(bridgeCalls).toBe(1);
      },
    );
  });

  test('enforces memory policy contracts V6-MEMORY-013..019 in active vitest suite', () => {
    const policyValidator = require(path.join(
      ROOT,
      'client/runtime/systems/memory/policy_validator.ts',
    ));

    const v013 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=session-v6-memory-regression',
      '--file=local/workspace/memory/2026-03-15.md',
    ]);
    expect(v013.ok).toBe(false);
    expect(v013.reason_code).toBe('direct_file_read_forbidden');

    const v014 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=session-v6-memory-regression',
      '--bootstrap=1',
      '--lazy-hydration=0',
    ]);
    expect(v014.ok).toBe(false);
    expect(v014.reason_code).toBe('bootstrap_requires_lazy_hydration');

    const v015 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=session-v6-memory-regression',
      '--burn-threshold=250',
    ]);
    expect(v015.ok).toBe(false);
    expect(v015.reason_code).toBe('burn_slo_threshold_exceeded');

    const v016 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=session-v6-memory-regression',
      '--top=80',
    ]);
    expect(v016.ok).toBe(false);
    expect(v016.reason_code).toBe('recall_budget_exceeded');

    const v017 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=session-v6-memory-regression',
      '--scores-json=[0.8,0.91]',
      '--ids-json=["b","a"]',
    ]);
    expect(v017.ok).toBe(false);
    expect(v017.reason_code).toBe('ranking_not_descending');

    const v018 = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=session-v6-memory-regression',
      '--allow-stale=1',
    ]);
    expect(v018.ok).toBe(false);
    expect(v018.reason_code).toBe('stale_override_forbidden');

    const v019Fail = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=session-v6-memory-regression',
      '--lensmap-annotation-json={"node_id":"node-a","tags":[],"jots":[]}',
    ]);
    expect(v019Fail.ok).toBe(false);
    expect(v019Fail.reason_code).toBe('lensmap_annotation_missing_tags_or_jots');

    const v019Pass = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=session-v6-memory-regression',
      '--lensmap-annotation-json={"node_id":"node-a","tags":["memory"],"jots":["note"]}',
    ]);
    expect(v019Pass.ok).toBe(true);
    expect(v019Pass.reason_code).toBe('policy_ok');
  });

  test('enforces REQ-35 alias and policy conformance in active vitest lane', () => {
    const legacyAliasAdapter = require(path.join(
      ROOT,
      'client/runtime/systems/compat/legacy_alias_adapter.ts',
    ));
    const policyValidator = require(path.join(
      ROOT,
      'client/runtime/systems/memory/policy_validator.ts',
    ));

    const aliasLane = legacyAliasAdapter.resolveLane(
      '',
      path.join(ROOT, 'client/runtime/systems/memory/memory_index_freshness_gate.ts'),
    );
    expect(aliasLane).toBe('RUNTIME-SYSTEMS-MEMORY-MEMORY_INDEX_FRESHNESS_GATE');

    const compatLane = legacyAliasAdapter.laneFromAliasRel('systems/memory/policy_validator.ts');
    expect(compatLane).toBe('RUNTIME-SYSTEMS-MEMORY-POLICY_VALIDATOR');

    const bypassAttempt = policyValidator.validateMemoryPolicy([
      'query-index',
      '--session-id=llmn-conformance-session',
      '--allow-full-scan=1',
    ]);
    expect(bypassAttempt.ok).toBe(false);
    expect(bypassAttempt.reason_code).toBe('index_first_bypass_forbidden');

    const registryPath = path.join(ROOT, 'client/runtime/config/backlog_registry.json');
    const registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
    const rows = Array.isArray(registry)
      ? registry
      : Array.isArray(registry.rows)
        ? registry.rows
        : [];
    expect(rows.length).toBeGreaterThan(0);

    const req35Rows = rows.filter((row: any) => /^V6-LLMN-00[34]$/.test(String(row?.id ?? '')));
    expect(req35Rows.length).toBe(2);
    const acceptanceBlob = req35Rows
      .map((row: any) => String(row?.acceptance ?? ''))
      .join('\n')
      .toLowerCase();
    expect(acceptanceBlob.includes('llmn_mode_conformance')).toBe(true);
    expect(acceptanceBlob.includes('legacy_path_alias_adapters')).toBe(true);
  });
});
