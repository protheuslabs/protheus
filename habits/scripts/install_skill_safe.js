#!/usr/bin/env node
/**
 * habits/scripts/install_skill_safe.js
 *
 * Safe wrapper for skill installation:
 * - Policy-gated spec validation (systems/security/skill_quarantine.js)
 * - Post-install verification (manifest + risky marker scan + hash tree)
 * - Explicit approval gate for risky/unknown installs
 * - Hash pinning into trusted_skills.json via trust_add.js
 * - Deterministic receipt logging
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { loadPolicy, inspectSpec, verifyPath } = require('../../systems/security/skill_quarantine.js');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TRUST_ADD_PATH = path.join(REPO_ROOT, 'memory', 'tools', 'trust_add.js');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node habits/scripts/install_skill_safe.js --spec "<source>" [--approve=1 --approval_note "..."] [--dry-run]');
  console.log('');
  console.log('Examples:');
  console.log('  node habits/scripts/install_skill_safe.js --spec "github:org/repo/skill" --dry-run');
  console.log('  node habits/scripts/install_skill_safe.js --spec "github:org/repo/skill" --approve=1 --approval_note "Reviewed manifest + risky markers"');
}

function parseArg(name, fallback = null) {
  const pref = `--${name}=`;
  const eq = process.argv.find(a => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const nxt = process.argv[idx + 1];
    if (!String(nxt).startsWith('--')) return nxt;
    return '';
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`) || process.argv.includes(name);
}

function compactResult(res, cap = 240) {
  const t = (x) => {
    const s = String(x || '');
    return s.length <= cap ? s : `${s.slice(0, cap)}...`;
  };
  if (!res) return null;
  return {
    ok: !!res.ok,
    code: Number(res.code || 0),
    stdout: t(res.stdout),
    stderr: t(res.stderr)
  };
}

function appendReceipt(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function listSkillDirs(rootPath) {
  if (!fs.existsSync(rootPath)) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(rootPath, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(e => e.isDirectory() && !e.isSymbolicLink())
    .map(e => path.join(rootPath, e.name))
    .sort();
}

function diffPaths(before, after) {
  const b = new Set(before.map(x => path.resolve(x)));
  return after.filter(x => !b.has(path.resolve(x))).sort();
}

function runCmd(cmd, args, cwd = REPO_ROOT) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return {
    ok: r.status === 0,
    code: r.status == null ? 1 : r.status,
    stdout: String(r.stdout || '').trim(),
    stderr: String(r.stderr || '').trim()
  };
}

function trustFiles(files, note) {
  const outcomes = [];
  for (const relFile of files) {
    const absFile = path.resolve(REPO_ROOT, relFile);
    const res = runCmd(process.execPath, [TRUST_ADD_PATH, absFile, note], REPO_ROOT);
    outcomes.push({
      file: relFile,
      result: compactResult(res)
    });
  }
  return outcomes;
}

function uniqueSorted(arr) {
  return Array.from(new Set((arr || []).map(x => String(x || '').trim()).filter(Boolean))).sort();
}

function main() {
  const first = process.argv[2] || '';
  if (!first || first === '--help' || first === '-h' || first === 'help' || hasFlag('help')) {
    usage();
    process.exit(0);
  }
  const cmd = first === 'install' ? 'install' : (String(first).startsWith('--') ? 'install' : first);
  if (cmd !== 'install') {
    usage();
    process.exit(2);
  }

  const spec = String(parseArg('spec', '') || '').trim();
  if (!spec) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'missing --spec', ts: nowIso() }) + '\n');
    process.exit(2);
  }

  const dryRun = hasFlag('dry-run');
  const approve = String(parseArg('approve', hasFlag('approve') ? '1' : '0')) === '1';
  const approvalNote = String(parseArg('approval_note', '') || '').trim();
  const policy = loadPolicy();
  const installRoot = path.resolve(String(policy.install_root || path.join(REPO_ROOT, 'skills')));
  const receiptDir = path.resolve(String(policy.receipt_dir || path.join(REPO_ROOT, 'state', 'security', 'skill_quarantine', 'install_receipts')));
  const receiptPath = path.join(receiptDir, `${nowIso().slice(0, 10)}.jsonl`);
  const receiptId = `skill_install_${Date.now()}`;

  const specCheck = inspectSpec(spec, policy);
  if (!specCheck.allowed) {
    const out = {
      ok: false,
      decision: 'blocked_spec',
      receipt_id: receiptId,
      reasons: specCheck.reasons,
      spec: specCheck.spec,
      ts: nowIso()
    };
    appendReceipt(receiptPath, {
      ts: nowIso(),
      type: 'skill_install_receipt',
      receipt_id: receiptId,
      decision: 'blocked_spec',
      spec: specCheck.spec,
      spec_inspection: specCheck
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(1);
  }

  const installCmd = Array.isArray(policy.install_command) && policy.install_command.length >= 2
    ? policy.install_command
    : ['npx', 'molthub', 'install'];
  const plannedCommand = {
    cmd: installCmd[0],
    args: [...installCmd.slice(1), spec]
  };

  const beforeDirs = listSkillDirs(installRoot);
  let installResult = { ok: true, code: 0, stdout: 'dry_run', stderr: '' };

  if (!dryRun) {
    installResult = runCmd(plannedCommand.cmd, plannedCommand.args, REPO_ROOT);
    if (!installResult.ok) {
      appendReceipt(receiptPath, {
        ts: nowIso(),
        type: 'skill_install_receipt',
        receipt_id: receiptId,
        decision: 'install_failed',
        spec: specCheck.spec,
        command: plannedCommand,
        install_result: compactResult(installResult),
        spec_inspection: specCheck
      });
      process.stdout.write(JSON.stringify({
        ok: false,
        decision: 'install_failed',
        receipt_id: receiptId,
        install_result: compactResult(installResult),
        ts: nowIso()
      }) + '\n');
      process.exit(1);
    }
  }

  const afterDirs = listSkillDirs(installRoot);
  const discovered = diffPaths(beforeDirs, afterDirs)
    .map(p => path.relative(REPO_ROOT, p).replace(/\\/g, '/'));
  const explicitPath = String(parseArg('path', '') || '').trim();
  const targets = uniqueSorted([
    ...discovered,
    ...(explicitPath ? [explicitPath] : [])
  ]);

  if (!targets.length && dryRun) {
    const out = {
      ok: true,
      decision: 'dry_run_plan',
      receipt_id: receiptId,
      spec: specCheck.spec,
      command: plannedCommand,
      requires_target_hint: true,
      hint: 'If installer updates existing directory, pass --path <skill_dir_or_file> for verification planning.',
      ts: nowIso()
    };
    appendReceipt(receiptPath, {
      ts: nowIso(),
      type: 'skill_install_receipt',
      receipt_id: receiptId,
      decision: 'dry_run_plan',
      dry_run: true,
      spec: specCheck.spec,
      command: plannedCommand,
      requires_target_hint: true
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }

  if (!targets.length) {
    appendReceipt(receiptPath, {
      ts: nowIso(),
      type: 'skill_install_receipt',
      receipt_id: receiptId,
      decision: 'no_targets_detected',
      spec: specCheck.spec,
      command: plannedCommand,
      install_result: compactResult(installResult),
      spec_inspection: specCheck
    });
    process.stdout.write(JSON.stringify({
      ok: false,
      decision: 'no_targets_detected',
      receipt_id: receiptId,
      hint: 'Pass --path <skill_dir_or_file> when installer updates existing directory.',
      ts: nowIso()
    }) + '\n');
    process.exit(1);
  }

  const verifications = targets.map(t => verifyPath(path.resolve(REPO_ROOT, t), policy));
  const requiresApproval = verifications.some(v => v.requires_approval);
  const approvalReasons = uniqueSorted(verifications.flatMap(v => v.approval_reasons || []));
  const riskyMarkers = uniqueSorted(verifications.flatMap(v => v.risky_markers || []));
  const trustCandidates = uniqueSorted(verifications.flatMap(v => v.trust_candidates || []));

  if (dryRun) {
    const out = {
      ok: true,
      decision: requiresApproval ? 'approval_required' : 'ready_to_trust',
      receipt_id: receiptId,
      spec: specCheck.spec,
      command: plannedCommand,
      targets,
      requires_approval: requiresApproval,
      approval_reasons: approvalReasons,
      risky_markers: riskyMarkers,
      trust_candidates: trustCandidates,
      ts: nowIso()
    };
    appendReceipt(receiptPath, {
      ts: nowIso(),
      type: 'skill_install_receipt',
      receipt_id: receiptId,
      decision: out.decision,
      dry_run: true,
      spec: specCheck.spec,
      command: plannedCommand,
      targets,
      verifications,
      requires_approval: requiresApproval,
      approval_reasons: approvalReasons,
      risky_markers: riskyMarkers,
      trust_candidates: trustCandidates
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }

  if (requiresApproval && (!approve || approvalNote.length < 10)) {
    const out = {
      ok: true,
      decision: 'approval_required',
      receipt_id: receiptId,
      spec: specCheck.spec,
      targets,
      requires_approval: true,
      approval_reasons: approvalReasons,
      risky_markers: riskyMarkers,
      approval_note_min_len: 10,
      ts: nowIso()
    };
    appendReceipt(receiptPath, {
      ts: nowIso(),
      type: 'skill_install_receipt',
      receipt_id: receiptId,
      decision: 'approval_required',
      spec: specCheck.spec,
      command: plannedCommand,
      install_result: compactResult(installResult),
      targets,
      verifications,
      requires_approval: true,
      approval_reasons: approvalReasons,
      risky_markers: riskyMarkers
    });
    process.stdout.write(JSON.stringify(out) + '\n');
    process.exit(0);
  }

  const note = approvalNote || `safe install: ${specCheck.spec}`;
  const trustResults = trustFiles(trustCandidates, note);
  const trustFailures = trustResults.filter(x => !x.result.ok);
  const success = trustFailures.length === 0;

  const decision = success ? 'installed_and_trusted' : 'trust_failed';
  appendReceipt(receiptPath, {
    ts: nowIso(),
    type: 'skill_install_receipt',
    receipt_id: receiptId,
    decision,
    spec: specCheck.spec,
    command: plannedCommand,
    install_result: compactResult(installResult),
    targets,
    verifications,
    requires_approval: requiresApproval,
    approval_reasons: approvalReasons,
    risky_markers: riskyMarkers,
    approved: approve,
    approval_note: note.slice(0, 200),
    trust_candidates: trustCandidates,
    trust_results: trustResults
  });

  const out = {
    ok: success,
    decision,
    receipt_id: receiptId,
    spec: specCheck.spec,
    targets,
    trusted_files: trustResults.filter(x => x.result.ok).map(x => x.file),
    trust_failed_files: trustFailures.map(x => ({ file: x.file, result: x.result })),
    requires_approval: requiresApproval,
    approval_reasons: approvalReasons,
    risky_markers: riskyMarkers,
    ts: nowIso()
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(success ? 0 : 1);
}

if (require.main === module) main();
