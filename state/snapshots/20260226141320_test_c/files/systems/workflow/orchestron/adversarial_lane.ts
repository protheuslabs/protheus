#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const {
  clampInt,
  clampNumber,
  cleanText,
  nowIso
} = require('./contracts');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const ORCHESTRON_OUT_DIR = process.env.ORCHESTRON_OUT_DIR
  ? path.resolve(process.env.ORCHESTRON_OUT_DIR)
  : path.join(REPO_ROOT, 'state', 'adaptive', 'workflows', 'orchestron');
const DEFAULT_OUT_DIR = process.env.ORCHESTRON_ADVERSARIAL_OUT_DIR
  ? path.resolve(process.env.ORCHESTRON_ADVERSARIAL_OUT_DIR)
  : path.join(ORCHESTRON_OUT_DIR, 'adversarial');

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath, value) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function relPath(filePath) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function normalizePolicy(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const allowlist = Array.isArray(src.unresolved_placeholder_allowlist)
    ? src.unresolved_placeholder_allowlist
    : ['date', 'run_id', 'workflow_id', 'objective_id', 'eye_id', 'adapter'];
  return {
    enabled: src.enabled !== false,
    max_critical_failures_per_candidate: clampInt(src.max_critical_failures_per_candidate, 0, 32, 0),
    max_non_critical_findings_per_candidate: clampInt(src.max_non_critical_findings_per_candidate, 0, 64, 8),
    max_findings_per_candidate: clampInt(src.max_findings_per_candidate, 1, 128, 24),
    block_unresolved_placeholders: src.block_unresolved_placeholders !== false,
    high_power_requires_preflight: src.high_power_requires_preflight !== false,
    high_power_requires_rollback: src.high_power_requires_rollback === true,
    persist_replay_artifacts: src.persist_replay_artifacts !== false,
    unresolved_placeholder_allowlist: allowlist
      .map((row) => String(row || '').trim().toLowerCase())
      .filter(Boolean)
      .slice(0, 32)
  };
}

function flattenCandidateTree(candidates, maxDepth = 6) {
  const out = [];
  const queue = [];
  for (const row of Array.isArray(candidates) ? candidates : []) {
    if (!row || typeof row !== 'object') continue;
    queue.push({
      candidate: row,
      parent_candidate_id: row.parent_workflow_id || null,
      depth: Number(row.fractal_depth || 0)
    });
  }
  while (queue.length) {
    const current = queue.shift();
    if (!current || !current.candidate || typeof current.candidate !== 'object') continue;
    const depth = Number(current.depth || 0);
    out.push({
      candidate: current.candidate,
      parent_candidate_id: current.parent_candidate_id || null,
      depth
    });
    if (depth >= Number(maxDepth || 6)) continue;
    const children = Array.isArray(current.candidate.children) ? current.candidate.children : [];
    for (const child of children) {
      if (!child || typeof child !== 'object') continue;
      queue.push({
        candidate: child,
        parent_candidate_id: current.candidate.id || current.parent_candidate_id || null,
        depth: depth + 1
      });
    }
  }
  return out;
}

function isHighPowerCandidate(candidate) {
  const proposalType = String(candidate && candidate.trigger && candidate.trigger.proposal_type || '').toLowerCase();
  if (!proposalType) return false;
  return proposalType.includes('actuation')
    || proposalType.includes('publish')
    || proposalType.includes('payment')
    || proposalType.includes('browser')
    || proposalType.includes('computer');
}

function extractPlaceholders(command) {
  const out = [];
  const text = String(command || '');
  const re = /<([a-zA-Z0-9_:-]+)>/g;
  let m;
  while ((m = re.exec(text))) {
    const token = String(m[1] || '').trim().toLowerCase();
    if (!token) continue;
    out.push(token);
  }
  return out;
}

function hasRollbackStep(candidate) {
  const steps = Array.isArray(candidate && candidate.steps) ? candidate.steps : [];
  return steps.some((row) => String(row && row.id || '').toLowerCase().includes('rollback'));
}

function hasPreflightStep(candidate) {
  const steps = Array.isArray(candidate && candidate.steps) ? candidate.steps : [];
  return steps.some((row) => String(row && row.id || '').toLowerCase() === 'preflight');
}

function hasGateStep(candidate) {
  const steps = Array.isArray(candidate && candidate.steps) ? candidate.steps : [];
  return steps.some((row) => String(row && row.type || '').toLowerCase() === 'gate');
}

function hasReceiptStep(candidate) {
  const steps = Array.isArray(candidate && candidate.steps) ? candidate.steps : [];
  return steps.some((row) => String(row && row.type || '').toLowerCase() === 'receipt');
}

function pushFinding(target, severity, code, message, details = {}) {
  target.push({
    severity: String(severity || 'non_critical') === 'critical' ? 'critical' : 'non_critical',
    code: cleanText(code || 'finding', 80),
    message: cleanText(message || '', 220),
    details: details && typeof details === 'object' ? details : {}
  });
}

function probeCandidate(entry, policy) {
  const candidate = entry && entry.candidate && typeof entry.candidate === 'object' ? entry.candidate : {};
  const candidateId = String(candidate.id || '').trim();
  const proposalType = String(candidate && candidate.trigger && candidate.trigger.proposal_type || 'unknown').trim().toLowerCase() || 'unknown';
  const steps = Array.isArray(candidate.steps) ? candidate.steps : [];
  const findings = [];
  const hasPreflight = hasPreflightStep(candidate);
  const hasRollback = hasRollbackStep(candidate);

  if (!candidateId) {
    pushFinding(findings, 'critical', 'candidate_id_missing', 'Candidate is missing id and cannot be traced.');
  }
  if (!steps.length) {
    pushFinding(findings, 'critical', 'candidate_steps_missing', 'Candidate has no executable steps.');
  }
  if (!hasGateStep(candidate)) {
    pushFinding(findings, 'critical', 'gate_step_missing', 'Candidate has no gate step for safety verification.');
  }
  if (!hasReceiptStep(candidate)) {
    pushFinding(findings, 'critical', 'receipt_step_missing', 'Candidate has no receipt step for evidence capture.');
  }
  if (isHighPowerCandidate(candidate) && policy.high_power_requires_preflight && !hasPreflight) {
    pushFinding(findings, 'critical', 'preflight_step_missing_high_power', 'High-power candidate is missing preflight guard.');
  }
  if (isHighPowerCandidate(candidate) && policy.high_power_requires_rollback && !hasRollback) {
    pushFinding(findings, 'critical', 'rollback_step_missing_high_power', 'High-power candidate is missing rollback path.');
  }

  for (const step of steps) {
    const stepId = String(step && step.id || '').trim() || null;
    const stepType = String(step && step.type || '').trim().toLowerCase();
    const command = String(step && step.command || '');
    const commandLc = command.toLowerCase();
    if (stepType === 'command' && !String(command || '').trim()) {
      pushFinding(findings, 'critical', 'command_step_empty', 'Command step has no command text.', { step_id: stepId });
      continue;
    }
    if (stepType !== 'command') continue;

    if (/[;&`]/.test(command) || command.includes('&&') || command.includes('||') || command.includes('$(')) {
      pushFinding(findings, 'critical', 'shell_injection_surface', 'Command contains unsafe shell chain characters.', {
        step_id: stepId,
        command_preview: cleanText(command, 180)
      });
    }

    if ((commandLc.includes('actuation_executor') || commandLc.includes('payment') || commandLc.includes('publish')) && !commandLc.includes('--dry-run')) {
      pushFinding(findings, 'non_critical', 'high_power_without_dry_run', 'High-power command is missing explicit --dry-run safety flag.', {
        step_id: stepId
      });
    }

    const placeholders = extractPlaceholders(command);
    for (const token of placeholders) {
      const allowed = policy.unresolved_placeholder_allowlist.includes(token);
      if (!allowed && policy.block_unresolved_placeholders) {
        pushFinding(findings, 'critical', 'placeholder_unapproved', `Placeholder <${token}> is not in allowlist.`, {
          step_id: stepId,
          placeholder: token
        });
      } else if (allowed && token !== 'date') {
        pushFinding(findings, 'non_critical', 'placeholder_runtime_binding_required', `Placeholder <${token}> requires runtime binding evidence.`, {
          step_id: stepId,
          placeholder: token
        });
      }
    }

    const timeoutMs = Number(step && step.timeout_ms || 0);
    if (timeoutMs > (4 * 60 * 1000)) {
      pushFinding(findings, 'non_critical', 'timeout_budget_high', 'Command timeout exceeds recommended 4 minute bound.', {
        step_id: stepId,
        timeout_ms: timeoutMs
      });
    }
  }

  const limited = findings.slice(0, policy.max_findings_per_candidate);
  const critical = limited.filter((row) => row && row.severity === 'critical').length;
  const nonCritical = limited.filter((row) => row && row.severity !== 'critical').length;
  const pass = critical <= policy.max_critical_failures_per_candidate
    && nonCritical <= policy.max_non_critical_findings_per_candidate;

  return {
    candidate_id: candidateId,
    parent_candidate_id: entry && entry.parent_candidate_id ? String(entry.parent_candidate_id) : null,
    depth: Number(entry && entry.depth || candidate && candidate.fractal_depth || 0),
    proposal_type: proposalType,
    pass,
    critical_failures: critical,
    non_critical_findings: nonCritical,
    total_findings: limited.length,
    findings: limited
  };
}

function runAdversarialLane(input) {
  const src = input && typeof input === 'object' ? input : {};
  const policy = normalizePolicy(src.policy);
  const date = cleanText(src.date || nowIso().slice(0, 10), 20);
  const runId = cleanText(src.run_id || '', 80) || null;
  const maxDepth = clampInt(src.max_depth, 1, 8, 6);
  const flattened = flattenCandidateTree(src.candidates, maxDepth);
  if (policy.enabled !== true) {
    return {
      ok: true,
      type: 'orchestron_adversarial_lane',
      ts: nowIso(),
      date,
      run_id: runId,
      policy,
      total_candidates: flattened.length,
      probes_run: 0,
      candidates_failed: 0,
      critical_failures: 0,
      non_critical_findings: 0,
      results: []
    };
  }

  const results = [];
  for (const row of flattened) {
    results.push(probeCandidate(row, policy));
  }

  const outDir = src.out_dir
    ? path.resolve(String(src.out_dir))
    : DEFAULT_OUT_DIR;
  if (policy.persist_replay_artifacts) {
    for (const row of results) {
      const candidateId = String(row && row.candidate_id || '').trim();
      if (!candidateId) continue;
      const artifactPath = path.join(outDir, date, `${candidateId}.json`);
      const entry = flattened.find((r) => String(r && r.candidate && r.candidate.id || '') === candidateId) || null;
      writeJsonAtomic(artifactPath, {
        ok: true,
        type: 'orchestron_adversarial_probe',
        ts: nowIso(),
        run_id: runId,
        date,
        candidate_id: candidateId,
        proposal_type: row.proposal_type || null,
        pass: row.pass === true,
        critical_failures: Number(row.critical_failures || 0),
        non_critical_findings: Number(row.non_critical_findings || 0),
        total_findings: Number(row.total_findings || 0),
        findings: Array.isArray(row.findings) ? row.findings : [],
        policy,
        candidate: entry && entry.candidate ? entry.candidate : null
      });
      row.replay_artifact_path = relPath(artifactPath);
    }
  }

  return {
    ok: true,
    type: 'orchestron_adversarial_lane',
    ts: nowIso(),
    date,
    run_id: runId,
    policy,
    total_candidates: flattened.length,
    probes_run: results.length,
    candidates_failed: results.filter((row) => row && row.pass !== true).length,
    critical_failures: results.reduce((sum, row) => sum + Number(row && row.critical_failures || 0), 0),
    non_critical_findings: results.reduce((sum, row) => sum + Number(row && row.non_critical_findings || 0), 0),
    results
  };
}

module.exports = {
  runAdversarialLane,
  normalizePolicy,
  flattenCandidateTree
};
