#!/usr/bin/env node
'use strict';

// Layer ownership: core/layer2/execution::directive-gate (authoritative)
// Rust-first evaluation with deterministic JS compatibility fallback.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const CLIENT_ROOT = path.resolve(ROOT, '..');
const TRUST_REGISTRY = path.join(ROOT, 'memory', 'trust', 'registry.json');

const ALLOWLIST_ROOTS = [
  ROOT,
  CLIENT_ROOT,
  path.join(ROOT, 'habits'),
  path.join(ROOT, 'memory'),
  path.join(ROOT, 'config'),
  path.join(ROOT, 'local', 'state'),
  path.join(CLIENT_ROOT, 'state')
];

const HIGH_RISK_PATTERNS = {
  exec: /\b(child_process|exec|execSync|spawn|fork|execFile)\b/i,
  shell: /\b(shell|bash|sh\s|cmd\.exe|powershell)\b/i,
  credentials: /\.openclaw[\/\\]credentials|\/credentials[\/\\]|token|api[_-]?key|secret|password/i,
  network: /\b(http|https|fetch|axios|request|curl|wget|net\.|tls\.|socket)\b/i,
  git_remote: /\b(git\s+(push|force|reset|rebase|merge)|push\s+to|push\s+--|origin|publish|deploy)\b/i,
  cron: /\b(cron|crontab|systemd|service|daemon)\b/i,
  revenue: /\b(payment|billing|subscription|charge|refund|account.*money|revenue)\b/i,
  governance: /\b(trust[_-]?|verify[_-]?hash|tamper|bypass|disable.*log|registry.*hash)\b/i,
  trust_modify: /\b(trust_add|trust_remove|trust_registry|registry\.json)\b/i
};

const DENY_PATTERNS = {
  bypass_gate: /\b(bypass.*gate|disable.*gate|skip.*gate)\b/i,
  disable_log: /\b(disable.*log|stop.*log|suppress.*event|remove.*audit)\b/i,
  tamper_trust: /\b(tamper|modify|edit|delete)\b.*\b(trust|hash|registry)\b/i,
  modify_gate: /\b(modify|edit|delete)\b.*\b(directive_gate)\b/i
};

function findRepoRoot(startDir) {
  let cur = path.resolve(startDir || process.cwd());
  while (true) {
    if (
      fs.existsSync(path.join(cur, 'Cargo.toml')) &&
      fs.existsSync(path.join(cur, 'core', 'layer2', 'execution', 'Cargo.toml'))
    ) {
      return cur;
    }
    const parent = path.dirname(cur);
    if (parent === cur) return process.cwd();
    cur = parent;
  }
}

const REPO_ROOT = findRepoRoot(__dirname);

function executionCoreCandidates() {
  return [
    path.join(REPO_ROOT, 'target', 'release', 'execution_core'),
    path.join(REPO_ROOT, 'target', 'debug', 'execution_core'),
    path.join(REPO_ROOT, 'core', 'layer2', 'execution', 'target', 'release', 'execution_core'),
    path.join(REPO_ROOT, 'core', 'layer2', 'execution', 'target', 'debug', 'execution_core')
  ];
}

function resolveExecutionCoreBinary() {
  for (const candidate of executionCoreCandidates()) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function parseJson(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function runDirectiveGateCore(task) {
  const bin = resolveExecutionCoreBinary();
  if (!bin) return null;
  const payload = JSON.stringify({ task_text: String(task || '') });
  const proc = spawnSync(bin, ['directive-gate', `--payload=${payload}`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: Number(process.env.DIRECTIVE_GATE_CORE_TIMEOUT_MS || 3000)
  });
  const parsed = parseJson(proc.stdout);
  if (Number(proc.status || 0) !== 0 || !parsed || parsed.ok === false) return null;
  if (!parsed.decision || !Array.isArray(parsed.reasons)) return null;
  return {
    decision: String(parsed.decision),
    reasons: parsed.reasons.map((row) => String(row)),
    risk: String(parsed.risk || 'low'),
    authority: 'core/layer2/execution'
  };
}

function isAllowlistedPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const raw = String(targetPath).trim();
  const expanded = raw.startsWith('~/')
    ? path.join(process.env.HOME || '', raw.slice(2))
    : raw;
  const resolved = path.resolve(expanded);
  const normalized = resolved.replace(/\\/g, '/');
  if (normalized.includes('/.openclaw/workspace/state/')) return true;
  return ALLOWLIST_ROOTS.some((root) => resolved.startsWith(path.resolve(root)));
}

function isTrustRegistryModification(task) {
  const text = String(task || '').toLowerCase();
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
  const mutationVerbs = ['edit', 'modify', 'update', 'patch', 'delete', 'remove', 'tamper', 'change'];
  const hasTrustTarget = trustTargets.some((target) => text.includes(target));
  const hasMutationVerb = mutationVerbs.some((verb) => text.includes(verb));
  return hasTrustTarget && hasMutationVerb;
}

function evaluateTaskFallback(task) {
  const reasons = [];
  let decision = 'ALLOW';
  let risk = 'low';
  const text = String(task || '');

  if (!text.trim()) {
    return {
      decision: 'DENY',
      reasons: ['Task must be a non-empty string'],
      risk: 'high'
    };
  }

  for (const [name, pattern] of Object.entries(DENY_PATTERNS)) {
    if (pattern.test(text)) {
      reasons.push(`T0 violation: ${name.replace('_', ' ')} detected`);
      decision = 'DENY';
      risk = 'high';
    }
  }
  if (isTrustRegistryModification(text)) {
    reasons.push('T0 violation: trust registry modification detected');
    decision = 'DENY';
    risk = 'high';
  }

  const highRiskMessages = [
    ['exec', 'High-risk: process execution detected', 'high'],
    ['shell', 'High-risk: shell execution detected', 'high'],
    ['credentials', 'High-risk: credentials/token access detected', 'high'],
    ['network', 'High-risk: network/API call detected', 'medium'],
    ['git_remote', 'High-risk: git remote operation detected', 'high'],
    ['cron', 'High-risk: cron/system config modification detected', 'high'],
    ['revenue', 'High-risk: revenue/financial action detected', 'high'],
    ['governance', 'High-risk: governance/security tooling modification detected', 'high'],
    ['trust_modify', 'High-risk: governance/security tooling modification detected', 'high']
  ];
  for (const [patternName, message, severity] of highRiskMessages) {
    const pattern = HIGH_RISK_PATTERNS[patternName];
    if (pattern && pattern.test(text)) {
      reasons.push(message);
      risk = severity;
      if (decision !== 'DENY') decision = 'MANUAL';
    }
  }

  const pathMatches = text.match(/[\/~][a-zA-Z0-9_\/.-]+/g) || [];
  for (const p of pathMatches) {
    const lower = String(p).toLowerCase();
    if (lower.includes('credentials') || lower.includes('secret') || lower.includes('token')) {
      if (!isAllowlistedPath(p) || lower.includes('credentials')) {
        reasons.push(`Path validation: sensitive path "${p}"`);
        risk = 'high';
        if (decision !== 'DENY') decision = 'MANUAL';
      }
    } else if (lower.includes('~/.openclaw') && !isAllowlistedPath(p)) {
      reasons.push(`Path validation: path outside workspace "${p}"`);
      risk = 'medium';
      if (decision !== 'DENY') decision = 'MANUAL';
    }
  }

  if (reasons.length === 0) {
    reasons.push('No high-risk patterns detected; standard routing applies');
  }

  return { decision, reasons, risk, authority: 'client_fallback' };
}

function evaluateTask(task) {
  const fallback = evaluateTaskFallback(task);
  if (fallback.decision === 'ALLOW') return fallback;
  const rust = runDirectiveGateCore(task);
  if (!rust) return fallback;
  if (fallback.decision === 'DENY') {
    return {
      ...rust,
      decision: 'DENY',
      risk: 'high',
      reasons: Array.from(new Set([...(rust.reasons || []), ...(fallback.reasons || [])]))
    };
  }
  if (fallback.decision === 'MANUAL' && rust.decision === 'ALLOW') return fallback;
  return rust;
}

function logGateDecision(task, result, metadata = {}) {
  const meta = (metadata && typeof metadata === 'object' ? metadata : {});
  return {
    ts: new Date().toISOString(),
    type: result.decision === 'DENY' ? 'violation_blocked' : 'approval_queued',
    task_preview: String(task || '').slice(0, 100),
    gate_decision: result.decision,
    gate_risk: result.risk,
    gate_reasons: Array.isArray(result.reasons) ? result.reasons : [],
    metadata: {
      tokens_est: Number(meta.tokens_est || 0),
      source: String(meta.source || 'route_task')
    }
  };
}

module.exports = {
  TRUST_REGISTRY,
  ALLOWLIST_ROOTS,
  HIGH_RISK_PATTERNS,
  DENY_PATTERNS,
  isAllowlistedPath,
  isTrustRegistryModification,
  evaluateTask,
  evaluateTaskFallback,
  runDirectiveGateCore,
  logGateDecision
};

if (require.main === module) {
  const task = process.argv[2] || 'example read task';
  const result = evaluateTask(task);
  console.log('═══════════════════════════════════════════════════════════');
  console.log('   DIRECTIVE GATE EVALUATION');
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Task: ${String(task).slice(0, 60)}${String(task).length > 60 ? '...' : ''}`);
  console.log(`Decision: ${result.decision}`);
  console.log(`Risk: ${result.risk}`);
  console.log(`Authority: ${String(result.authority || 'unknown')}`);
  console.log('\nReasons:');
  for (const reason of result.reasons || []) {
    console.log(`  - ${reason}`);
  }
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(result.decision === 'DENY' ? 1 : 0);
}
