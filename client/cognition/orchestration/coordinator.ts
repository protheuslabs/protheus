#!/usr/bin/env node
'use strict';

const { runCoordinatorCli } = require('./coordinator_cli.ts');
const { invokeOrchestration } = require('./core_bridge.ts');

function partitionWork(items, agentCount = 1) {
  const out = invokeOrchestration('coordinator.partition', {
    items: Array.isArray(items) ? items : [],
    agent_count: Number.isFinite(Number(agentCount)) ? Number(agentCount) : 1,
    scopes: [],
  });
  if (!out || !out.ok || !Array.isArray(out.partitions)) {
    return [];
  }
  return out.partitions;
}

function mergeFindings(findings) {
  const out = invokeOrchestration('coordinator.merge_findings', {
    findings: Array.isArray(findings) ? findings : [],
  });
  if (!out || !out.ok) {
    return {
      merged: [],
      dropped: [],
      deduped_count: 0,
    };
  }
  return {
    merged: Array.isArray(out.merged) ? out.merged : [],
    dropped: Array.isArray(out.dropped) ? out.dropped : [],
    deduped_count: Number.isFinite(Number(out.deduped_count)) ? Number(out.deduped_count) : 0,
  };
}

function assignScopesToPartitions(partitions, normalizedScopes = []) {
  const rows = Array.isArray(partitions) ? partitions.map((row) => {
    if (row && typeof row === 'object' && !Array.isArray(row)) return row;
    return { agent_id: null, items: [] };
  }) : [];
  const scopes = Array.isArray(normalizedScopes) ? normalizedScopes : [];
  return rows.map((partition, index) => ({
    ...partition,
    scope: scopes.length > 0 ? scopes[index % scopes.length] : null,
  }));
}

function runCoordinator(input = {}) {
  const out = invokeOrchestration('coordinator.run', {
    ...(input && typeof input === 'object' ? input : {}),
  });
  if (!out || typeof out.ok !== 'boolean') {
    return {
      ok: false,
      type: 'orchestration_coordinator',
      reason_code: 'orchestration_bridge_error',
    };
  }
  return out;
}

function run(argv = process.argv.slice(2)) {
  return runCoordinatorCli(argv, {
    runCoordinator,
    partitionWork,
    assignScopesToPartitions,
    detectScopeOverlaps(scopes = []) {
      const out = invokeOrchestration('scope.detect_overlaps', {
        scopes: Array.isArray(scopes) ? scopes : [],
      });
      if (!out || typeof out.ok !== 'boolean') {
        return {
          ok: false,
          reason_code: 'orchestration_bridge_error',
          normalized_scopes: [],
          overlaps: [],
        };
      }
      return {
        ok: out.ok,
        reason_code: out.reason_code,
        normalized_scopes: Array.isArray(out.normalized_scopes) ? out.normalized_scopes : [],
        overlaps: Array.isArray(out.overlaps) ? out.overlaps : [],
      };
    },
    loadScratchpad(taskId, options = {}) {
      const status = invokeOrchestration('scratchpad.status', {
        task_id: String(taskId || '').trim(),
        root_dir: options.rootDir || options.root_dir || undefined,
      });
      const fallback = {
        exists: false,
        filePath: null,
        scratchpad: {
          progress: { processed: 0, total: 0 },
          findings: [],
          checkpoints: [],
        },
      };
      if (!status || !status.ok) return fallback;
      return {
        exists: Boolean(status.exists),
        filePath: status.file_path || null,
        scratchpad: status.scratchpad || fallback.scratchpad,
      };
    },
    handleTimeout(taskId, metrics = {}, options = {}) {
      const out = invokeOrchestration('checkpoint.timeout', {
        task_id: String(taskId || '').trim(),
        metrics: metrics && typeof metrics === 'object' ? metrics : {},
        root_dir: options.rootDir || options.root_dir || undefined,
      });
      if (!out || typeof out.ok !== 'boolean') {
        return {
          ok: false,
          type: 'orchestration_checkpoint_timeout',
          reason_code: 'orchestration_bridge_error',
        };
      }
      return out;
    },
  });
}

if (require.main === module) {
  const out = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 1);
}

module.exports = {
  partitionWork,
  mergeFindings,
  assignScopesToPartitions,
  runCoordinator,
  run,
};
