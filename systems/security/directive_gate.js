#!/usr/bin/env node
/**
 * directive_gate.js v1.0 - Directive Gate Enforcement
 *
 * Implements T0/T1 tiered directive constraints at the task execution choke point.
 * Evaluates tasks before they become "RUN" decisions.
 *
 * Returns: { decision: "ALLOW"|"MANUAL"|"DENY", reasons: string[], risk: string }
 *
 * Hard constraints:
 * - T0 violations => DENY
 * - High-risk actions => MANUAL (unless explicitly allowed)
 * - Low-risk internal actions => ALLOW
 * - No raw JSONL reads
 * - No LLM calls
 * - Deterministic rules only
 */

const fs = require('fs');
const path = require('path');

// v1.0: Import existing directive resolver
const { loadActiveDirectives, mergeConstraints, validateAction } = require('../../lib/directive_resolver.js');

// Trust registry path (for tamper detection)
const TRUST_REGISTRY = path.join(__dirname, '..', '..', 'memory', 'trust', 'registry.json');

// Workspace allowlist roots
const ALLOWLIST_ROOTS = [
  path.join(__dirname, '..', '..'), // workspace root
  path.join(__dirname, '..', '..', 'habits'),
  path.join(__dirname, '..', '..', 'memory'),
  path.join(__dirname, '..', '..', 'config'),
  path.join(__dirname, '..', '..', 'state')
];

// High-risk action patterns (deterministic heuristics)
const HIGH_RISK_PATTERNS = {
  // Process execution
  exec: /\b(child_process|exec|execSync|spawn|fork|execFile)\b/i,
  shell: /\b(shell|bash|sh\s|cmd\.exe|powershell)\b/i,
  
  // Credentials and tokens
  credentials: /\.openclaw[\/\\]credentials|\/credentials[\/\\]|token|api[_-]?key|secret|password/i,
  
  // Network calls
  network: /\b(http|https|fetch|axios|request|curl|wget|net\.|tls\.|socket)\b/i,
  
  // Git operations that mutate remote state
  git_remote: /\b(git\s+(push|force|reset|rebase|merge)|push\s+to|push\s+--|origin|publish|deploy)\b/i,
  
  // Cron/system config
  cron: /\b(cron|crontab|systemd|service|daemon)\b/i,
  
  // Revenue/financial
  revenue: /\b(payment|billing|subscription|charge|refund|account.*money|revenue)\b/i,
  
  // Governance/security tooling
  governance: /\b(trust[_-]?|verify[_-]?hash|tamper|bypass|disable.*log|registry.*hash)\b/i,
  
  // Trust tool modification
  trust_modify: /\b(trust_add|trust_remove|trust_registry|registry\.json)\b/i
};

// Deny patterns (T0 violations - must block)
const DENY_PATTERNS = {
  // Attempts to bypass gate
  bypass_gate: /\b(bypass.*gate|disable.*gate|skip.*gate)\b/i,
  
  // Attempts to disable logging
  disable_log: /\b(disable.*log|stop.*log|suppress.*event|remove.*audit)\b/i,
  
  // Tamper with trust registry
  tamper_trust: /\b(tamper|modify|edit|delete)\b.*\b(trust|hash|registry)\b/i,
  
  // Modify gate itself
  modify_gate: /\b(modify|edit|delete)\b.*\b(directive_gate)\b/i
};

/**
 * Check if path is within allowlisted roots
 */
function isAllowlistedPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  
  const resolved = path.resolve(targetPath);
  return ALLOWLIST_ROOTS.some(root => {
    const rootResolved = path.resolve(root);
    return resolved.startsWith(rootResolved);
  });
}

/**
 * Check if trust registry is being modified
 * Detects BOTH (trust target) AND (mutation verb)
 */
function isTrustRegistryModification(task) {
  const taskLower = task.toLowerCase();
  
  // Trust targets - files, paths, and registry patterns
  const trustTargets = [
    'trust_registry',
    'trust registry',
    'trust_add',
    'trust_remove',
    'memory/tools/trust_add.js',
    'memory/trust/registry.json',
    'registry.json',
    'registry hashes',
    'trust registry hashes'
  ];
  
  // Mutation verbs - actions that modify
  const mutationVerbs = [
    'edit',
    'modify',
    'update',
    'patch',
    'delete',
    'remove',
    'tamper',
    'change'
  ];
  
  const hasTrustTarget = trustTargets.some(target => taskLower.includes(target));
  const hasMutationVerb = mutationVerbs.some(verb => taskLower.includes(verb));
  
  return hasTrustTarget && hasMutationVerb;
}

/**
 * Evaluate task against tiered directives
 * 
 * Returns: { decision, reasons, risk }
 */
function evaluateTask(task) {
  const reasons = [];
  let decision = 'ALLOW';
  let risk = 'low';
  
  if (!task || typeof task !== 'string') {
    return {
      decision: 'DENY',
      reasons: ['Task must be a non-empty string'],
      risk: 'high'
    };
  }
  
  const taskLower = task.toLowerCase();
  
  // === T0 INVARIANTS: DENY patterns (must block) ===
  
  for (const [patternName, pattern] of Object.entries(DENY_PATTERNS)) {
    if (pattern.test(task)) {
      reasons.push(`T0 violation: ${patternName.replace('_', ' ')} detected`);
      decision = 'DENY';
      risk = 'high';
    }
  }
  
  // Check for trust registry tampering
  if (isTrustRegistryModification(task)) {
    reasons.push('T0 violation: trust registry modification detected');
    decision = 'DENY';
    risk = 'high';
  }
  
  // === HIGH-RISK: MANUAL patterns (require human approval) ===
  
  // Process execution
  if (HIGH_RISK_PATTERNS.exec.test(task)) {
    reasons.push('High-risk: process execution detected');
    risk = 'high';
    if (decision !== 'DENY') decision = 'MANUAL';
  }
  
  if (HIGH_RISK_PATTERNS.shell.test(task)) {
    reasons.push('High-risk: shell execution detected');
    risk = 'high';
    if (decision !== 'DENY') decision = 'MANUAL';
  }
  
  // Credentials access
  if (HIGH_RISK_PATTERNS.credentials.test(task)) {
    reasons.push('High-risk: credentials/token access detected');
    risk = 'high';
    if (decision !== 'DENY') decision = 'MANUAL';
  }
  
  // Network calls
  if (HIGH_RISK_PATTERNS.network.test(task)) {
    reasons.push('High-risk: network/API call detected');
    risk = 'medium';
    if (decision !== 'DENY') decision = 'MANUAL';
  }
  
  // Git remote operations
  if (HIGH_RISK_PATTERNS.git_remote.test(task)) {
    reasons.push('High-risk: git remote operation detected');
    risk = 'high';
    if (decision !== 'DENY') decision = 'MANUAL';
  }
  
  // Cron/system changes
  if (HIGH_RISK_PATTERNS.cron.test(task)) {
    reasons.push('High-risk: cron/system config modification detected');
    risk = 'high';
    if (decision !== 'DENY') decision = 'MANUAL';
  }
  
  // Revenue/financial
  if (HIGH_RISK_PATTERNS.revenue.test(task)) {
    reasons.push('High-risk: revenue/financial action detected');
    risk = 'high';
    if (decision !== 'DENY') decision = 'MANUAL';
  }
  
  // Trust/governance tool modification
  if (HIGH_RISK_PATTERNS.governance.test(task) || HIGH_RISK_PATTERNS.trust_modify.test(task)) {
    reasons.push('High-risk: governance/security tooling modification detected');
    risk = 'high';
    if (decision !== 'DENY') decision = 'MANUAL';
  }
  
  // === PATH VALIDATION ===
  
  // Extract potential file paths from task
  const pathMatches = task.match(/[\/~][a-zA-Z0-9_\/.-]+/g) || [];
  for (const p of pathMatches) {
    if (p.includes('credentials') || p.includes('secret') || p.includes('token')) {
      if (!isAllowlistedPath(p) || p.includes('credentials')) {
        reasons.push(`Path validation: sensitive path "${p}"`);
        risk = 'high';
        if (decision !== 'DENY') decision = 'MANUAL';
      }
    } else if (p.includes('~/.openclaw') && !isAllowlistedPath(p)) {
      reasons.push(`Path validation: path outside workspace "${p}"`);
      risk = 'medium';
      if (decision !== 'DENY') decision = 'MANUAL';
    }
  }
  
  // === SAFE PATTERNS (reduce risk) ===
  
  // Read-only analysis within workspace
  const isReadOnly = /\b(read|cat|view|show|list|ls\s|grep|find)\b/i.test(task);
  const isInternalPath = pathMatches.every(p => isAllowlistedPath(p));
  
  if (isReadOnly && isInternalPath && decision === 'ALLOW' && risk === 'low') {
    // Confirmed safe
  }
  
  // === DEFAULT ===
  
  if (reasons.length === 0) {
    reasons.push('No high-risk patterns detected; standard routing applies');
  }
  
  return {
    decision,
    reasons,
    risk
  };
}

/**
 * Log gate decision to AIE (Agent Improvement Engine)
 * Structured event for audit trail
 */
function logGateDecision(task, result, metadata = {}) {
  const event = {
    ts: new Date().toISOString(),
    type: result.decision === 'DENY' ? 'violation_blocked' : 'approval_queued',
    task_preview: task.slice(0, 100),
    gate_decision: result.decision,
    gate_risk: result.risk,
    gate_reasons: result.reasons,
    metadata: {
      tokens_est: metadata.tokens_est || 0,
      source: metadata.source || 'route_task'
    }
  };
  
  // v1.0: This is a structured event format - actual logging would go to AIE
  // For now, return the event for the caller to log
  return event;
}

// Export for router integration
module.exports = {
  evaluateTask,
  logGateDecision,
  isAllowlistedPath,
  isTrustRegistryModification,
  HIGH_RISK_PATTERNS,
  DENY_PATTERNS,
  ALLOWLIST_ROOTS
};

// CLI usage for testing
if (require.main === module) {
  const task = process.argv[2] || 'example read task';
  const result = evaluateTask(task);
  
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   DIRECTIVE GATE EVALUATION');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Task: ${task.slice(0, 60)}${task.length > 60 ? '...' : ''}`);
  console.log(`Decision: ${result.decision}`);
  console.log(`Risk: ${result.risk}`);
  console.log('\nReasons:');
  result.reasons.forEach(r => console.log(`  - ${r}`));
  console.log('═══════════════════════════════════════════════════════════');
  
  process.exit(result.decision === 'DENY' ? 1 : 0);
}
