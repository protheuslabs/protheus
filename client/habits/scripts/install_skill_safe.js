#!/usr/bin/env node
/**
 * client/habits/scripts/install_skill_safe.js
 *
 * Safe wrapper for skill installation:
 * - Policy-gated spec validation (client/systems/security/skill_quarantine.js)
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
  console.log('  node client/habits/scripts/install_skill_safe.js --spec "<source>" [--approve=1 --approval_note "..."] [--autonomous=1 --justification-file <file>|--justification-json "<json>"] [--dry-run]');
  console.log('');
  console.log('Examples:');
  console.log('  node client/habits/scripts/install_skill_safe.js --spec "github:org/repo/skill" --dry-run');
  console.log('  node client/habits/scripts/install_skill_safe.js --spec "github:org/repo/skill" --approve=1 --approval_note "Reviewed manifest + risky markers"');
  console.log('  node client/habits/scripts/install_skill_safe.js --spec "github:org/repo/skill" --autonomous=1 --justification-file "./state/autonomy/skill_justification.json" --dry-run');
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

function normalizePolicyArray(v) {
  if (!Array.isArray(v)) return [];
  return Array.from(new Set(v.map(x => String(x || '').trim().toLowerCase()).filter(Boolean)));
}

function loadNecessityGatePolicy(policy) {
  const src = (policy && policy.autonomous_necessity_gate && typeof policy.autonomous_necessity_gate === 'object')
    ? policy.autonomous_necessity_gate
    : {};
  return {
    enabled: src.enabled !== false,
    enforce_for_autonomous: src.enforce_for_autonomous !== false,
    enforce_for_manual: src.enforce_for_manual === true,
    min_problem_len: Number(src.min_problem_len || 12),
    min_gap_len: Number(src.min_gap_len || 12),
    min_repeat_frequency: Number(src.min_repeat_frequency || 3),
    min_expected_savings: Number(src.min_expected_savings || 20),
    min_necessity_score: Number(src.min_necessity_score || 70),
    allowed_risk_classes: normalizePolicyArray(src.allowed_risk_classes || ['low', 'medium', 'high']),
    novelty_terms: normalizePolicyArray(src.novelty_terms || ['cool', 'interesting', 'fun', 'hype', 'experiment']),
    operational_terms: normalizePolicyArray(src.operational_terms || [
      'repeated', 'daily', 'workflow', 'blocked', 'failure', 'error', 'latency',
      'token', 'time', 'cost', 'throughput', 'security', 'compliance', 'revenue'
    ])
  };
}

function toPositiveNumber(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function loadJustificationPayload() {
  const fromJson = String(parseArg('justification-json', '') || '').trim();
  const fromFile = String(parseArg('justification-file', '') || '').trim();
  let obj = null;

  if (fromJson) {
    try {
      obj = JSON.parse(fromJson);
    } catch {
      return { provided: true, parsed: null, parse_error: 'invalid_justification_json' };
    }
  } else if (fromFile) {
    const abs = path.resolve(REPO_ROOT, fromFile);
    try {
      obj = JSON.parse(fs.readFileSync(abs, 'utf8'));
    } catch {
      return { provided: true, parsed: null, parse_error: 'invalid_justification_file' };
    }
  } else {
    const problem = String(parseArg('problem', '') || '').trim();
    const repeat = String(parseArg('repeat-frequency', '') || parseArg('repeat_frequency', '') || '').trim();
    const savings = String(parseArg('expected-savings', '') || parseArg('expected_savings', '') || '').trim();
    const gap = String(parseArg('gap', '') || parseArg('why-existing-insufficient', '') || parseArg('why_existing_insufficient', '') || '').trim();
    const riskClass = String(parseArg('risk-class', '') || parseArg('risk_class', '') || '').trim();
    if (problem || repeat || savings || gap || riskClass) {
      obj = {
        problem,
        repeat_frequency: repeat,
        expected_time_or_token_savings: savings,
        why_existing_habits_or_skills_insufficient: gap,
        risk_class: riskClass
      };
    }
  }

  if (!obj || typeof obj !== 'object') return { provided: false, parsed: null, parse_error: null };
  const parsed = {
    problem: String(obj.problem || '').trim(),
    repeat_frequency: toPositiveNumber(obj.repeat_frequency),
    expected_time_or_token_savings: toPositiveNumber(
      obj.expected_time_or_token_savings != null ? obj.expected_time_or_token_savings : obj.expected_savings
    ),
    why_existing_habits_or_skills_insufficient: String(
      obj.why_existing_habits_or_skills_insufficient != null
        ? obj.why_existing_habits_or_skills_insufficient
        : (obj.gap || obj.why_existing_insufficient || '')
    ).trim(),
    risk_class: String(obj.risk_class || '').trim().toLowerCase()
  };
  return { provided: true, parsed, parse_error: null };
}

function countTermHits(text, terms) {
  const lower = String(text || '').toLowerCase();
  let hits = 0;
  for (const term of terms || []) {
    if (term && lower.includes(term)) hits += 1;
  }
  return hits;
}

function evaluateNecessity(justification, gatePolicy) {
  const reasons = [];
  let score = 0;
  const j = justification && typeof justification === 'object' ? justification : {};
  const problem = String(j.problem || '').trim();
  const gap = String(j.why_existing_habits_or_skills_insufficient || '').trim();
  const repeat = Number(j.repeat_frequency);
  const savings = Number(j.expected_time_or_token_savings);
  const riskClass = String(j.risk_class || '').trim().toLowerCase();

  if (problem.length >= gatePolicy.min_problem_len) score += 25;
  else reasons.push('problem_too_short');

  if (Number.isFinite(repeat) && repeat >= gatePolicy.min_repeat_frequency) score += 20;
  else reasons.push('repeat_frequency_below_min');

  if (Number.isFinite(savings) && savings >= gatePolicy.min_expected_savings) score += 20;
  else reasons.push('expected_savings_below_min');

  if (gap.length >= gatePolicy.min_gap_len) score += 25;
  else reasons.push('insufficiency_gap_too_short');

  if (riskClass && gatePolicy.allowed_risk_classes.includes(riskClass)) score += 10;
  else reasons.push('risk_class_invalid');

  const combined = `${problem} ${gap}`;
  const noveltyHits = countTermHits(combined, gatePolicy.novelty_terms);
  const operationalHits = countTermHits(combined, gatePolicy.operational_terms);
  if (noveltyHits > 0 && operationalHits === 0) reasons.push('novelty_only_reasoning');

  const allowed = reasons.length === 0 && score >= gatePolicy.min_necessity_score;
  return {
    allowed,
    score,
    min_score: gatePolicy.min_necessity_score,
    reasons,
    novelty_hits: noveltyHits,
    operational_hits: operationalHits,
    normalized: {
      problem,
      repeat_frequency: Number.isFinite(repeat) ? repeat : null,
      expected_time_or_token_savings: Number.isFinite(savings) ? savings : null,
      why_existing_habits_or_skills_insufficient: gap,
      risk_class: riskClass || null
    }
  };
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
  const autonomous = String(parseArg('autonomous', hasFlag('autonomous') ? '1' : '0')) === '1';
  const approve = String(parseArg('approve', hasFlag('approve') ? '1' : '0')) === '1';
  const approvalNote = String(parseArg('approval_note', '') || '').trim();
  const policy = loadPolicy();
  const necessityGate = loadNecessityGatePolicy(policy);
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

  const enforceNecessity = necessityGate.enabled
    && ((autonomous && necessityGate.enforce_for_autonomous) || (!autonomous && necessityGate.enforce_for_manual));
  const justificationInput = loadJustificationPayload();
  let necessityEvaluation = null;
  if (enforceNecessity) {
    if (!justificationInput.provided || justificationInput.parse_error) {
      const out = {
        ok: false,
        decision: 'blocked_necessity',
        receipt_id: receiptId,
        reason: justificationInput.parse_error || 'missing_justification',
        required_fields: [
          'problem',
          'repeat_frequency',
          'expected_time_or_token_savings',
          'why_existing_habits_or_skills_insufficient',
          'risk_class'
        ],
        ts: nowIso()
      };
      appendReceipt(receiptPath, {
        ts: nowIso(),
        type: 'skill_install_receipt',
        receipt_id: receiptId,
        decision: 'blocked_necessity',
        spec: specCheck.spec,
        autonomous,
        reason: out.reason,
        necessity_gate: {
          enabled: true,
          min_necessity_score: necessityGate.min_necessity_score
        }
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      process.exit(1);
    }
    necessityEvaluation = evaluateNecessity(justificationInput.parsed, necessityGate);
    if (!necessityEvaluation.allowed) {
      const out = {
        ok: false,
        decision: 'blocked_necessity',
        receipt_id: receiptId,
        spec: specCheck.spec,
        autonomous,
        necessity: necessityEvaluation,
        ts: nowIso()
      };
      appendReceipt(receiptPath, {
        ts: nowIso(),
        type: 'skill_install_receipt',
        receipt_id: receiptId,
        decision: 'blocked_necessity',
        spec: specCheck.spec,
        autonomous,
        necessity: necessityEvaluation
      });
      process.stdout.write(JSON.stringify(out) + '\n');
      process.exit(1);
    }
  } else if (justificationInput.provided && !justificationInput.parse_error) {
    necessityEvaluation = evaluateNecessity(justificationInput.parsed, necessityGate);
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
      autonomous,
      necessity: necessityEvaluation,
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
      autonomous,
      necessity: necessityEvaluation,
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
      autonomous,
      necessity: necessityEvaluation,
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
      trust_candidates: trustCandidates,
      autonomous,
      necessity: necessityEvaluation
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
      autonomous,
      necessity: necessityEvaluation,
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
      risky_markers: riskyMarkers,
      autonomous,
      necessity: necessityEvaluation
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
    autonomous,
    necessity: necessityEvaluation,
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
    autonomous,
    necessity: necessityEvaluation,
    ts: nowIso()
  };
  process.stdout.write(JSON.stringify(out) + '\n');
  process.exit(success ? 0 : 1);
}

if (require.main === module) main();
