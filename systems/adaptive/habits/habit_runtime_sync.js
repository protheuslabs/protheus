#!/usr/bin/env node
'use strict';

/**
 * systems/adaptive/habits/habit_runtime_sync.js
 *
 * Mirrors adaptive habit routines into habits/registry.json as managed
 * placeholders so runtime tooling can inspect and route them consistently.
 *
 * Safety:
 * - Managed placeholders are candidate/disabled and side-effect free.
 * - Only entries with provenance.source=adaptive_habit_runtime_sync are mutated.
 */

const fs = require('fs');
const path = require('path');
const { readHabitState } = require('./habit_store.js');
const { readRegistryWithUids, writeRegistryWithUids } = require('../../../habits/scripts/habit_uid_store.js');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HABIT_REGISTRY_PATH = path.join(ROOT, 'habits', 'registry.json');
const PROXY_ENTRYPOINT = 'habits/routines/adaptive_candidate_proxy.js';
const LOG_PATH = process.env.HABIT_RUNTIME_SYNC_LOG_PATH
  ? path.resolve(String(process.env.HABIT_RUNTIME_SYNC_LOG_PATH))
  : path.join(ROOT, 'state', 'adaptive', 'habits', 'runtime_sync.jsonl');
const MANAGED_SOURCE = 'adaptive_habit_runtime_sync';

function nowIso() {
  return new Date().toISOString();
}

function normalizeId(v, maxLen = 80) {
  return String(v || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9:_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, maxLen);
}

function clean(v, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function isManaged(habit) {
  const prov = habit && habit.provenance && typeof habit.provenance === 'object' ? habit.provenance : {};
  return String(prov.source || '') === MANAGED_SOURCE;
}

function toRuntimeHabit(adaptiveRow, existing) {
  const id = normalizeId(adaptiveRow && adaptiveRow.id);
  if (!id) return null;
  const uses30 = Math.max(0, Number(adaptiveRow && adaptiveRow.usage && adaptiveRow.usage.uses_30d || 0));
  const life = Math.max(0, Number(adaptiveRow && adaptiveRow.usage && adaptiveRow.usage.uses_total || 0));
  const lastUsed = adaptiveRow && adaptiveRow.usage && adaptiveRow.usage.last_used_ts
    ? String(adaptiveRow.usage.last_used_ts)
    : null;
  const adaptiveStatus = String(adaptiveRow && adaptiveRow.status || 'disabled').toLowerCase();
  const runtimeStatus = adaptiveStatus === 'active' ? 'candidate' : 'disabled';
  const now = nowIso();

  return {
    uid: existing && existing.uid ? existing.uid : undefined,
    id,
    name: clean(adaptiveRow && adaptiveRow.name || id, 120),
    description: clean(adaptiveRow && adaptiveRow.summary || `Adaptive habit candidate ${id}`, 240),
    created_at: clean(existing && existing.created_at || adaptiveRow && adaptiveRow.created_ts || now, 40),
    last_used_at: lastUsed,
    uses_30d: uses30,
    lifetime_uses: life,
    success_rate: Number(existing && existing.success_rate != null ? existing.success_rate : 0),
    avg_tokens_in: null,
    avg_tokens_out: null,
    estimated_tokens_saved: Number(existing && existing.estimated_tokens_saved || 0),
    rollback_plan: 'Disable placeholder entry and remove adaptive binding if behavior diverges.',
    test_plan: 'Validate proxy execution is no-op and adaptive bindings remain intact.',
    idempotent: true,
    inputs_schema: {
      type: 'object',
      required: [],
      properties: {
        notes: {
          type: 'string',
          description: 'Optional notes for adaptive candidate execution context'
        }
      }
    },
    entrypoint: PROXY_ENTRYPOINT,
    permissions: {
      network: 'deny',
      write_paths_allowlist: [
        'habits/logs/*'
      ],
      exec_allowlist: []
    },
    status: runtimeStatus,
    outcome: {
      last_outcome_score: existing && existing.outcome ? existing.outcome.last_outcome_score : null,
      last_delta_value: existing && existing.outcome ? existing.outcome.last_delta_value : null,
      outcome_unit: existing && existing.outcome ? existing.outcome.outcome_unit : null
    },
    governance: {
      state: runtimeStatus,
      promote: {
        min_success_runs: 99,
        min_outcome_score: 0.95
      },
      demote: {
        max_consecutive_errors: 1,
        min_outcome_score: 0.4,
        cooldown_minutes: 1440
      },
      pinned: false,
      consecutive_errors: Number(existing && existing.governance && existing.governance.consecutive_errors || 0)
    },
    provenance: {
      source: MANAGED_SOURCE,
      created_by: 'systems/adaptive/habits/habit_runtime_sync.js',
      created_at: clean(existing && existing.provenance && existing.provenance.created_at || now, 40),
      intent_key: `adaptive_habit:${id}`,
      adaptive_uid: clean(adaptiveRow && adaptiveRow.uid || '', 40) || null
    },
    metrics: existing && existing.metrics && typeof existing.metrics === 'object'
      ? existing.metrics
      : {
          baseline: {
            avg_duration_ms: null,
            avg_tokens_est: null,
            avg_error_rate: null
          },
          rolling: {
            avg_duration_ms_30d: null,
            avg_tokens_est_30d: null,
            error_rate_30d: null,
            window_runs: []
          }
        }
  };
}

function makeProxyScaffold(existing = null) {
  const now = nowIso();
  return {
    uid: existing && existing.uid ? existing.uid : undefined,
    id: 'adaptive_candidate_proxy',
    name: 'Adaptive Candidate Proxy',
    description: 'Managed placeholder routine used by adaptive habit runtime sync.',
    created_at: clean(existing && existing.created_at || now, 40),
    last_used_at: existing && existing.last_used_at ? String(existing.last_used_at) : null,
    uses_30d: Number(existing && existing.uses_30d || 0),
    lifetime_uses: Number(existing && existing.lifetime_uses || 0),
    success_rate: Number(existing && existing.success_rate || 0),
    avg_tokens_in: null,
    avg_tokens_out: null,
    estimated_tokens_saved: Number(existing && existing.estimated_tokens_saved || 0),
    rollback_plan: 'Disable scaffold if adaptive runtime sync is removed.',
    test_plan: 'Validate proxy routine remains no-op and hygiene guard passes.',
    idempotent: true,
    inputs_schema: {
      type: 'object',
      required: [],
      properties: {
        notes: {
          type: 'string',
          description: 'Optional notes for adaptive candidate execution context'
        }
      }
    },
    entrypoint: PROXY_ENTRYPOINT,
    permissions: {
      network: 'deny',
      write_paths_allowlist: [
        'habits/logs/*'
      ],
      exec_allowlist: []
    },
    status: 'disabled',
    outcome: existing && existing.outcome && typeof existing.outcome === 'object'
      ? existing.outcome
      : {
          last_outcome_score: null,
          last_delta_value: null,
          outcome_unit: null
        },
    governance: {
      state: 'disabled',
      promote: {
        min_success_runs: 99,
        min_outcome_score: 0.95
      },
      demote: {
        max_consecutive_errors: 1,
        min_outcome_score: 0.4,
        cooldown_minutes: 1440
      },
      pinned: false,
      consecutive_errors: Number(existing && existing.governance && existing.governance.consecutive_errors || 0)
    },
    provenance: {
      source: MANAGED_SOURCE,
      created_by: 'systems/adaptive/habits/habit_runtime_sync.js',
      created_at: clean(existing && existing.provenance && existing.provenance.created_at || now, 40),
      intent_key: 'adaptive_habit:proxy_scaffold',
      adaptive_uid: null
    },
    metrics: existing && existing.metrics && typeof existing.metrics === 'object'
      ? existing.metrics
      : {
          baseline: {
            avg_duration_ms: null,
            avg_tokens_est: null,
            avg_error_rate: null
          },
          rolling: {
            avg_duration_ms_30d: null,
            avg_tokens_est_30d: null,
            error_rate_30d: null,
            window_runs: []
          }
        }
  };
}

function sameRuntimeHabit(a, b) {
  const strip = (row) => ({
    id: String(row && row.id || ''),
    name: String(row && row.name || ''),
    description: String(row && row.description || ''),
    last_used_at: row && row.last_used_at ? String(row.last_used_at) : null,
    uses_30d: Number(row && row.uses_30d || 0),
    lifetime_uses: Number(row && row.lifetime_uses || 0),
    entrypoint: String(row && row.entrypoint || ''),
    status: String(row && row.status || ''),
    governance_state: String(row && row.governance && row.governance.state || ''),
    provenance_source: String(row && row.provenance && row.provenance.source || ''),
    provenance_adaptive_uid: row && row.provenance ? row.provenance.adaptive_uid || null : null
  });
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b));
}

function run() {
  const adaptive = readHabitState(null, null);
  const adaptiveRows = Array.isArray(adaptive && adaptive.routines) ? adaptive.routines : [];
  const registry = readRegistryWithUids(HABIT_REGISTRY_PATH, { version: 1.5, habits: [] }, true);
  if (!Array.isArray(registry.habits)) registry.habits = [];

  const byId = new Map(registry.habits.map((row, idx) => [normalizeId(row && row.id), { row, idx }]));
  const managedIds = new Set();
  let created = 0;
  let updated = 0;
  let disabled = 0;

  for (const adaptiveRow of adaptiveRows) {
    const id = normalizeId(adaptiveRow && adaptiveRow.id);
    if (!id) continue;
    managedIds.add(id);
    const found = byId.get(id);
    const existing = found ? found.row : null;
    const next = toRuntimeHabit(adaptiveRow, existing);
    if (!next) continue;
    if (!found) {
      registry.habits.push(next);
      created += 1;
      continue;
    }
    if (isManaged(existing) && !sameRuntimeHabit(existing, next)) {
      registry.habits[found.idx] = {
        ...existing,
        ...next
      };
      updated += 1;
    }
  }

  const proxyId = 'adaptive_candidate_proxy';
  if (!managedIds.has(proxyId)) {
    managedIds.add(proxyId);
    const foundProxy = byId.get(proxyId);
    const proxyNext = makeProxyScaffold(foundProxy ? foundProxy.row : null);
    if (!foundProxy) {
      registry.habits.push(proxyNext);
      created += 1;
    } else if (isManaged(foundProxy.row) && !sameRuntimeHabit(foundProxy.row, proxyNext)) {
      registry.habits[foundProxy.idx] = {
        ...foundProxy.row,
        ...proxyNext
      };
      updated += 1;
    }
  }

  for (let i = 0; i < registry.habits.length; i++) {
    const row = registry.habits[i];
    if (!isManaged(row)) continue;
    const id = normalizeId(row && row.id);
    if (managedIds.has(id)) continue;
    const status = String(row && row.status || '').toLowerCase();
    if (status !== 'disabled') {
      disabled += 1;
      registry.habits[i] = {
        ...row,
        status: 'disabled',
        governance: {
          ...(row.governance && typeof row.governance === 'object' ? row.governance : {}),
          state: 'disabled'
        }
      };
    }
  }

  const changed = created > 0 || updated > 0 || disabled > 0;
  if (changed) writeRegistryWithUids(HABIT_REGISTRY_PATH, registry);

  const summary = {
    ok: true,
    type: 'habit_runtime_sync',
    ts: nowIso(),
    changed,
    adaptive_routines: adaptiveRows.length,
    managed_habits: registry.habits.filter((row) => isManaged(row)).length,
    created,
    updated,
    disabled,
    registry_path: path.relative(ROOT, HABIT_REGISTRY_PATH).replace(/\\/g, '/')
  };
  appendJsonl(LOG_PATH, summary);
  return summary;
}

function status() {
  const registry = readRegistryWithUids(HABIT_REGISTRY_PATH, { version: 1.5, habits: [] }, true);
  const rows = Array.isArray(registry.habits) ? registry.habits : [];
  return {
    ok: true,
    type: 'habit_runtime_sync_status',
    managed_habits: rows.filter((row) => isManaged(row)).length,
    total_habits: rows.length,
    registry_path: path.relative(ROOT, HABIT_REGISTRY_PATH).replace(/\\/g, '/')
  };
}

function usage() {
  process.stdout.write(
    'Usage:\n' +
    '  node systems/adaptive/habits/habit_runtime_sync.js run\n' +
    '  node systems/adaptive/habits/habit_runtime_sync.js status\n'
  );
}

function main() {
  const cmd = String(process.argv[2] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  if (cmd === 'run') {
    process.stdout.write(JSON.stringify(run()) + '\n');
    return;
  }
  if (cmd === 'status') {
    process.stdout.write(JSON.stringify(status()) + '\n');
    return;
  }
  process.stdout.write(JSON.stringify({ ok: false, error: `unknown_command:${cmd}` }) + '\n');
  process.exit(2);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(JSON.stringify({
      ok: false,
      error: String(err && err.message || err || 'habit_runtime_sync_failed')
    }) + '\n');
    process.exit(1);
  }
}

module.exports = {
  run,
  status
};
