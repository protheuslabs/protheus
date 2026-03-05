#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');

const TRUST_REGISTRY = path.join(ROOT, 'memory', 'trust', 'registry.json');

const ALLOWLIST_ROOTS = [
  ROOT,
  path.join(ROOT, 'habits'),
  path.join(ROOT, 'memory'),
  path.join(ROOT, 'config'),
  path.join(ROOT, 'state')
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

function isAllowlistedPath(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  const resolved = path.resolve(targetPath);
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

function parseJsonPayload(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function executionBinaryCandidates() {
  const explicit = String(process.env.PROTHEUS_EXECUTION_RUST_BIN || '').trim();
  const out = [
    explicit,
    path.join(ROOT, 'target', 'release', 'execution_core'),
    path.join(ROOT, 'target', 'debug', 'execution_core'),
    path.join(ROOT, 'crates', 'execution', 'target', 'release', 'execution_core'),
    path.join(ROOT, 'crates', 'execution', 'target', 'debug', 'execution_core')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function runDirectiveGateViaRust(taskText) {
  const payload = JSON.stringify({ task_text: String(taskText || '') });
  const payloadB64 = Buffer.from(payload, 'utf8').toString('base64');
  for (const candidate of executionBinaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, ['directive-gate', `--payload-base64=${payloadB64}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = parseJsonPayload(out.stdout);
      if (Number(out.status) === 0 && parsed && typeof parsed === 'object') {
        const decision = String(parsed.decision || '');
        const risk = String(parsed.risk || '');
        const reasons = Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 12).map((v) => String(v || '')) : [];
        if (decision && risk) {
          return { decision, risk, reasons };
        }
      }
    } catch {
      // try next candidate
    }
  }
  return null;
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

  return { decision, reasons, risk };
}

function evaluateTask(task) {
  const mode = String(process.env.DIRECTIVE_GATE_RUST_MODE || 'prefer').trim().toLowerCase();
  if (mode === 'prefer') {
    const rustOut = runDirectiveGateViaRust(task);
    if (rustOut) return rustOut;
    return evaluateTaskFallback(task);
  }
  if (mode === 'rust_only') {
    const rustOut = runDirectiveGateViaRust(task);
    if (rustOut) return rustOut;
    return {
      decision: 'MANUAL',
      reasons: ['directive_gate_rust_unavailable'],
      risk: 'high'
    };
  }
  return evaluateTaskFallback(task);
}

function logGateDecision(task, result, metadata = {}) {
  const meta: Record<string, unknown> = (metadata && typeof metadata === 'object'
    ? metadata as Record<string, unknown>
    : {});
  return {
    ts: new Date().toISOString(),
    type: result.decision === 'DENY' ? 'violation_blocked' : 'approval_queued',
    task_preview: String(task || '').slice(0, 100),
    gate_decision: result.decision,
    gate_risk: result.risk,
    gate_reasons: Array.isArray(result.reasons) ? result.reasons : [],
    metadata: {
      tokens_est: Number(meta['tokens_est'] || 0),
      source: String(meta['source'] || 'route_task')
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
  console.log('\nReasons:');
  for (const reason of result.reasons || []) {
    console.log(`  - ${reason}`);
  }
  console.log('═══════════════════════════════════════════════════════════');
  process.exit(result.decision === 'DENY' ? 1 : 0);
}

export {};
