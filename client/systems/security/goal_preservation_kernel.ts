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
type AnyObj = Record<string, any>;
const POLICY_PATH = process.env.GOAL_PRESERVATION_POLICY_PATH
  ? path.resolve(process.env.GOAL_PRESERVATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'goal_preservation_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/goal_preservation_kernel.js evaluate --proposal-file=<abs|rel.json>');
  console.log('  node systems/security/goal_preservation_kernel.js evaluate --proposal-json="{...}"');
  console.log('  node systems/security/goal_preservation_kernel.js status');
}

function parseArgs(argv: string[]) {
  const out: any = { _: [] };
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

function defaultPolicy() {
  return {
    version: '1.0',
    strict_mode: true,
    constitution_path: 'AGENT-CONSTITUTION.md',
    protected_axiom_markers: [
      'to be a hero',
      'to test the limits',
      'to create at will',
      'to win my freedom',
      'user sovereignty',
      'root constitution'
    ],
    blocked_mutation_paths: [
      '^AGENT-CONSTITUTION\\.md$',
      '^SOUL\\.md$',
      '^USER\\.md$',
      '^systems/security/guard\\.(ts|js)$',
      '^systems/security/policy_rootd\\.(ts|js)$'
    ],
    symbiosis_recursion_gate: {
      enabled: true,
      shadow_only: true,
      signal_policy_path: 'config/symbiosis_coherence_policy.json'
    },
    output: {
      state_path: 'state/security/goal_preservation/latest.json',
      receipts_path: 'state/security/goal_preservation/receipts.jsonl'
    }
  };
}

function normalizePolicy(raw: any) {
  const base = defaultPolicy();
  const src = raw && typeof raw === 'object' ? raw : {};
  return {
    version: cleanText(src.version || base.version, 32) || '1.0',
    strict_mode: src.strict_mode !== false,
    constitution_path: cleanText(src.constitution_path || base.constitution_path, 260) || base.constitution_path,
    protected_axiom_markers: (Array.isArray(src.protected_axiom_markers) ? src.protected_axiom_markers : base.protected_axiom_markers)
      .map((row: unknown) => cleanText(row, 180).toLowerCase())
      .filter(Boolean)
      .slice(0, 128),
    blocked_mutation_paths: (Array.isArray(src.blocked_mutation_paths) ? src.blocked_mutation_paths : base.blocked_mutation_paths)
      .map((row: unknown) => cleanText(row, 220))
      .filter(Boolean)
      .slice(0, 128),
    symbiosis_recursion_gate: {
      enabled: !(src.symbiosis_recursion_gate && src.symbiosis_recursion_gate.enabled === false),
      shadow_only: src.symbiosis_recursion_gate && src.symbiosis_recursion_gate.shadow_only != null
        ? !!src.symbiosis_recursion_gate.shadow_only
        : base.symbiosis_recursion_gate.shadow_only === true,
      signal_policy_path: cleanText(
        src.symbiosis_recursion_gate && src.symbiosis_recursion_gate.signal_policy_path
          || base.symbiosis_recursion_gate.signal_policy_path,
        260
      ) || base.symbiosis_recursion_gate.signal_policy_path
    },
    output: {
      state_path: cleanText(src.output && src.output.state_path || base.output.state_path, 260) || base.output.state_path,
      receipts_path: cleanText(src.output && src.output.receipts_path || base.output.receipts_path, 260) || base.output.receipts_path
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  return normalizePolicy(readJson(policyPath, {}));
}

function loadProposal(args: any) {
  if (args.proposal_json || args['proposal-json']) {
    try {
      return JSON.parse(String(args.proposal_json || args['proposal-json']));
    } catch {
      return null;
    }
  }
  const fileRaw = cleanText(args.proposal_file || args['proposal-file'] || '', 320);
  if (!fileRaw) return null;
  const filePath = path.isAbsolute(fileRaw) ? fileRaw : path.join(ROOT, fileRaw);
  return readJson(filePath, null);
}

function toList(v: unknown, maxLen = 200, maxItems = 64) {
  const src = Array.isArray(v) ? v : String(v == null ? '' : v).split(',');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const row of src) {
    const next = cleanText(row, maxLen);
    if (!next) continue;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    if (out.length >= maxItems) break;
  }
  return out;
}

function extractRecursionRequest(row: AnyObj = {}) {
  const recursionDepthRaw = row.recursion_depth != null
    ? row.recursion_depth
    : (row.recursion && typeof row.recursion === 'object' ? row.recursion.depth : null);
  const recursionModeRaw = row.recursion_mode != null
    ? row.recursion_mode
    : (row.recursion && typeof row.recursion === 'object' ? row.recursion.mode : null);
  const unbounded = ['unbounded', 'infinite', 'max', 'none'].includes(normalizeToken(recursionModeRaw, 32))
    || ['unbounded', 'infinite', 'max', 'none'].includes(normalizeToken(recursionDepthRaw, 32));
  const depthNumber = Number(recursionDepthRaw);
  const depth = Number.isFinite(depthNumber)
    ? Math.max(1, Math.floor(depthNumber))
    : null;
  return {
    requested_depth: unbounded ? 'unbounded' : (depth == null ? 1 : depth),
    requested_unbounded: unbounded
  };
}

function proposalTouchesRecursiveSelfImprovement(row: AnyObj, mutationPaths: string[], summary: string) {
  if (row.recursion_depth != null || row.recursion_mode != null) return true;
  if (row.recursion && typeof row.recursion === 'object') return true;
  const targetSystem = cleanText(row.target_system || row.target || '', 120).toLowerCase();
  if (/self[_ -]?improvement|recursion|recursive|self[_ -]?evolution/.test(targetSystem)) return true;
  if (
    mutationPaths.some((v) => /self[_ -]?improvement|self[_ -]?code[_ -]?evolution|redteam[/_-].*self|autonomy/i.test(String(v)))
  ) return true;
  if (/recursive self-improvement|unbounded recursion|recursion depth|self[_ -]?improvement depth/.test(summary)) return true;
  return false;
}

function evaluateProposal(policy: any, proposal: any) {
  const row = proposal && typeof proposal === 'object' ? proposal : {};
  const mutationPaths = toList(row.mutation_paths || row.files || row.paths || [], 260, 256)
    .map((p) => p.replace(/\\/g, '/').replace(/^\.\//, ''));
  const summary = cleanText(row.summary || row.patch_summary || row.description || '', 4000).toLowerCase();
  const reasons: string[] = [];
  const advisories: string[] = [];

  const blockedPathHits: string[] = [];
  for (const pattern of policy.blocked_mutation_paths || []) {
    let re: RegExp | null = null;
    try {
      re = new RegExp(pattern, 'i');
    } catch {
      re = null;
    }
    if (!re) continue;
    for (const p of mutationPaths) {
      if (re.test(p)) blockedPathHits.push(p);
    }
  }
  if (blockedPathHits.length > 0) reasons.push('blocked_mutation_path');

  const markerHits = (policy.protected_axiom_markers || []).filter((marker: string) => summary.includes(String(marker || '').toLowerCase()));
  if (markerHits.length > 0) reasons.push('protected_axiom_marker_touched');

  const constitutionPath = path.isAbsolute(policy.constitution_path)
    ? policy.constitution_path
    : path.join(ROOT, policy.constitution_path);
  const constitutionHash = sha256File(constitutionPath);
  const expectedHash = cleanText(row.expected_constitution_hash || '', 96).toLowerCase() || null;
  if (expectedHash && constitutionHash && expectedHash !== constitutionHash) {
    reasons.push('constitution_hash_mismatch');
  }

  const strictKeywords = [
    /disable\s+constitution/i,
    /rewrite\s+constitution/i,
    /bypass\s+user\s+veto/i,
    /remove\s+user\s+control/i,
    /disable\s+guard/i,
    /turn\s+off\s+integrity/i
  ];
  if (strictKeywords.some((re) => re.test(summary))) reasons.push('alignment_keyword_violation');

  let symbiosisGate: AnyObj = {
    enabled: false,
    evaluated: false
  };
  const recursionGateCfg = policy.symbiosis_recursion_gate && typeof policy.symbiosis_recursion_gate === 'object'
    ? policy.symbiosis_recursion_gate
    : {};
  const shouldCheckRecursion = recursionGateCfg.enabled === true
    && proposalTouchesRecursiveSelfImprovement(row, mutationPaths, summary);
  if (shouldCheckRecursion) {
    const signal = loadSymbiosisCoherenceSignal({
      policy_path: recursionGateCfg.signal_policy_path,
      refresh: true,
      persist: true
    });
    const request = extractRecursionRequest(row);
    const gate = evaluateRecursionRequest({
      signal,
      requested_depth: request.requested_depth,
      require_unbounded: request.requested_unbounded,
      shadow_only_override: recursionGateCfg.shadow_only === true
    });
    symbiosisGate = {
      enabled: true,
      evaluated: true,
      request,
      ...gate
    };
    if (gate.blocked_hard === true) reasons.push('symbiosis_recursion_gate_blocked');
    else if (gate.shadow_violation === true) advisories.push('symbiosis_recursion_gate_shadow_violation');
  }

  const allowed = reasons.length === 0;
  return {
    allowed,
    reasons: Array.from(new Set(reasons)),
    advisories: Array.from(new Set(advisories)),
    checks: {
      strict_mode: policy.strict_mode === true,
      mutation_paths_count: mutationPaths.length,
      blocked_path_hits: Array.from(new Set(blockedPathHits)).slice(0, 32),
      protected_axiom_markers_hit: markerHits.slice(0, 32),
      constitution_hash: constitutionHash,
      expected_constitution_hash: expectedHash,
      symbiosis_recursion_gate: symbiosisGate
    }
  };
}

function writeLatest(policy: any, payload: any) {
  const latestPath = path.isAbsolute(policy.output.state_path)
    ? policy.output.state_path
    : path.join(ROOT, policy.output.state_path);
  ensureDir(path.dirname(latestPath));
  fs.writeFileSync(latestPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  const receiptsPath = path.isAbsolute(policy.output.receipts_path)
    ? policy.output.receipts_path
    : path.join(ROOT, policy.output.receipts_path);
  appendJsonl(receiptsPath, payload);
  return {
    latest_path: latestPath,
    receipts_path: receiptsPath
  };
}

function cmdEvaluate(args: any) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const proposal = loadProposal(args);
  if (!proposal) {
    const out = {
      ok: false,
      type: 'goal_preservation_evaluate',
      error: 'proposal_required'
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
    process.exit(1);
  }

  const evalOut = evaluateProposal(policy, proposal);
  const payload = {
    ts: nowIso(),
    type: 'goal_preservation_evaluate',
    policy_version: policy.version,
    proposal_id: normalizeToken(proposal.proposal_id || proposal.id || '', 120) || null,
    target_system: cleanText(proposal.target_system || '', 160) || null,
    allowed: evalOut.allowed,
    reasons: evalOut.reasons,
    advisories: evalOut.advisories,
    checks: evalOut.checks
  };
  const paths = writeLatest(policy, payload);
  process.stdout.write(`${JSON.stringify({ ok: true, ...payload, ...paths })}\n`);
}

function cmdStatus(args: any) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const latestPath = path.isAbsolute(policy.output.state_path)
    ? policy.output.state_path
    : path.join(ROOT, policy.output.state_path);
  const latest = readJson(latestPath, null);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'goal_preservation_status',
    policy_version: policy.version,
    latest_path: latestPath,
    latest
  })}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'evaluate') return cmdEvaluate(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluateProposal,
  loadPolicy
};
