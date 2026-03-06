#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-111
 * Canonical backlog registry + generated views + governance checks.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  clampInt,
  readJson,
  writeJsonAtomic,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');
const { loadPolicyRuntime } = require('../../lib/policy_runtime');
const { writeArtifactSet } = require('../../lib/state_artifact_contract');

const DEFAULT_POLICY_PATH = process.env.BACKLOG_REGISTRY_POLICY_PATH
  ? path.resolve(process.env.BACKLOG_REGISTRY_POLICY_PATH)
  : path.join(ROOT, 'config', 'backlog_registry_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/backlog_registry.js sync [--policy=<path>]');
  console.log('  node systems/ops/backlog_registry.js check [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/backlog_registry.js metrics [--policy=<path>]');
  console.log('  node systems/ops/backlog_registry.js triage [--limit=<n>] [--policy=<path>]');
  console.log('  node systems/ops/backlog_registry.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: true,
    active_statuses: ['queued', 'in_progress', 'blocked', 'proposed'],
    archive_statuses: ['done', 'dropped', 'archived', 'obsolete'],
    governance: {
      max_in_progress: 7,
      stale_warn_days: 14,
      stale_archive_days: 30,
      stale_statuses: ['queued', 'in_progress', 'blocked', 'proposed'],
      purge_candidate_statuses: ['queued', 'proposed', 'blocked'],
      strict_stale_purge: false,
      strict_dependency_integrity: false
    },
    quality: {
      strict: false,
      enforce_for_statuses: ['queued', 'in_progress', 'blocked', 'proposed'],
      min_problem_chars: 24,
      min_acceptance_chars: 40,
      require_verification_signal: true,
      require_rollback_signal: true,
      verification_signals: ['verify', 'test', 'receipt', 'check', 'assert'],
      rollback_signals: ['rollback', 'revert', 'fallback', 'undo']
    },
    paths: {
      backlog_path: 'UPGRADE_BACKLOG.md',
      registry_path: 'config/backlog_registry.json',
      active_view_path: 'docs/backlog_views/active.md',
      archive_view_path: 'docs/backlog_views/archive.md',
      state_path: 'state/ops/backlog_registry/state.json',
      latest_path: 'state/ops/backlog_registry/latest.json',
      receipts_path: 'state/ops/backlog_registry/receipts.jsonl'
    }
  };
}

function normalizeId(raw: any) {
  const id = cleanText(raw || '', 120).replace(/`/g, '');
  return /^[A-Z0-9]+(?:-[A-Z0-9]+)+$/.test(id) ? id : '';
}

function parseStatus(raw: any) {
  return normalizeToken(raw || 'queued', 80) || 'queued';
}

function normalizeList(raw: unknown, fallback: string[] = []) {
  if (!Array.isArray(raw)) return fallback.slice();
  const out: string[] = [];
  for (const entry of raw) {
    const tok = normalizeToken(entry, 80);
    if (!tok) continue;
    if (!out.includes(tok)) out.push(tok);
  }
  return out.length ? out : fallback.slice();
}

function parseDeps(raw: any) {
  const matches = String(raw || '')
    .toUpperCase()
    .match(/[A-Z0-9]+(?:-[A-Z0-9]+)+/g);
  const parts = Array.isArray(matches) ? matches : [];
  const out: string[] = [];
  for (const part of parts) {
    if (!out.includes(part)) out.push(part);
  }
  return out;
}

function splitMarkdownTableRow(rawLine: string) {
  const line = String(rawLine || '').trim();
  if (!line.startsWith('|')) return [];
  const row = line.endsWith('|') ? line.slice(1, -1) : line.slice(1);
  const cells: string[] = [];
  let buf = '';
  let inBacktick = false;
  let escaped = false;
  for (const ch of row) {
    if (escaped) {
      buf += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      buf += ch;
      escaped = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = !inBacktick;
      buf += ch;
      continue;
    }
    if (ch === '|' && !inBacktick) {
      cells.push(cleanText(buf.replace(/\\\|/g, '|'), 6000));
      buf = '';
      continue;
    }
    buf += ch;
  }
  cells.push(cleanText(buf.replace(/\\\|/g, '|'), 6000));
  return cells;
}

function parseBacklogRows(markdown: string) {
  const compactStatusAllow = new Set([
    'todo',
    'doing',
    'in_progress',
    'blocked',
    'done',
    'queued',
    'proposed',
    'dropped',
    'archived',
    'obsolete',
    'linked',
    'covered',
    'open',
    'planned'
  ]);
  const rowsById = new Map();
  for (const lineRaw of String(markdown || '').split(/\r?\n/)) {
    const line = String(lineRaw || '').trim();
    if (!line.startsWith('|')) continue;
    const cells = splitMarkdownTableRow(line);
    if (cells.length < 5) continue;
    if (/^-+$/.test(String(cells[0] || '').replace(/:/g, '').replace(/\s+/g, ''))) continue;
    const id = normalizeId(cells[0]);
    if (!id) continue;
    const canonical = cells.length >= 8;
    const rank = canonical ? 2 : 1;
    const prev = rowsById.get(id);
    if (prev && Number(prev._rank || 0) > rank) continue;

    const fallbackWave = cleanText(String(id).split('-')[0] || 'V?', 48) || 'V?';
    const compactStatus = parseStatus(cells[1]);
    if (!canonical && !compactStatusAllow.has(compactStatus)) continue;
    const row = canonical
      ? {
        id,
        class: normalizeToken(cells[1], 80),
        wave: cleanText(cells[2], 48) || fallbackWave,
        status: parseStatus(cells[3]),
        title: cleanText(cells[4], 500),
        problem: cleanText(cells[5], 6000),
        acceptance: cleanText(cells[6], 8000),
        dependencies: parseDeps(cells[7]),
        _rank: rank
      }
      : {
        id,
        class: 'backlog',
        wave: fallbackWave,
        status: compactStatus,
        title: cleanText(cells[2], 500),
        problem: cleanText(cells[3], 6000),
        acceptance: cleanText(cells[4], 8000),
        dependencies: [],
        _rank: rank
      };
    rowsById.set(id, row);
  }
  return Array.from(rowsById.values()).map((row: any) => {
    const out = { ...row };
    delete out._rank;
    return out;
  });
}

function renderView(title: string, rows: any[], generatedAt: string) {
  const body: string[] = [];
  body.push(`# ${title}`);
  body.push('');
  body.push(`Generated: ${generatedAt}`);
  body.push('');
  body.push('| ID | Class | Wave | Status | Title | Dependencies |');
  body.push('|---|---|---|---|---|---|');
  for (const row of rows) {
    body.push(`| ${row.id} | ${row.class || ''} | ${row.wave || ''} | ${row.status || ''} | ${row.title || ''} | ${(row.dependencies || []).join(', ')} |`);
  }
  body.push('');
  return `${body.join('\n')}\n`;
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function safeIsoMs(raw: any) {
  const ts = String(raw || '').trim();
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function daysSince(isoTs: any, nowMs: number) {
  const ms = safeIsoMs(isoTs);
  if (ms == null) return null;
  const delta = Math.max(0, nowMs - ms);
  return Number((delta / (1000 * 60 * 60 * 24)).toFixed(3));
}

function percentile(values: number[], p: number) {
  if (!values.length) return null;
  const sorted = values
    .filter((v) => Number.isFinite(v))
    .sort((a, b) => a - b);
  if (!sorted.length) return null;
  const q = Math.min(1, Math.max(0, Number(p || 0)));
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1));
  return Number(Number(sorted[idx]).toFixed(3));
}

function rowHash(row: any) {
  return stableHash(JSON.stringify({
    id: row.id,
    class: row.class,
    wave: row.wave,
    status: row.status,
    title: row.title,
    problem: row.problem,
    acceptance: row.acceptance,
    dependencies: row.dependencies
  }), 24);
}

function loadState(policy: any) {
  const base = {
    schema_id: 'backlog_registry_state',
    schema_version: '1.0',
    updated_at: null,
    rows: {}
  };
  const raw = readJson(policy.paths.state_path, {});
  const src = raw && raw.rows && typeof raw.rows === 'object' ? raw.rows : {};
  const cleaned: any = {};
  for (const [idRaw, entryRaw] of Object.entries(src)) {
    const id = normalizeId(idRaw);
    if (!id) continue;
    const entry: any = entryRaw && typeof entryRaw === 'object' ? entryRaw : {};
    cleaned[id] = {
      first_seen_at: cleanText(entry.first_seen_at || '', 64) || null,
      last_seen_at: cleanText(entry.last_seen_at || '', 64) || null,
      last_status: parseStatus(entry.last_status || 'queued'),
      last_row_hash: cleanText(entry.last_row_hash || '', 80) || null,
      last_status_change_at: cleanText(entry.last_status_change_at || '', 64) || null,
      last_content_change_at: cleanText(entry.last_content_change_at || '', 64) || null,
      done_at: cleanText(entry.done_at || '', 64) || null,
      removed_at: cleanText(entry.removed_at || '', 64) || null
    };
  }
  return {
    ...base,
    ...raw,
    rows: cleaned
  };
}

function saveState(policy: any, state: any) {
  writeJsonAtomic(policy.paths.state_path, {
    schema_id: 'backlog_registry_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    rows: state && state.rows && typeof state.rows === 'object' ? state.rows : {}
  });
}

function reconcileState(rows: any[], prevState: any, policy: any) {
  const now = nowIso();
  const archiveSet = new Set(policy.archive_statuses || []);
  const nextRows: any = {};
  const seen = new Set<string>();
  let new_rows = 0;
  let status_changes = 0;
  let content_changes = 0;
  let done_transitions = 0;
  let removed_rows = 0;

  for (const row of rows) {
    const id = normalizeId(row && row.id);
    if (!id) continue;
    seen.add(id);
    const prev = prevState && prevState.rows && prevState.rows[id] && typeof prevState.rows[id] === 'object'
      ? prevState.rows[id]
      : {};
    const nextHash = rowHash(row);
    const prevHash = cleanText(prev.last_row_hash || '', 80) || null;
    const prevStatus = parseStatus(prev.last_status || row.status);
    const statusChanged = !!prev.last_status && prevStatus !== row.status;
    const contentChanged = !!prevHash && prevHash !== nextHash;
    const firstSeenAt = cleanText(prev.first_seen_at || '', 64) || now;
    const lastStatusChangeAt = statusChanged
      ? now
      : (cleanText(prev.last_status_change_at || '', 64) || firstSeenAt);
    const lastContentChangeAt = (!prevHash || contentChanged)
      ? now
      : (cleanText(prev.last_content_change_at || '', 64) || firstSeenAt);

    let doneAt = cleanText(prev.done_at || '', 64) || null;
    if (archiveSet.has(row.status)) {
      if (!archiveSet.has(prevStatus)) {
        doneAt = now;
        done_transitions += 1;
      } else if (!doneAt) {
        doneAt = now;
      }
    } else {
      doneAt = null;
    }

    if (!prev.first_seen_at) new_rows += 1;
    if (statusChanged) status_changes += 1;
    if (!prevHash || contentChanged) content_changes += 1;

    nextRows[id] = {
      first_seen_at: firstSeenAt,
      last_seen_at: now,
      last_status: row.status,
      last_row_hash: nextHash,
      last_status_change_at: lastStatusChangeAt,
      last_content_change_at: lastContentChangeAt,
      done_at: doneAt,
      removed_at: null
    };
  }

  const prevRows = prevState && prevState.rows && typeof prevState.rows === 'object'
    ? prevState.rows
    : {};
  for (const [id, prev] of Object.entries(prevRows)) {
    if (seen.has(id)) continue;
    const item: any = prev && typeof prev === 'object' ? prev : {};
    removed_rows += 1;
    nextRows[id] = {
      first_seen_at: cleanText(item.first_seen_at || '', 64) || null,
      last_seen_at: cleanText(item.last_seen_at || '', 64) || now,
      last_status: parseStatus(item.last_status || 'queued'),
      last_row_hash: cleanText(item.last_row_hash || '', 80) || null,
      last_status_change_at: cleanText(item.last_status_change_at || '', 64) || null,
      last_content_change_at: cleanText(item.last_content_change_at || '', 64) || null,
      done_at: cleanText(item.done_at || '', 64) || null,
      removed_at: cleanText(item.removed_at || '', 64) || now
    };
  }

  return {
    state: {
      schema_id: 'backlog_registry_state',
      schema_version: '1.0',
      updated_at: now,
      rows: nextRows
    },
    updates: {
      new_rows,
      status_changes,
      content_changes,
      done_transitions,
      removed_rows
    }
  };
}

function evaluateQuality(rows: any[], policy: any) {
  const cfg = policy.quality || {};
  const enforceSet = new Set(cfg.enforce_for_statuses || []);
  const minProblem = clampInt(cfg.min_problem_chars, 0, 20000, 24);
  const minAcceptance = clampInt(cfg.min_acceptance_chars, 0, 20000, 40);
  const verifySignals = Array.isArray(cfg.verification_signals) ? cfg.verification_signals : [];
  const rollbackSignals = Array.isArray(cfg.rollback_signals) ? cfg.rollback_signals : [];
  const requireVerification = cfg.require_verification_signal !== false;
  const requireRollback = cfg.require_rollback_signal !== false;

  const findings: any[] = [];
  for (const row of rows) {
    if (!enforceSet.has(row.status)) continue;
    const title = cleanText(row.title || '', 500);
    const problem = cleanText(row.problem || '', 10000);
    const acceptance = cleanText(row.acceptance || '', 12000);
    const blob = `${problem}\n${acceptance}`.toLowerCase();
    const reasons: string[] = [];
    if (title.length < 8) reasons.push('title_too_short');
    if (problem.length < minProblem) reasons.push('problem_too_short');
    if (acceptance.length < minAcceptance) reasons.push('acceptance_too_short');
    if (requireVerification) {
      const hit = verifySignals.some((tok: string) => tok && blob.includes(String(tok).toLowerCase()));
      if (!hit) reasons.push('acceptance_missing_verification_signal');
    }
    if (requireRollback) {
      const hit = rollbackSignals.some((tok: string) => tok && blob.includes(String(tok).toLowerCase()));
      if (!hit) reasons.push('acceptance_missing_rollback_signal');
    }
    if (reasons.length) {
      findings.push({
        id: row.id,
        status: row.status,
        reasons
      });
    }
  }
  return findings;
}

function evaluateDependencyIntegrity(rows: any[], policy: any) {
  const activeSet = new Set(policy.active_statuses || []);
  const allIds = new Set(rows.map((row) => normalizeId(row.id)).filter(Boolean));
  const findings: any[] = [];
  for (const row of rows) {
    if (!activeSet.has(row.status)) continue;
    const deps = Array.isArray(row.dependencies) ? row.dependencies : [];
    const missing: string[] = [];
    for (const dep of deps) {
      const depId = normalizeId(dep);
      if (!depId) continue;
      if (!allIds.has(depId)) missing.push(depId);
    }
    if (missing.length) {
      findings.push({
        id: row.id,
        status: row.status,
        missing_dependencies: missing
      });
    }
  }
  return findings;
}

function evaluateStaleness(rows: any[], state: any, policy: any) {
  const cfg = policy.governance || {};
  const staleStatuses = new Set(cfg.stale_statuses || []);
  const purgeStatuses = new Set(cfg.purge_candidate_statuses || []);
  const warnDays = clampInt(cfg.stale_warn_days, 1, 3650, 14);
  const archiveDays = clampInt(cfg.stale_archive_days, warnDays, 3650, 30);
  const nowMs = Date.now();
  const staleRows: any[] = [];
  const purgeCandidates: any[] = [];

  const stateRows = state && state.rows && typeof state.rows === 'object' ? state.rows : {};
  for (const row of rows) {
    if (!staleStatuses.has(row.status)) continue;
    const hist = stateRows[row.id] && typeof stateRows[row.id] === 'object'
      ? stateRows[row.id]
      : {};
    const anchorTs = cleanText(
      hist.last_content_change_at
      || hist.last_status_change_at
      || hist.first_seen_at
      || '',
      64
    ) || null;
    const ageDays = daysSince(anchorTs, nowMs);
    if (ageDays == null) continue;
    if (ageDays >= warnDays) {
      staleRows.push({
        id: row.id,
        status: row.status,
        age_days: ageDays,
        anchor_ts: anchorTs
      });
    }
    if (ageDays >= archiveDays && purgeStatuses.has(row.status)) {
      purgeCandidates.push({
        id: row.id,
        status: row.status,
        age_days: ageDays,
        anchor_ts: anchorTs
      });
    }
  }

  staleRows.sort((a, b) => Number(b.age_days || 0) - Number(a.age_days || 0));
  purgeCandidates.sort((a, b) => Number(b.age_days || 0) - Number(a.age_days || 0));

  return {
    stale_warn_days: warnDays,
    stale_archive_days: archiveDays,
    stale_rows: staleRows,
    purge_candidates: purgeCandidates
  };
}

function buildGovernanceAnalysis(rows: any[], state: any, policy: any) {
  const inProgressCount = rows.filter((row) => row && row.status === 'in_progress').length;
  const maxInProgress = clampInt(policy.governance && policy.governance.max_in_progress, 0, 10000, 7);
  const qualityFindings = evaluateQuality(rows, policy);
  const dependencyFindings = evaluateDependencyIntegrity(rows, policy);
  const staleness = evaluateStaleness(rows, state, policy);
  return {
    max_in_progress: maxInProgress,
    in_progress_count: inProgressCount,
    wip_exceeded: maxInProgress > 0 && inProgressCount > maxInProgress,
    quality_findings: qualityFindings,
    dependency_findings: dependencyFindings,
    stale_rows: staleness.stale_rows,
    purge_candidates: staleness.purge_candidates,
    stale_warn_days: staleness.stale_warn_days,
    stale_archive_days: staleness.stale_archive_days
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const loaded = loadPolicyRuntime({
    policyPath,
    defaults: base
  });
  const raw = loaded.raw || {};
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  const governance = raw.governance && typeof raw.governance === 'object' ? raw.governance : {};
  const quality = raw.quality && typeof raw.quality === 'object' ? raw.quality : {};
  return {
    version: cleanText(raw.version || base.version, 24) || base.version,
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    active_statuses: normalizeList(raw.active_statuses, base.active_statuses),
    archive_statuses: normalizeList(raw.archive_statuses, base.archive_statuses),
    governance: {
      max_in_progress: clampInt(governance.max_in_progress, 0, 10000, base.governance.max_in_progress),
      stale_warn_days: clampInt(governance.stale_warn_days, 1, 3650, base.governance.stale_warn_days),
      stale_archive_days: clampInt(
        governance.stale_archive_days,
        clampInt(governance.stale_warn_days, 1, 3650, base.governance.stale_warn_days),
        3650,
        base.governance.stale_archive_days
      ),
      stale_statuses: normalizeList(governance.stale_statuses, base.governance.stale_statuses),
      purge_candidate_statuses: normalizeList(governance.purge_candidate_statuses, base.governance.purge_candidate_statuses),
      strict_stale_purge: toBool(governance.strict_stale_purge, base.governance.strict_stale_purge),
      strict_dependency_integrity: toBool(
        governance.strict_dependency_integrity,
        base.governance.strict_dependency_integrity
      )
    },
    quality: {
      strict: toBool(quality.strict, base.quality.strict),
      enforce_for_statuses: normalizeList(quality.enforce_for_statuses, base.quality.enforce_for_statuses),
      min_problem_chars: clampInt(quality.min_problem_chars, 0, 20000, base.quality.min_problem_chars),
      min_acceptance_chars: clampInt(quality.min_acceptance_chars, 0, 20000, base.quality.min_acceptance_chars),
      require_verification_signal: toBool(quality.require_verification_signal, base.quality.require_verification_signal),
      require_rollback_signal: toBool(quality.require_rollback_signal, base.quality.require_rollback_signal),
      verification_signals: normalizeList(quality.verification_signals, base.quality.verification_signals),
      rollback_signals: normalizeList(quality.rollback_signals, base.quality.rollback_signals)
    },
    paths: {
      backlog_path: resolvePath(paths.backlog_path, base.paths.backlog_path),
      registry_path: resolvePath(paths.registry_path, base.paths.registry_path),
      active_view_path: resolvePath(paths.active_view_path, base.paths.active_view_path),
      archive_view_path: resolvePath(paths.archive_view_path, base.paths.archive_view_path),
      state_path: resolvePath(paths.state_path, base.paths.state_path),
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function buildArtifacts(policy: any) {
  if (!fs.existsSync(policy.paths.backlog_path)) {
    return {
      ok: false,
      error: 'backlog_missing',
      backlog_path: rel(policy.paths.backlog_path)
    };
  }
  let generatedAt = nowIso();
  try {
    generatedAt = new Date(fs.statSync(policy.paths.backlog_path).mtimeMs).toISOString();
  } catch {}
  const markdown = fs.readFileSync(policy.paths.backlog_path, 'utf8');
  const sourceHash = stableHash(markdown, 24);
  const rows = parseBacklogRows(markdown);
  const activeSet = new Set(policy.active_statuses || []);
  const archiveSet = new Set(policy.archive_statuses || []);
  const activeRows = rows.filter((row) => activeSet.has(row.status));
  const archiveRows = rows.filter((row) => archiveSet.has(row.status));

  const registry = {
    schema_id: 'backlog_registry_v1',
    schema_version: '1.0',
    generated_at: generatedAt,
    source_hash: sourceHash,
    row_count: rows.length,
    active_count: activeRows.length,
    archive_count: archiveRows.length,
    rows
  };
  const activeView = renderView('Backlog Active View', activeRows, generatedAt);
  const archiveView = renderView('Backlog Archive View', archiveRows, generatedAt);

  return {
    ok: true,
    generated_at: generatedAt,
    rows,
    active_rows: activeRows,
    archive_rows: archiveRows,
    registry,
    active_view: activeView,
    archive_view: archiveView,
    hashes: {
      registry_hash: stableHash(JSON.stringify(registry), 24),
      active_view_hash: stableHash(activeView, 24),
      archive_view_hash: stableHash(archiveView, 24),
      source_hash: sourceHash
    }
  };
}

function cmdSync(policy: any) {
  const built = buildArtifacts(policy);
  if (!built.ok) {
    const out = {
      ok: false,
      type: 'backlog_registry',
      action: 'sync',
      ts: nowIso(),
      error: built.error || 'sync_failed'
    };
    writeArtifactSet(
      { latestPath: policy.paths.latest_path, receiptsPath: policy.paths.receipts_path },
      out,
      { schemaId: 'backlog_registry_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
    );
    emit(out, 2);
  }

  writeJsonAtomic(policy.paths.registry_path, built.registry);
  fs.mkdirSync(path.dirname(policy.paths.active_view_path), { recursive: true });
  fs.writeFileSync(policy.paths.active_view_path, built.active_view, 'utf8');
  fs.mkdirSync(path.dirname(policy.paths.archive_view_path), { recursive: true });
  fs.writeFileSync(policy.paths.archive_view_path, built.archive_view, 'utf8');

  const prevState = loadState(policy);
  const reconciled = reconcileState(built.rows || [], prevState, policy);
  saveState(policy, reconciled.state);
  const analysis = buildGovernanceAnalysis(built.rows || [], reconciled.state, policy);

  const out = writeArtifactSet(
    { latestPath: policy.paths.latest_path, receiptsPath: policy.paths.receipts_path },
    {
      ok: true,
      type: 'backlog_registry',
      action: 'sync',
      ts: nowIso(),
      row_count: built.registry.row_count,
      active_count: built.registry.active_count,
      archive_count: built.registry.archive_count,
      registry_path: rel(policy.paths.registry_path),
      active_view_path: rel(policy.paths.active_view_path),
      archive_view_path: rel(policy.paths.archive_view_path),
      state_path: rel(policy.paths.state_path),
      state_updates: reconciled.updates,
      governance: {
        max_in_progress: analysis.max_in_progress,
        in_progress_count: analysis.in_progress_count,
        wip_exceeded: analysis.wip_exceeded,
        quality_findings: analysis.quality_findings.length,
        dependency_findings: analysis.dependency_findings.length,
        stale_rows: analysis.stale_rows.length,
        purge_candidates: analysis.purge_candidates.length
      },
      ...built.hashes
    },
    { schemaId: 'backlog_registry_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
  );
  emit(out, 0);
}

function cmdCheck(args: any, policy: any) {
  const strict = toBool(args.strict, policy.strict_default);
  const built = buildArtifacts(policy);
  if (!built.ok) {
    emit(
      {
        ok: false,
        type: 'backlog_registry',
        action: 'check',
        ts: nowIso(),
        strict,
        error: built.error || 'check_failed'
      },
      strict ? 2 : 0
    );
  }

  const state = loadState(policy);
  const analysis = buildGovernanceAnalysis(built.rows || [], state, policy);

  const currentRegistry = readJson(policy.paths.registry_path, {});
  const currentActive = fs.existsSync(policy.paths.active_view_path)
    ? fs.readFileSync(policy.paths.active_view_path, 'utf8')
    : '';
  const currentArchive = fs.existsSync(policy.paths.archive_view_path)
    ? fs.readFileSync(policy.paths.archive_view_path, 'utf8')
    : '';

  const expectedHashes = built.hashes;
  const currentHashes = {
    registry_hash: stableHash(JSON.stringify(currentRegistry || {}), 24),
    active_view_hash: stableHash(currentActive || '', 24),
    archive_view_hash: stableHash(currentArchive || '', 24)
  };
  const drift = {
    registry: currentHashes.registry_hash !== expectedHashes.registry_hash,
    active_view: currentHashes.active_view_hash !== expectedHashes.active_view_hash,
    archive_view: currentHashes.archive_view_hash !== expectedHashes.archive_view_hash
  };
  const driftCount = [drift.registry, drift.active_view, drift.archive_view].filter(Boolean).length;
  const qualityHardFail = policy.quality && policy.quality.strict === true;
  const staleHardFail = policy.governance && policy.governance.strict_stale_purge === true;
  const dependencyHardFail = policy.governance && policy.governance.strict_dependency_integrity === true;
  const ok = driftCount === 0
    && analysis.wip_exceeded !== true
    && (!dependencyHardFail || analysis.dependency_findings.length === 0)
    && (!qualityHardFail || analysis.quality_findings.length === 0)
    && (!staleHardFail || analysis.purge_candidates.length === 0);

  const out = writeArtifactSet(
    { latestPath: policy.paths.latest_path, receiptsPath: policy.paths.receipts_path },
    {
      ok,
      type: 'backlog_registry',
      action: 'check',
      ts: nowIso(),
      strict,
      drift_count: driftCount,
      drift,
      expected_hashes: expectedHashes,
      current_hashes: currentHashes,
      governance: {
        max_in_progress: analysis.max_in_progress,
        in_progress_count: analysis.in_progress_count,
        wip_exceeded: analysis.wip_exceeded,
        quality_strict: qualityHardFail,
        quality_findings: analysis.quality_findings.length,
        quality_samples: analysis.quality_findings.slice(0, 20),
        dependency_strict: dependencyHardFail,
        dependency_findings: analysis.dependency_findings.length,
        dependency_samples: analysis.dependency_findings.slice(0, 20),
        stale_warn_days: analysis.stale_warn_days,
        stale_archive_days: analysis.stale_archive_days,
        stale_rows: analysis.stale_rows.length,
        stale_samples: analysis.stale_rows.slice(0, 20),
        purge_candidates: analysis.purge_candidates.length,
        purge_samples: analysis.purge_candidates.slice(0, 20),
        strict_stale_purge: staleHardFail
      }
    },
    { schemaId: 'backlog_registry_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
  );
  emit(out, ok || !strict ? 0 : 2);
}

function cmdMetrics(policy: any) {
  const built = buildArtifacts(policy);
  if (!built.ok) {
    emit(
      {
        ok: false,
        type: 'backlog_registry',
        action: 'metrics',
        ts: nowIso(),
        error: built.error || 'metrics_failed'
      },
      2
    );
  }

  const state = loadState(policy);
  const rows = built.rows || [];
  const rowById = new Map(rows.map((row: any) => [row.id, row]));
  const archiveSet = new Set(policy.archive_statuses || []);
  const nowMs = Date.now();
  const cycleDays: number[] = [];
  let done7d = 0;
  let done30d = 0;

  const stateRows = state && state.rows && typeof state.rows === 'object' ? state.rows : {};
  for (const [id, itemRaw] of Object.entries(stateRows)) {
    const item: any = itemRaw && typeof itemRaw === 'object' ? itemRaw : {};
    const row: any = rowById.get(id) || {};
    const status = parseStatus(row.status || item.last_status || 'queued');
    if (!archiveSet.has(status)) continue;
    const doneAt = cleanText(item.done_at || '', 64) || null;
    const firstSeen = cleanText(item.first_seen_at || '', 64) || null;
    const doneMs = safeIsoMs(doneAt);
    const firstMs = safeIsoMs(firstSeen);
    if (doneMs != null) {
      const ageDays = Number((Math.max(0, nowMs - doneMs) / (1000 * 60 * 60 * 24)).toFixed(3));
      if (ageDays <= 7) done7d += 1;
      if (ageDays <= 30) done30d += 1;
    }
    if (doneMs != null && firstMs != null && doneMs >= firstMs) {
      cycleDays.push(Number(((doneMs - firstMs) / (1000 * 60 * 60 * 24)).toFixed(3)));
    }
  }

  const activeSet = new Set(policy.active_statuses || []);
  const statusCounts: any = {};
  for (const row of rows) {
    const status = parseStatus(row.status);
    statusCounts[status] = Number(statusCounts[status] || 0) + 1;
  }
  const activeCount = rows.filter((row: any) => activeSet.has(row.status)).length;
  const blockedCount = rows.filter((row: any) => row.status === 'blocked').length;
  const inProgressCount = rows.filter((row: any) => row.status === 'in_progress').length;
  const doneCycleAvg = cycleDays.length
    ? Number((cycleDays.reduce((sum, n) => sum + n, 0) / cycleDays.length).toFixed(3))
    : null;

  const out = writeArtifactSet(
    { latestPath: policy.paths.latest_path, receiptsPath: policy.paths.receipts_path },
    {
      ok: true,
      type: 'backlog_registry',
      action: 'metrics',
      ts: nowIso(),
      row_count: rows.length,
      active_count: activeCount,
      blocked_count: blockedCount,
      in_progress_count: inProgressCount,
      throughput_done_7d: done7d,
      throughput_done_30d: done30d,
      done_cycle_count: cycleDays.length,
      done_cycle_days_avg: doneCycleAvg,
      done_cycle_days_p50: percentile(cycleDays, 0.5),
      done_cycle_days_p90: percentile(cycleDays, 0.9),
      status_counts: statusCounts
    },
    { schemaId: 'backlog_registry_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
  );
  emit(out, 0);
}

function cmdTriage(args: any, policy: any) {
  const built = buildArtifacts(policy);
  if (!built.ok) {
    emit(
      {
        ok: false,
        type: 'backlog_registry',
        action: 'triage',
        ts: nowIso(),
        error: built.error || 'triage_failed'
      },
      2
    );
  }
  const limit = clampInt(args.limit, 1, 200, 20);
  const state = loadState(policy);
  const rows = built.rows || [];
  const byId = new Map(rows.map((row: any) => [row.id, row]));
  const archiveSet = new Set(policy.archive_statuses || []);
  const analysis = buildGovernanceAnalysis(rows, state, policy);
  const doneIds = new Set(rows.filter((row: any) => archiveSet.has(row.status)).map((row: any) => row.id));

  const readyQueue = rows
    .filter((row: any) => row.status === 'queued' || row.status === 'proposed')
    .filter((row: any) => {
      const deps = Array.isArray(row.dependencies) ? row.dependencies : [];
      return deps.every((dep: string) => doneIds.has(dep));
    })
    .map((row: any) => ({
      id: row.id,
      status: row.status,
      title: row.title
    }));

  const blockedReady = rows
    .filter((row: any) => row.status === 'blocked')
    .filter((row: any) => {
      const deps = Array.isArray(row.dependencies) ? row.dependencies : [];
      return deps.length > 0 && deps.every((dep: string) => doneIds.has(dep));
    })
    .map((row: any) => ({
      id: row.id,
      status: row.status,
      title: row.title,
      dependencies: row.dependencies
    }));

  const doneBlockedByOpenDeps = rows
    .filter((row: any) => row.status === 'queued' || row.status === 'proposed')
    .filter((row: any) => {
      const deps = Array.isArray(row.dependencies) ? row.dependencies : [];
      if (!deps.length) return false;
      return deps.some((dep: string) => {
        const depRow = byId.get(dep);
        return depRow && !archiveSet.has(depRow.status);
      });
    })
    .map((row: any) => ({
      id: row.id,
      status: row.status,
      title: row.title,
      open_dependencies: (row.dependencies || []).filter((dep: string) => {
        const depRow = byId.get(dep);
        return depRow && !archiveSet.has(depRow.status);
      })
    }));

  const out = writeArtifactSet(
    { latestPath: policy.paths.latest_path, receiptsPath: policy.paths.receipts_path },
    {
      ok: true,
      type: 'backlog_registry',
      action: 'triage',
      ts: nowIso(),
      limit,
      ready_queue_count: readyQueue.length,
      blocked_ready_count: blockedReady.length,
      stale_count: analysis.stale_rows.length,
      purge_candidate_count: analysis.purge_candidates.length,
      waiting_dependency_count: doneBlockedByOpenDeps.length,
      ready_queue: readyQueue.slice(0, limit),
      blocked_ready: blockedReady.slice(0, limit),
      stale_samples: analysis.stale_rows.slice(0, limit),
      purge_candidates: analysis.purge_candidates.slice(0, limit),
      waiting_on_dependencies: doneBlockedByOpenDeps.slice(0, limit)
    },
    { schemaId: 'backlog_registry_receipt', schemaVersion: '1.0', artifactType: 'receipt' }
  );
  emit(out, 0);
}

function cmdStatus(policy: any) {
  const latest = readJson(policy.paths.latest_path, null);
  const state = loadState(policy);
  const trackedRows = state && state.rows && typeof state.rows === 'object'
    ? Object.keys(state.rows).length
    : 0;
  emit(
    {
      ok: !!latest,
      type: 'backlog_registry',
      action: 'status',
      ts: nowIso(),
      policy_path: rel(policy.policy_path),
      state_path: rel(policy.paths.state_path),
      tracked_rows: trackedRows,
      latest
    },
    0
  );
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 60) || 'status';
  if (cmd === '--help' || args.help) {
    usage();
    return;
  }
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (policy.enabled !== true) {
    emit({
      ok: false,
      type: 'backlog_registry',
      ts: nowIso(),
      error: 'policy_disabled'
    }, 2);
  }
  if (cmd === 'sync') return cmdSync(policy);
  if (cmd === 'check') return cmdCheck(args, policy);
  if (cmd === 'metrics') return cmdMetrics(policy);
  if (cmd === 'triage') return cmdTriage(args, policy);
  if (cmd === 'status') return cmdStatus(policy);
  usage();
  emit({ ok: false, error: 'unknown_command', command: cmd }, 2);
}

if (require.main === module) {
  main();
}
