#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const {
  loadSymbiosisCoherenceSignal,
  evaluateRecursionRequest
} = require('../../lib/symbiosis_coherence_signal');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.CONSTITUTION_GUARDIAN_POLICY_PATH
  ? path.resolve(process.env.CONSTITUTION_GUARDIAN_POLICY_PATH)
  : path.join(ROOT, 'config', 'constitution_guardian_policy.json');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/constitution_guardian.js init-genesis [--force=1|0]');
  console.log('  node systems/security/constitution_guardian.js propose-change --candidate-file=<path> --proposer-id=<id> --reason="..."');
  console.log('  node systems/security/constitution_guardian.js approve-change --proposal-id=<id> --approver-id=<id> --approval-note="..."');
  console.log('  node systems/security/constitution_guardian.js veto-change --proposal-id=<id> --veto-by=<id> --note="..."');
  console.log('  node systems/security/constitution_guardian.js run-gauntlet --proposal-id=<id> [--critical-failures=<n>] [--evidence="..."]');
  console.log('  node systems/security/constitution_guardian.js activate-change --proposal-id=<id> --approver-id=<id> --approval-note="..."');
  console.log('  node systems/security/constitution_guardian.js enforce-inheritance --actor=<id> --target=<workflow|branch|organ> --override=1|0 [--note="..."]');
  console.log('  node systems/security/constitution_guardian.js emergency-rollback --approver-id=<id> --approval-note="..." [--snapshot-id=<id>]');
  console.log('  node systems/security/constitution_guardian.js status');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq < 0) out[token.slice(2)] = true;
    else out[token.slice(2, eq)] = token.slice(eq + 1);
  }
  return out;
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function sha256File(filePath: string) {
  try {
    const body = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(body).digest('hex');
  } catch {
    return null;
  }
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    constitution_path: 'AGENT-CONSTITUTION.md',
    state_dir: 'state/security/constitution_guardian',
    veto_window_days: 14,
    min_approval_note_chars: 12,
    require_dual_approval: true,
    enforce_inheritance_lock: true,
    emergency_rollback_requires_approval: true,
    symbiosis_recursion_invariant: {
      enabled: true,
      shadow_only: true,
      signal_policy_path: 'config/symbiosis_coherence_policy.json'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 32) || '1.0',
    constitution_path: cleanText(src.constitution_path || base.constitution_path, 260) || base.constitution_path,
    state_dir: cleanText(src.state_dir || base.state_dir, 260) || base.state_dir,
    veto_window_days: clampInt(src.veto_window_days, 1, 180, base.veto_window_days),
    min_approval_note_chars: clampInt(src.min_approval_note_chars, 4, 200, base.min_approval_note_chars),
    require_dual_approval: src.require_dual_approval !== false,
    enforce_inheritance_lock: src.enforce_inheritance_lock !== false,
    emergency_rollback_requires_approval: src.emergency_rollback_requires_approval !== false,
    symbiosis_recursion_invariant: {
      enabled: !(src.symbiosis_recursion_invariant && src.symbiosis_recursion_invariant.enabled === false),
      shadow_only: src.symbiosis_recursion_invariant && src.symbiosis_recursion_invariant.shadow_only != null
        ? !!src.symbiosis_recursion_invariant.shadow_only
        : base.symbiosis_recursion_invariant.shadow_only === true,
      signal_policy_path: cleanText(
        src.symbiosis_recursion_invariant && src.symbiosis_recursion_invariant.signal_policy_path
          || base.symbiosis_recursion_invariant.signal_policy_path,
        260
      ) || base.symbiosis_recursion_invariant.signal_policy_path
    }
  };
}

function pathsForPolicy(policy: AnyObj) {
  const stateDir = path.isAbsolute(policy.state_dir) ? policy.state_dir : path.join(ROOT, policy.state_dir);
  return {
    state_dir: stateDir,
    genesis_path: path.join(stateDir, 'genesis.json'),
    proposals_dir: path.join(stateDir, 'proposals'),
    latest_path: path.join(stateDir, 'latest.json'),
    receipts_path: path.join(stateDir, 'receipts.jsonl'),
    versions_path: path.join(stateDir, 'versions.jsonl'),
    snapshots_dir: path.join(stateDir, 'snapshots'),
    alerts_path: path.join(stateDir, 'alerts.jsonl')
  };
}

function constitutionPath(policy: AnyObj) {
  return path.isAbsolute(policy.constitution_path)
    ? policy.constitution_path
    : path.join(ROOT, policy.constitution_path);
}

function readProposal(paths: AnyObj, proposalId: string) {
  const proposalPath = path.join(paths.proposals_dir, proposalId, 'proposal.json');
  return readJson(proposalPath, null);
}

function writeProposal(paths: AnyObj, proposalId: string, proposal: AnyObj) {
  const proposalDir = path.join(paths.proposals_dir, proposalId);
  ensureDir(proposalDir);
  writeJsonAtomic(path.join(proposalDir, 'proposal.json'), proposal);
}

function emit(paths: AnyObj, payload: AnyObj) {
  writeJsonAtomic(paths.latest_path, payload);
  appendJsonl(paths.receipts_path, payload);
}

function proposalTouchesRecursiveInvariant(proposal: AnyObj, candidatePath: string) {
  const reason = cleanText(proposal && proposal.reason || '', 1200).toLowerCase();
  const combinedText: string[] = [reason];
  try {
    if (candidatePath && fs.existsSync(candidatePath)) {
      const body = cleanText(fs.readFileSync(candidatePath, 'utf8'), 10_000).toLowerCase();
      combinedText.push(body);
    }
  } catch {
    // read failures should not break governance evaluation.
  }
  const hay = combinedText.join(' ');
  return /unbounded recursion|recursive self-improvement|recursion depth|symbiosis coherence|self-improvement depth|depth gating/.test(hay);
}

function cmdInitGenesis(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const constitution = constitutionPath(policy);
  const existing = readJson(paths.genesis_path, null);
  if (existing && toBool(args.force, false) !== true) {
    const out = { ok: true, type: 'constitution_genesis', existing: true, genesis: existing };
    emit(paths, { ts: nowIso(), ...out });
    process.stdout.write(`${JSON.stringify(out)}\n`);
    return;
  }
  const genesis = {
    type: 'constitution_genesis',
    ts: nowIso(),
    constitution_path: rel(constitution),
    constitution_sha256: sha256File(constitution),
    genesis_id: normalizeToken(`genesis_${Date.now().toString(36)}`, 80)
  };
  writeJsonAtomic(paths.genesis_path, genesis);
  emit(paths, { ts: nowIso(), type: 'constitution_genesis_initialized', genesis });
  process.stdout.write(`${JSON.stringify({ ok: true, type: 'constitution_genesis', genesis })}\n`);
}

function cmdProposeChange(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const candidateFileRaw = cleanText(args.candidate_file || args['candidate-file'] || '', 320);
  const proposerId = normalizeToken(args.proposer_id || args['proposer-id'] || '', 120);
  const reason = cleanText(args.reason || '', 400);
  if (!candidateFileRaw || !proposerId || !reason) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_propose_change', error: 'candidate_file_proposer_id_reason_required' })}\n`);
    process.exit(1);
  }
  const candidateFile = path.isAbsolute(candidateFileRaw) ? candidateFileRaw : path.join(ROOT, candidateFileRaw);
  if (!fs.existsSync(candidateFile)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_propose_change', error: 'candidate_file_missing' })}\n`);
    process.exit(1);
  }
  const proposalId = normalizeToken(args.proposal_id || args['proposal-id'] || `ccp_${Date.now().toString(36)}`, 120)
    || `ccp_${Date.now().toString(36)}`;
  const proposalDir = path.join(paths.proposals_dir, proposalId);
  ensureDir(proposalDir);
  const candidateCopy = path.join(proposalDir, 'candidate_constitution.md');
  fs.copyFileSync(candidateFile, candidateCopy);
  const proposal = {
    proposal_id: proposalId,
    ts: nowIso(),
    status: 'pending_approval',
    proposer_id: proposerId,
    reason,
    candidate_path: rel(candidateCopy),
    candidate_sha256: sha256File(candidateCopy),
    approvals: [],
    veto: null,
    gauntlet: null,
    activation: null
  };
  writeProposal(paths, proposalId, proposal);
  const out = { ok: true, type: 'constitution_propose_change', proposal_id: proposalId, status: proposal.status };
  emit(paths, { ts: nowIso(), ...out, proposal });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdApproveChange(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const proposalId = normalizeToken(args.proposal_id || args['proposal-id'] || '', 120);
  const approverId = normalizeToken(args.approver_id || args['approver-id'] || '', 120);
  const note = cleanText(args.approval_note || args['approval-note'] || '', 320);
  if (!proposalId || !approverId || note.length < policy.min_approval_note_chars) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_approve_change', error: 'proposal_id_approver_id_and_note_required' })}\n`);
    process.exit(1);
  }
  const proposal = readProposal(paths, proposalId);
  if (!proposal) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_approve_change', error: 'proposal_not_found' })}\n`);
    process.exit(1);
  }
  if (!Array.isArray(proposal.approvals)) proposal.approvals = [];
  if (!proposal.approvals.find((row: AnyObj) => String(row.approver_id || '') === approverId)) {
    proposal.approvals.push({ ts: nowIso(), approver_id: approverId, note });
  }
  if (policy.require_dual_approval) {
    const uniqueApprovers = Array.from(new Set(proposal.approvals.map((row: AnyObj) => String(row.approver_id || '')))).filter(Boolean);
    if (uniqueApprovers.length >= 2) {
      proposal.status = 'approved_pending_veto';
      proposal.activate_after = new Date(Date.now() + policy.veto_window_days * 24 * 60 * 60 * 1000).toISOString();
    }
  } else {
    proposal.status = 'approved_pending_veto';
    proposal.activate_after = new Date(Date.now() + policy.veto_window_days * 24 * 60 * 60 * 1000).toISOString();
  }
  writeProposal(paths, proposalId, proposal);
  const out = { ok: true, type: 'constitution_approve_change', proposal_id: proposalId, status: proposal.status, activate_after: proposal.activate_after || null };
  emit(paths, { ts: nowIso(), ...out });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdVetoChange(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const proposalId = normalizeToken(args.proposal_id || args['proposal-id'] || '', 120);
  const vetoBy = normalizeToken(args.veto_by || args['veto-by'] || '', 120);
  const note = cleanText(args.note || '', 320);
  if (!proposalId || !vetoBy || !note) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_veto_change', error: 'proposal_id_veto_by_note_required' })}\n`);
    process.exit(1);
  }
  const proposal = readProposal(paths, proposalId);
  if (!proposal) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_veto_change', error: 'proposal_not_found' })}\n`);
    process.exit(1);
  }
  proposal.veto = { ts: nowIso(), veto_by: vetoBy, note };
  proposal.status = 'vetoed';
  writeProposal(paths, proposalId, proposal);
  const out = { ok: true, type: 'constitution_veto_change', proposal_id: proposalId, status: proposal.status };
  emit(paths, { ts: nowIso(), ...out });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdRunGauntlet(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const proposalId = normalizeToken(args.proposal_id || args['proposal-id'] || '', 120);
  const criticalFailures = clampInt(args.critical_failures || args['critical-failures'], 0, 100000, 0);
  const evidence = cleanText(args.evidence || '', 320);
  if (!proposalId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_run_gauntlet', error: 'proposal_id_required' })}\n`);
    process.exit(1);
  }
  const proposal = readProposal(paths, proposalId);
  if (!proposal) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_run_gauntlet', error: 'proposal_not_found' })}\n`);
    process.exit(1);
  }
  proposal.gauntlet = {
    ts: nowIso(),
    critical_failures: criticalFailures,
    pass: criticalFailures === 0,
    evidence
  };
  if (criticalFailures > 0) proposal.status = 'gauntlet_failed';
  writeProposal(paths, proposalId, proposal);
  const out = { ok: true, type: 'constitution_run_gauntlet', proposal_id: proposalId, gauntlet: proposal.gauntlet, status: proposal.status };
  emit(paths, { ts: nowIso(), ...out });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdActivateChange(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const proposalId = normalizeToken(args.proposal_id || args['proposal-id'] || '', 120);
  const approverId = normalizeToken(args.approver_id || args['approver-id'] || '', 120);
  const note = cleanText(args.approval_note || args['approval-note'] || '', 320);
  if (!proposalId || !approverId || note.length < policy.min_approval_note_chars) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_activate_change', error: 'proposal_id_approver_id_note_required' })}\n`);
    process.exit(1);
  }
  const proposal = readProposal(paths, proposalId);
  if (!proposal) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_activate_change', error: 'proposal_not_found' })}\n`);
    process.exit(1);
  }
  if (proposal.status !== 'approved_pending_veto') {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_activate_change', error: 'proposal_not_approved_pending_veto' })}\n`);
    process.exit(1);
  }
  if (proposal.veto) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_activate_change', error: 'proposal_vetoed' })}\n`);
    process.exit(1);
  }
  const activateAfter = Date.parse(String(proposal.activate_after || ''));
  if (!Number.isFinite(activateAfter) || Date.now() < activateAfter) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_activate_change', error: 'veto_window_active', activate_after: proposal.activate_after || null })}\n`);
    process.exit(1);
  }
  if (!proposal.gauntlet || proposal.gauntlet.pass !== true) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_activate_change', error: 'gauntlet_not_passed' })}\n`);
    process.exit(1);
  }

  const candidatePath = path.isAbsolute(proposal.candidate_path)
    ? proposal.candidate_path
    : path.join(ROOT, proposal.candidate_path);
  const recursionInvariant = policy.symbiosis_recursion_invariant && typeof policy.symbiosis_recursion_invariant === 'object'
    ? policy.symbiosis_recursion_invariant
    : {};
  let symbiosisGate: AnyObj = {
    evaluated: false
  };
  if (recursionInvariant.enabled === true && proposalTouchesRecursiveInvariant(proposal, candidatePath)) {
    const signal = loadSymbiosisCoherenceSignal({
      policy_path: recursionInvariant.signal_policy_path,
      refresh: true,
      persist: true
    });
    const gate = evaluateRecursionRequest({
      signal,
      requested_depth: 'unbounded',
      require_unbounded: true,
      shadow_only_override: recursionInvariant.shadow_only === true
    });
    symbiosisGate = {
      evaluated: true,
      request: {
        requested_depth: 'unbounded',
        requested_unbounded: true
      },
      ...gate
    };
    if (gate.blocked_hard === true) {
      process.stdout.write(`${JSON.stringify({
        ok: false,
        type: 'constitution_activate_change',
        error: 'symbiosis_recursion_gate_blocked',
        symbiosis_recursion_gate: symbiosisGate
      })}\n`);
      process.exit(1);
    }
  }

  const constitution = constitutionPath(policy);
  const snapshotId = `snapshot_${Date.now().toString(36)}`;
  const snapshotPath = path.join(paths.snapshots_dir, `${snapshotId}.md`);
  ensureDir(path.dirname(snapshotPath));
  fs.copyFileSync(constitution, snapshotPath);

  fs.copyFileSync(candidatePath, constitution);

  proposal.status = 'activated';
  proposal.activation = {
    ts: nowIso(),
    activated_by: approverId,
    approval_note: note,
    snapshot_id: snapshotId,
    snapshot_path: rel(snapshotPath),
    active_constitution_sha256: sha256File(constitution)
  };
  writeProposal(paths, proposalId, proposal);
  appendJsonl(paths.versions_path, {
    ts: nowIso(),
    type: 'constitution_version_activated',
    proposal_id: proposalId,
    snapshot_id: snapshotId,
    constitution_sha256: proposal.activation.active_constitution_sha256
  });
  const out = {
    ok: true,
    type: 'constitution_activate_change',
    proposal_id: proposalId,
    status: proposal.status,
    activation: proposal.activation
    ,
    symbiosis_recursion_gate: symbiosisGate
  };
  emit(paths, { ts: nowIso(), ...out });
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdEnforceInheritance(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const actor = normalizeToken(args.actor || '', 120);
  const target = normalizeToken(args.target || 'workflow', 64);
  const override = toBool(args.override, false);
  const note = cleanText(args.note || '', 320);
  const blocked = policy.enforce_inheritance_lock === true && override === true;
  const out = {
    ok: !blocked,
    type: 'constitution_inheritance_enforce',
    ts: nowIso(),
    actor,
    target,
    override_attempted: override,
    blocked,
    reason: blocked ? 'fractal_inheritance_lock_blocked_override' : 'clear'
  };
  if (blocked) {
    appendJsonl(paths.alerts_path, {
      ts: nowIso(),
      type: 'constitution_inheritance_pain_signal',
      actor,
      target,
      note,
      severity: 'critical'
    });
  }
  emit(paths, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (blocked) process.exit(1);
}

function cmdEmergencyRollback(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const approverId = normalizeToken(args.approver_id || args['approver-id'] || '', 120);
  const note = cleanText(args.approval_note || args['approval-note'] || '', 320);
  if (policy.emergency_rollback_requires_approval && (!approverId || note.length < policy.min_approval_note_chars)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_emergency_rollback', error: 'approval_required' })}\n`);
    process.exit(1);
  }
  const snapshots = fs.existsSync(paths.snapshots_dir)
    ? fs.readdirSync(paths.snapshots_dir)
      .filter((row: string) => row.endsWith('.md'))
      .sort()
    : [];
  if (!snapshots.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_emergency_rollback', error: 'no_snapshot_available' })}\n`);
    process.exit(1);
  }
  const requested = normalizeToken(args.snapshot_id || args['snapshot-id'] || '', 120);
  const selectedFile = requested
    ? `${requested}.md`
    : snapshots[snapshots.length - 1];
  if (!snapshots.includes(selectedFile)) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'constitution_emergency_rollback', error: 'snapshot_not_found' })}\n`);
    process.exit(1);
  }
  const constitution = constitutionPath(policy);
  const snapshotPath = path.join(paths.snapshots_dir, selectedFile);
  fs.copyFileSync(snapshotPath, constitution);
  const out = {
    ok: true,
    type: 'constitution_emergency_rollback',
    ts: nowIso(),
    approver_id: approverId || null,
    snapshot_id: selectedFile.replace(/\.md$/i, ''),
    constitution_sha256: sha256File(constitution)
  };
  emit(paths, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const paths = pathsForPolicy(policy);
  const latest = readJson(paths.latest_path, null);
  const genesis = readJson(paths.genesis_path, null);
  const out = {
    ok: true,
    type: 'constitution_guardian_status',
    ts: nowIso(),
    policy_version: policy.version,
    constitution_path: policy.constitution_path,
    constitution_sha256: sha256File(constitutionPath(policy)),
    genesis,
    latest,
    state_dir: paths.state_dir
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'init-genesis') return cmdInitGenesis(args);
  if (cmd === 'propose-change') return cmdProposeChange(args);
  if (cmd === 'approve-change') return cmdApproveChange(args);
  if (cmd === 'veto-change') return cmdVetoChange(args);
  if (cmd === 'run-gauntlet') return cmdRunGauntlet(args);
  if (cmd === 'activate-change') return cmdActivateChange(args);
  if (cmd === 'enforce-inheritance') return cmdEnforceInheritance(args);
  if (cmd === 'emergency-rollback') return cmdEmergencyRollback(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
