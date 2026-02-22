#!/usr/bin/env node
'use strict';

/**
 * model_catalog_loop.js — built-in autonomy capability for routing model catalog updates.
 *
 * Flow:
 * - propose: detect candidate model additions
 * - trial: evaluate candidates with router doctor
 * - report: compact status summary
 * - review: detailed handoff summary for governance
 * - approve: guarded apply wrapper (logs handoff decision)
 * - reject: close handoff without apply
 * - apply: guarded config update (CLEARANCE>=3 + approval note + guard)
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { beginChange, completeChange, recoverIfInterrupted, writeAtomicJson } = require('./self_change_failsafe');
const { stampGuardEnv } = require('../../lib/request_envelope.js');
const { listLocalOllamaModels } = require('../routing/llm_gateway.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROUTING_CONFIG = path.join(REPO_ROOT, 'config', 'agent_routing_rules.json');
const EYES_RAW_DIR = process.env.AUTONOMY_MODEL_CATALOG_EYE_DIR
  ? path.resolve(process.env.AUTONOMY_MODEL_CATALOG_EYE_DIR)
  : path.join(REPO_ROOT, 'state', 'sensory', 'eyes', 'raw');
const PROPOSALS_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_proposals');
const TRIALS_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_trials');
const HANDOFFS_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_handoffs');
const AUDIT_PATH = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_audit.jsonl');
const SNAPSHOT_DIR = path.join(REPO_ROOT, 'state', 'routing', 'model_catalog_snapshots');
const GUARD_SCRIPT = path.join(REPO_ROOT, 'systems', 'security', 'guard.js');
const ROUTER_SCRIPT = path.join(REPO_ROOT, 'systems', 'routing', 'model_router.js');
const ROLLBACK_SCRIPT = path.join(REPO_ROOT, 'systems', 'autonomy', 'model_catalog_rollback.js');
const EYE_LOOKBACK_DAYS = Number(process.env.AUTONOMY_MODEL_CATALOG_EYE_LOOKBACK_DAYS || 7);
const EYE_MAX_CANDIDATES = Number(process.env.AUTONOMY_MODEL_CATALOG_EYE_MAX_CANDIDATES || 60);

function nowIso() { return new Date().toISOString(); }
function dayStr() { return nowIso().slice(0, 10); }

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const i = a.indexOf('=');
    if (i === -1) out[a.slice(2)] = true;
    else out[a.slice(2, i)] = a.slice(i + 1);
  }
  return out;
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function readJson(p, fallback = null) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; } }
function writeJson(p, obj) { ensureDir(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', 'utf8'); }
function appendJsonl(p, obj) { ensureDir(path.dirname(p)); fs.appendFileSync(p, JSON.stringify(obj) + '\n', 'utf8'); }

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/model_catalog_loop.js propose [--source=local|eye|auto|none]');
  console.log('  node systems/autonomy/model_catalog_loop.js trial --id=<proposal_id>');
  console.log('  node systems/autonomy/model_catalog_loop.js report [--id=<proposal_id>]');
  console.log('  node systems/autonomy/model_catalog_loop.js review [--id=<proposal_id>]');
  console.log('  node systems/autonomy/model_catalog_loop.js approve --id=<proposal_id> --approval-note="..." [--break-glass=1]');
  console.log('  node systems/autonomy/model_catalog_loop.js reject --id=<proposal_id> --reason="..."');
  console.log('  node systems/autonomy/model_catalog_loop.js apply --id=<proposal_id> --approval-note="..." [--break-glass=1]');
  console.log('  node systems/autonomy/model_catalog_loop.js --help');
}

function proposalPath(id) { return path.join(PROPOSALS_DIR, `${id}.json`); }
function trialPath(id) { return path.join(TRIALS_DIR, `${id}.json`); }
function handoffPath(id) { return path.join(HANDOFFS_DIR, `${id}.json`); }

function latestId(dir) {
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  return files.length ? files[files.length - 1].replace(/\.json$/, '') : null;
}

function readJsonFromText(s) { try { return JSON.parse(s); } catch { return null; } }

function loadRoutingConfig() {
  const cfg = readJson(ROUTING_CONFIG, null);
  if (!cfg || !cfg.routing || !Array.isArray(cfg.routing.spawn_model_allowlist)) {
    throw new Error(`invalid routing config: ${ROUTING_CONFIG}`);
  }
  return cfg;
}

function localOllamaModels() {
  const listed = listLocalOllamaModels({
    timeoutMs: 12000,
    cwd: REPO_ROOT,
    source: 'model_catalog_loop'
  });
  if (!listed.ok) return [];
  const out = (listed.models || [])
    .map((m) => String(m || '').trim())
    .filter(Boolean)
    .map((m) => `ollama/${m}`);
  return Array.from(new Set(out));
}

function isRecentDateFile(name, maxDays) {
  const m = String(name || '').match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
  if (!m) return false;
  const ts = Date.parse(`${m[1]}T00:00:00Z`);
  if (!Number.isFinite(ts)) return false;
  const ageDays = Math.max(0, (Date.now() - ts) / (24 * 60 * 60 * 1000));
  return ageDays <= Math.max(1, Number(maxDays || 7));
}

function normalizeModelToken(raw) {
  const v = String(raw || '').trim().toLowerCase();
  if (!v) return '';
  const cleaned = v
    .replace(/^ollama\//, '')
    .replace(/[^a-z0-9._:+-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 96);
  if (!cleaned) return '';
  if (!/^[a-z0-9]/.test(cleaned)) return '';
  return cleaned;
}

function parseLibrarySlug(url) {
  const m = String(url || '').match(/\/library\/([^/?#]+)/i);
  if (!m) return '';
  return normalizeModelToken(m[1]);
}

function cloudCandidatesForBase(baseToken) {
  const base = normalizeModelToken(baseToken);
  if (!base) return [];
  if (base.endsWith(':cloud') || base.endsWith('-cloud')) return [base];
  const safe = base.replace(/:/g, '-');
  return [`ollama/${safe}:cloud`];
}

function eyeDiscoveredCloudModels() {
  if (!fs.existsSync(EYES_RAW_DIR)) return [];
  const files = fs.readdirSync(EYES_RAW_DIR)
    .filter(f => isRecentDateFile(f, EYE_LOOKBACK_DAYS))
    .sort()
    .reverse();
  const out = [];
  const seen = new Set();
  for (const f of files) {
    const abs = path.join(EYES_RAW_DIR, f);
    const lines = String(fs.readFileSync(abs, 'utf8')).split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let ev = null;
      try { ev = JSON.parse(lines[i]); } catch { continue; }
      if (!ev || ev.type !== 'external_item' || String(ev.eye_id || '') !== 'ollama_search') continue;
      const slug = parseLibrarySlug(ev.url || '');
      const titleToken = normalizeModelToken(ev.title || '');
      const bases = [];
      if (slug) bases.push(slug);
      if (!slug && titleToken && !bases.includes(titleToken)) bases.push(titleToken);
      for (const b of bases) {
        for (const c of cloudCandidatesForBase(b)) {
          if (seen.has(c)) continue;
          seen.add(c);
          out.push(c);
          if (out.length >= Math.max(1, EYE_MAX_CANDIDATES)) return out;
        }
      }
    }
  }
  return out;
}

function runDoctorForModel(model) {
  const r = spawnSync('node', [ROUTER_SCRIPT, 'doctor', '--risk=low', '--complexity=low', '--intent=chat', '--task=catalog trial', `--candidate=${model}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8'
  });
  if (r.status !== 0) return { ok: false, error: String(r.stderr || r.stdout || '').slice(0, 200) };
  const payload = readJsonFromText(String(r.stdout || '').trim().split('\n').find(l => l.trim().startsWith('{')) || '{}');
  const d = payload && Array.isArray(payload.diagnostics) ? payload.diagnostics.find(x => x.model === model) : null;
  if (!d) return { ok: false, error: 'diagnostic_not_found' };
  return {
    ok: true,
    eligible: d.eligible === true,
    reasons: d.reasons || [],
    rank_score: d.rank_score,
    local_health: d.local_health || null,
    outcome_score: d.outcome_score
  };
}

function runGuard(files, approvalNote, breakGlass) {
  const rels = files.map(p => path.relative(REPO_ROOT, p).replace(/\\/g, '/'));
  let env = {
    ...process.env,
    CLEARANCE: process.env.CLEARANCE || '2',
    APPROVAL_NOTE: approvalNote || '',
    BREAK_GLASS: breakGlass ? '1' : '0'
  };
  const source = String(env.REQUEST_SOURCE || 'local').trim() || 'local';
  const action = String(env.REQUEST_ACTION || 'apply').trim() || 'apply';
  env = stampGuardEnv(env, { source, action, files: rels });
  const r = spawnSync('node', [GUARD_SCRIPT, `--files=${rels.join(',')}`], { cwd: REPO_ROOT, encoding: 'utf8', env });
  const line = String(r.stdout || '').split('\n').find(x => x.trim().startsWith('{')) || '{}';
  const payload = readJsonFromText(line);
  return { ok: r.status === 0 && payload && payload.ok === true, status: r.status || 0, payload, stderr: String(r.stderr || '').trim() };
}

function ensureHandoffFor(id) {
  const hp = handoffPath(id);
  const existing = readJson(hp, null);
  if (existing) return existing;
  const proposal = readJson(proposalPath(id), null);
  const trial = readJson(trialPath(id), null);
  if (!proposal || !trial) return null;
  const handoff = {
    id,
    ts: nowIso(),
    type: 'model_catalog_handoff',
    status: 'apply_pending',
    proposal_id: id,
    trial_id: id,
    passed_models: trial.passed_models || [],
    failed_models: trial.failed_models || [],
    expected_impact: {
      candidate_additions: (proposal.additions || []).length,
      vetted_additions: (trial.passed_models || []).length
    },
    apply_command: `CLEARANCE=3 node systems/autonomy/model_catalog_loop.js apply --id=${id} --approval-note="<reason>"`,
    rollback_command: `CLEARANCE=3 node systems/autonomy/model_catalog_rollback.js latest --approval-note="rollback ${id}"`
  };
  writeJson(hp, handoff);
  appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'handoff_created', id, passed: (handoff.passed_models || []).length });
  return handoff;
}

function cmdPropose(args) {
  const source = String(args.source || 'local').toLowerCase();
  const cfg = loadRoutingConfig();
  const allowlist = Array.from(new Set(cfg.routing.spawn_model_allowlist || []));
  const localDiscovered = (source === 'local' || source === 'auto') ? localOllamaModels() : [];
  const eyeDiscovered = (source === 'eye' || source === 'auto') ? eyeDiscoveredCloudModels() : [];
  const discovered = source === 'none'
    ? []
    : Array.from(new Set([...localDiscovered, ...eyeDiscovered]));
  const additions = discovered.filter(m => !allowlist.includes(m));

  const id = `${dayStr()}__${Date.now()}`;
  const proposal = {
    id,
    ts: nowIso(),
    type: 'model_catalog_proposal',
    source,
    source_breakdown: {
      local_count: localDiscovered.length,
      eye_cloud_count: eyeDiscovered.length
    },
    discovered_models: discovered,
    current_allowlist: allowlist,
    additions,
    removals: [],
    status: 'proposed',
    notes: [
      'Autonomy may propose/trial catalog changes automatically.',
      'Apply requires elevated guard (CLEARANCE>=3) + approval note.'
    ]
  };

  writeJson(proposalPath(id), proposal);
  appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'proposal_created', id, additions: additions.length, source });
  process.stdout.write(JSON.stringify({ ok: true, id, additions: additions.length, proposal_path: proposalPath(id) }) + '\n');
}

function cmdTrial(args) {
  const id = String(args.id || '').trim() || latestId(PROPOSALS_DIR);
  if (!id) return fail(2, 'missing --id and no proposals found');
  const proposal = readJson(proposalPath(id), null);
  if (!proposal) return fail(2, `proposal not found: ${id}`);

  const checks = [];
  for (const m of proposal.additions || []) checks.push({ model: m, ...runDoctorForModel(m) });

  const passed = checks.filter(c => c.ok && c.eligible === true).map(c => c.model);
  const failed = checks.filter(c => !c.ok || c.eligible !== true).map(c => ({ model: c.model, reason: c.error || (c.reasons || []).join(',') || 'not_eligible' }));

  const trial = {
    id,
    ts: nowIso(),
    type: 'model_catalog_trial',
    proposal_id: id,
    checks,
    passed_models: passed,
    failed_models: failed,
    status: 'trialed'
  };
  writeJson(trialPath(id), trial);
  if (passed.length > 0) ensureHandoffFor(id);

  appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'trial_completed', id, passed: passed.length, failed: failed.length });
  process.stdout.write(JSON.stringify({ ok: true, id, passed: passed.length, failed: failed.length, trial_path: trialPath(id) }) + '\n');
}

function applyInternal(id, approvalNote, breakGlass) {
  const proposal = readJson(proposalPath(id), null);
  const trial = readJson(trialPath(id), null);
  if (!proposal) return { ok: false, code: 2, error: `proposal not found: ${id}` };
  if (!trial) return { ok: false, code: 2, error: `trial not found: ${id}; run trial first` };

  const clearance = Number(process.env.CLEARANCE || 2);
  if (!Number.isFinite(clearance) || clearance < 3) {
    return { ok: false, code: 1, error: 'apply requires CLEARANCE>=3' };
  }

  const guard = runGuard([ROUTING_CONFIG], approvalNote, breakGlass);
  if (!guard.ok) {
    appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'apply_blocked', id, reason: 'guard_blocked', guard });
    return { ok: false, code: 1, error: 'guard_blocked', guard };
  }

  const cfg = loadRoutingConfig();
  const allow = new Set(cfg.routing.spawn_model_allowlist || []);
  for (const m of trial.passed_models || []) allow.add(m);

  const snapshotName = `${dayStr()}__${Date.now()}__agent_routing_rules.json`;
  ensureDir(SNAPSHOT_DIR);
  const snapshotAbs = path.join(SNAPSHOT_DIR, snapshotName);
  fs.copyFileSync(ROUTING_CONFIG, snapshotAbs);

  const changeId = `model_catalog_apply:${id}:${Date.now()}`;
  beginChange({
    id: changeId,
    kind: 'model_catalog_apply',
    target_path: ROUTING_CONFIG,
    snapshot_path: snapshotAbs,
    note: `apply ${id}`
  });

  try {
    cfg.routing.spawn_model_allowlist = Array.from(allow);
    writeAtomicJson(ROUTING_CONFIG, cfg);
    // post-write validation to ensure config remains parseable and contract-safe
    loadRoutingConfig();
    completeChange(changeId, { proposal_id: id, added_models: (trial.passed_models || []).length });
  } catch (err) {
    // Immediate local recovery; startup recovery is still available as a secondary failsafe.
    try {
      fs.copyFileSync(snapshotAbs, ROUTING_CONFIG);
      completeChange(changeId, { proposal_id: id, reverted: true, reason: 'apply_write_error' });
    } catch {}
    throw err;
  }

  appendJsonl(AUDIT_PATH, {
    ts: nowIso(),
    type: 'apply_success',
    id,
    approval_note: approvalNote.slice(0, 240),
    break_glass: breakGlass,
    added_models: trial.passed_models || [],
    snapshot: snapshotAbs
  });

  return {
    ok: true,
    code: 0,
    id,
    added_models: (trial.passed_models || []).length,
    added_models_list: Array.isArray(trial.passed_models) ? trial.passed_models.slice(0, 128) : [],
    snapshot: snapshotAbs
  };
}

function cmdApply(args) {
  const id = String(args.id || '').trim() || latestId(PROPOSALS_DIR);
  const approvalNote = String(args['approval-note'] || '').trim();
  const breakGlass = String(args['break-glass'] || '0') === '1';
  if (!id) return fail(2, 'missing --id and no proposals found');
  if (!approvalNote) return fail(2, 'apply requires --approval-note');
  const res = applyInternal(id, approvalNote, breakGlass);
  if (!res.ok) {
    process.stdout.write(JSON.stringify({ ok: false, error: res.error, guard: res.guard || null }) + '\n');
    process.exit(res.code || 1);
  }
  process.stdout.write(JSON.stringify({
    ok: true,
    id: res.id,
    added_models: res.added_models,
    models: res.added_models_list || [],
    snapshot: res.snapshot
  }) + '\n');
}

function cmdReview(args) {
  const id = String(args.id || '').trim() || latestId(PROPOSALS_DIR);
  if (!id) return fail(2, 'no proposals found');
  const proposal = readJson(proposalPath(id), null);
  const trial = readJson(trialPath(id), null);
  const handoff = readJson(handoffPath(id), null) || ensureHandoffFor(id);
  if (!proposal) return fail(2, `proposal not found: ${id}`);
  if (!trial) return fail(2, `trial not found: ${id}; run trial first`);

  const risks = [];
  if ((trial.passed_models || []).length === 0) risks.push('no_vetted_additions');
  if ((trial.failed_models || []).length > 0) risks.push('some_candidates_failed_trial');
  if ((proposal.additions || []).length > 5) risks.push('large_addition_batch');

  process.stdout.write(JSON.stringify({
    ok: true,
    id,
    status: handoff ? handoff.status : 'apply_pending',
    proposal: {
      source: proposal.source,
      discovered: (proposal.discovered_models || []).length,
      additions: proposal.additions || []
    },
    trial: {
      passed_models: trial.passed_models || [],
      failed_models: trial.failed_models || []
    },
    handoff: handoff || null,
    risks
  }, null, 2) + '\n');
}

function cmdApprove(args) {
  const id = String(args.id || '').trim() || latestId(PROPOSALS_DIR);
  const approvalNote = String(args['approval-note'] || '').trim();
  const breakGlass = String(args['break-glass'] || '0') === '1';
  if (!id) return fail(2, 'missing --id and no proposals found');
  if (!approvalNote) return fail(2, 'approve requires --approval-note');

  const handoff = ensureHandoffFor(id);
  if (!handoff) return fail(2, `handoff not found: ${id}`);

  const res = applyInternal(id, approvalNote, breakGlass);
  if (!res.ok) {
    appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'handoff_approve_failed', id, error: res.error });
    process.stdout.write(JSON.stringify({ ok: false, error: res.error, guard: res.guard || null }) + '\n');
    process.exit(res.code || 1);
  }

  handoff.status = 'approved_applied';
  handoff.approved_ts = nowIso();
  handoff.approval_note = approvalNote.slice(0, 240);
  handoff.snapshot = res.snapshot;
  writeJson(handoffPath(id), handoff);
  appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'handoff_approved', id, snapshot: res.snapshot });

  process.stdout.write(JSON.stringify({ ok: true, id, status: handoff.status, snapshot: res.snapshot }) + '\n');
}

function cmdReject(args) {
  const id = String(args.id || '').trim() || latestId(PROPOSALS_DIR);
  const reason = String(args.reason || '').trim();
  if (!id) return fail(2, 'missing --id and no proposals found');
  if (!reason) return fail(2, 'reject requires --reason');

  const handoff = ensureHandoffFor(id);
  if (!handoff) return fail(2, `handoff not found: ${id}`);
  handoff.status = 'rejected';
  handoff.rejected_ts = nowIso();
  handoff.rejection_reason = reason.slice(0, 240);
  writeJson(handoffPath(id), handoff);
  appendJsonl(AUDIT_PATH, { ts: nowIso(), type: 'handoff_rejected', id, reason: reason.slice(0, 240) });
  process.stdout.write(JSON.stringify({ ok: true, id, status: handoff.status }) + '\n');
}

function cmdReport(args) {
  const id = String(args.id || '').trim() || latestId(PROPOSALS_DIR);
  if (!id) return fail(2, 'no proposals found');
  const proposal = readJson(proposalPath(id), null);
  const trial = readJson(trialPath(id), null);
  const handoff = readJson(handoffPath(id), null);
  process.stdout.write(JSON.stringify({
    ok: true,
    id,
    proposal: proposal ? {
      ts: proposal.ts,
      source: proposal.source,
      additions: (proposal.additions || []).length
    } : null,
    trial: trial ? {
      ts: trial.ts,
      passed: (trial.passed_models || []).length,
      failed: (trial.failed_models || []).length
    } : null,
    handoff: handoff ? {
      status: handoff.status,
      apply_command: handoff.apply_command,
      rollback_command: handoff.rollback_command
    } : null
  }) + '\n');
}

function fail(code, error) {
  process.stdout.write(JSON.stringify({ ok: false, error }) + '\n');
  process.exit(code);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || '';

  // Startup failsafe: if a prior self-change was interrupted, auto-revert before any command logic.
  const rec = recoverIfInterrupted();
  if (rec && rec.recovered) {
    appendJsonl(AUDIT_PATH, {
      ts: nowIso(),
      type: 'auto_recover_applied',
      id: rec.id,
      target_path: rec.target_path,
      snapshot_path: rec.snapshot_path
    });
  }

  if (!cmd || args.help || cmd === 'help' || cmd === '--help') {
    usage();
    process.exit(0);
  }

  try {
    if (cmd === 'propose') return cmdPropose(args);
    if (cmd === 'trial') return cmdTrial(args);
    if (cmd === 'report') return cmdReport(args);
    if (cmd === 'review') return cmdReview(args);
    if (cmd === 'approve') return cmdApprove(args);
    if (cmd === 'reject') return cmdReject(args);
    if (cmd === 'apply') return cmdApply(args);
    fail(2, `unknown command: ${cmd}`);
  } catch (err) {
    fail(1, String(err && err.message ? err.message : err));
  }
}

main();
export {};
