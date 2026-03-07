#!/usr/bin/env node
'use strict';
export {};

/**
 * BL-033
 * Quorum validator gate for high-tier self-modification proposals.
 *
 * Usage:
 *   node systems/autonomy/high_tier_mutation_quorum_gate.js validate --proposal-json='{"id":"m1"}' --primary-json='{"agree":true}' --secondary-json='{"agree":true}'
 *   node systems/autonomy/high_tier_mutation_quorum_gate.js status
 */

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = process.env.HIGH_TIER_MUTATION_QUORUM_GATE_ROOT
  ? path.resolve(process.env.HIGH_TIER_MUTATION_QUORUM_GATE_ROOT)
  : path.resolve(__dirname, '..', '..');

const DEFAULT_POLICY_PATH = process.env.HIGH_TIER_MUTATION_QUORUM_GATE_POLICY_PATH
  ? path.resolve(process.env.HIGH_TIER_MUTATION_QUORUM_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'high_tier_mutation_quorum_gate_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 360) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const eq = tok.indexOf('=');
    if (eq >= 0) { out[tok.slice(2, eq)] = tok.slice(eq + 1); continue; }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any = null) {
  try { if (!fs.existsSync(filePath)) return fallback; const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')); return parsed == null ? fallback : parsed; } catch { return fallback; }
}
function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function resolvePath(raw: unknown, fallbackRel: string) {
  const txt = cleanText(raw, 520);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function rel(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseJsonArg(raw: unknown, fallback: any = null) {
  const txt = cleanText(raw, 120000);
  if (!txt) return fallback;
  try { return JSON.parse(txt); } catch { return fallback; }
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    high_tiers: ['belief', 'identity', 'directive', 'constitution'],
    require_explanation_on_disagreement: true,
    outputs: {
      latest_path: 'state/autonomy/high_tier_mutation_quorum_gate/latest.json',
      history_path: 'state/autonomy/high_tier_mutation_quorum_gate/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const outputs = raw.outputs && typeof raw.outputs === 'object' ? raw.outputs : {};
  const tiers = Array.isArray(raw.high_tiers)
    ? raw.high_tiers.map((x: unknown) => cleanText(x, 80).toLowerCase()).filter(Boolean)
    : base.high_tiers;

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    high_tiers: Array.from(new Set(tiers)),
    require_explanation_on_disagreement: raw.require_explanation_on_disagreement !== false,
    outputs: {
      latest_path: resolvePath(outputs.latest_path, base.outputs.latest_path),
      history_path: resolvePath(outputs.history_path, base.outputs.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function cmdValidate(args: AnyObj) {
  const strict = toBool(args.strict, true);
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) return { ok: true, strict, result: 'disabled_by_policy', policy_path: rel(policy.policy_path) };

  const proposal = parseJsonArg(args['proposal-json'] || args.proposal_json, {});
  const primary = parseJsonArg(args['primary-json'] || args.primary_json, {});
  const secondary = parseJsonArg(args['secondary-json'] || args.secondary_json, {});

  const tier = cleanText(proposal.tier || proposal.mutation_tier || '', 80).toLowerCase();
  const isHighTier = policy.high_tiers.includes(tier);

  const agreeA = primary && (primary.agree === true || String(primary.result || '').toLowerCase() === 'approve');
  const agreeB = secondary && (secondary.agree === true || String(secondary.result || '').toLowerCase() === 'approve');

  const blockers: AnyObj[] = [];
  if (isHighTier && (!agreeA || !agreeB)) {
    blockers.push({ gate: 'dual_validator_quorum', reason: 'high_tier_disagreement', primary_agree: !!agreeA, secondary_agree: !!agreeB });
    if (policy.require_explanation_on_disagreement) {
      const reason = cleanText(secondary.reason || secondary.explain || primary.reason || primary.explain || '', 500);
      if (!reason) blockers.push({ gate: 'disagreement_explanation', reason: 'missing_explanation' });
    }
  }

  const out = {
    ok: blockers.length === 0,
    ts: nowIso(),
    type: 'high_tier_mutation_quorum_gate',
    strict,
    proposal_id: cleanText(proposal.id || proposal.proposal_id, 120) || null,
    tier: tier || null,
    high_tier: isHighTier,
    primary_agree: !!agreeA,
    secondary_agree: !!agreeB,
    blockers,
    policy_path: rel(policy.policy_path)
  };

  writeJsonAtomic(policy.outputs.latest_path, out);
  appendJsonl(policy.outputs.history_path, {
    ts: out.ts,
    type: out.type,
    proposal_id: out.proposal_id,
    tier: out.tier,
    blocker_count: out.blockers.length,
    ok: out.ok
  });

  return out;
}

function cmdStatus(args: AnyObj) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  return {
    ok: true,
    ts: nowIso(),
    type: 'high_tier_mutation_quorum_gate_status',
    latest: readJson(policy.outputs.latest_path, null),
    policy_path: rel(policy.policy_path)
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/autonomy/high_tier_mutation_quorum_gate.js validate --proposal-json="{...}" --primary-json="{...}" --secondary-json="{...}"');
  console.log('  node systems/autonomy/high_tier_mutation_quorum_gate.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').toLowerCase();
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { usage(); return; }
  const payload = cmd === 'validate' ? cmdValidate(args)
    : cmd === 'status' ? cmdStatus(args)
      : { ok: false, error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok === false && toBool(args.strict, true)) process.exit(1);
  if (payload.ok === false) process.exit(1);
}

if (require.main === module) {
  try { main(); } catch (err) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: cleanText((err as AnyObj)?.message || err || 'high_tier_mutation_quorum_gate_failed', 260) })}\n`);
    process.exit(1);
  }
}

module.exports = { loadPolicy, cmdValidate, cmdStatus };
