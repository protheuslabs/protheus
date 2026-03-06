#!/usr/bin/env node
'use strict';
export {};

/**
 * Reversion drill scheduler/executor for fractal mutations.
 *
 * Drills are recorded and replayable. Execution defaults to non-destructive
 * rollback simulation (apply=0) unless explicitly requested.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  resolvePath,
  stableHash
} = require('../../lib/queued_backlog_runtime');

function parseJsonFromStdout(stdout: string) {
  const text = String(stdout || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function defaultPaths() {
  return {
    queue_path: resolvePath('state/autonomy/fractal_engine/reversion_queue.json', 'state/autonomy/fractal_engine/reversion_queue.json'),
    latest_path: resolvePath('state/autonomy/fractal_engine/reversion_latest.json', 'state/autonomy/fractal_engine/reversion_latest.json'),
    rollback_script: resolvePath('systems/autonomy/gated_self_improvement_loop.js', 'systems/autonomy/gated_self_improvement_loop.js')
  };
}

function parseDelayMs(rawDelay: unknown) {
  const text = cleanText(rawDelay || '24h', 40).toLowerCase();
  const m = text.match(/^(\d+)([smhd])$/);
  if (!m) return 24 * 60 * 60 * 1000;
  const n = Math.max(1, Number(m[1]));
  const unit = m[2];
  if (unit === 's') return n * 1000;
  if (unit === 'm') return n * 60 * 1000;
  if (unit === 'h') return n * 60 * 60 * 1000;
  return n * 24 * 60 * 60 * 1000;
}

function loadQueue(paths: any) {
  const src = readJson(paths.queue_path, null);
  if (!src || typeof src !== 'object') {
    return {
      schema_id: 'fractal_reversion_queue',
      schema_version: '1.0',
      updated_at: nowIso(),
      drills: []
    };
  }
  return {
    schema_id: 'fractal_reversion_queue',
    schema_version: '1.0',
    updated_at: src.updated_at || nowIso(),
    drills: Array.isArray(src.drills) ? src.drills : []
  };
}

function saveQueue(paths: any, queue: any) {
  writeJsonAtomic(paths.queue_path, {
    schema_id: 'fractal_reversion_queue',
    schema_version: '1.0',
    updated_at: nowIso(),
    drills: Array.isArray(queue && queue.drills) ? queue.drills : []
  });
}

function runRollback(scriptPath: string, proposalId: string | null, reason: string, apply: boolean) {
  if (!scriptPath || !fs.existsSync(scriptPath) || !proposalId) {
    return {
      ok: false,
      code: 127,
      payload: null,
      stderr: 'rollback_script_or_proposal_missing'
    };
  }
  const proc = spawnSync('node', [
    scriptPath,
    'rollback',
    `--proposal-id=${proposalId}`,
    `--reason=${cleanText(reason, 160) || 'fractal_reversion_drill'}`,
    `--apply=${apply ? '1' : '0'}`
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 120000
  });
  return {
    ok: Number(proc.status || 0) === 0,
    code: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    payload: parseJsonFromStdout(proc.stdout),
    stderr: cleanText(proc.stderr || '', 800)
  };
}

function scheduleDrill(mutationId: string, delay = '24h', options: any = {}) {
  const paths = defaultPaths();
  const queue = loadQueue(paths);
  const id = normalizeToken(mutationId || '', 120) || `mutation_${Date.now()}`;
  const delayMs = parseDelayMs(delay);
  const dueAtMs = Date.now() + delayMs;
  const drillId = `rdr_${stableHash(`${id}|${dueAtMs}|${Math.random()}`, 12)}`;

  const row = {
    drill_id: drillId,
    mutation_id: id,
    proposal_id: normalizeToken(options.proposalId || options.proposal_id || '', 160) || null,
    scheduled_at: nowIso(),
    due_at: new Date(dueAtMs).toISOString(),
    status: 'scheduled',
    source: cleanText(options.source || 'fractal_engine', 80) || 'fractal_engine',
    reason: cleanText(options.reason || 'post_apply_reversion_drill', 200) || 'post_apply_reversion_drill',
    quarantine: null,
    execution: null
  };

  queue.drills.push(row);
  saveQueue(paths, queue);
  writeJsonAtomic(paths.latest_path, {
    ok: true,
    type: 'fractal_reversion_schedule',
    ts: nowIso(),
    drill: row
  });
  return row;
}

function quarantineMutation(mutationId: string, reason: string) {
  const paths = defaultPaths();
  const queue = loadQueue(paths);
  const id = normalizeToken(mutationId || '', 120);
  let touched = 0;
  for (const drill of queue.drills) {
    if (normalizeToken(drill && drill.mutation_id || '', 120) !== id) continue;
    drill.status = 'quarantined';
    drill.quarantine = {
      ts: nowIso(),
      reason: cleanText(reason || 'venom_containment_triggered', 240) || 'venom_containment_triggered'
    };
    touched += 1;
  }
  saveQueue(paths, queue);
  const out = {
    ok: touched > 0,
    type: 'fractal_reversion_quarantine',
    ts: nowIso(),
    mutation_id: id || null,
    affected_drills: touched
  };
  writeJsonAtomic(paths.latest_path, out);
  return out;
}

function runDue(options: any = {}) {
  const paths = defaultPaths();
  const queue = loadQueue(paths);
  const nowMs = Date.now();
  const apply = toBool(options.apply, false);

  const executed = [];
  for (const drill of queue.drills) {
    if (!drill || typeof drill !== 'object') continue;
    if (normalizeToken(drill.status || '', 40) !== 'scheduled') continue;
    const dueMs = Date.parse(String(drill.due_at || ''));
    if (!Number.isFinite(dueMs) || dueMs > nowMs) continue;

    const rollback = runRollback(
      paths.rollback_script,
      drill.proposal_id,
      cleanText(options.reason || drill.reason || 'scheduled_reversion_drill', 160),
      apply
    );

    drill.status = rollback.ok ? 'executed' : 'execution_failed';
    drill.execution = {
      ts: nowIso(),
      apply,
      ok: rollback.ok,
      code: rollback.code,
      rollback_receipt_id: rollback.payload && rollback.payload.receipt_id || null,
      rollback_stage: rollback.payload && rollback.payload.stage || null,
      error: rollback.ok ? null : (rollback.stderr || 'rollback_failed')
    };
    executed.push({ drill_id: drill.drill_id, status: drill.status, execution: drill.execution });
  }

  saveQueue(paths, queue);
  const out = {
    ok: true,
    type: 'fractal_reversion_run_due',
    ts: nowIso(),
    apply,
    executed_count: executed.length,
    executed
  };
  writeJsonAtomic(paths.latest_path, out);
  return out;
}

function status() {
  const paths = defaultPaths();
  const queue = loadQueue(paths);
  const drills = Array.isArray(queue.drills) ? queue.drills : [];
  const summary = {
    total: drills.length,
    scheduled: drills.filter((row: any) => normalizeToken(row.status, 32) === 'scheduled').length,
    executed: drills.filter((row: any) => normalizeToken(row.status, 32) === 'executed').length,
    quarantined: drills.filter((row: any) => normalizeToken(row.status, 32) === 'quarantined').length,
    failed: drills.filter((row: any) => normalizeToken(row.status, 32) === 'execution_failed').length
  };
  return {
    ok: true,
    type: 'fractal_reversion_status',
    ts: nowIso(),
    summary,
    queue_path: path.relative(ROOT, paths.queue_path).replace(/\\/g, '/'),
    latest_path: path.relative(ROOT, paths.latest_path).replace(/\\/g, '/')
  };
}

module.exports = {
  scheduleDrill,
  runDue,
  quarantineMutation,
  status,
  parseDelayMs
};
