#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.SOURCE_ATTESTATION_EXTENSION_POLICY_PATH
  ? path.resolve(process.env.SOURCE_ATTESTATION_EXTENSION_POLICY_PATH)
  : path.join(ROOT, 'config', 'source_attestation_extension_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 280) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 180) { return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, ''); }
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any) { try { if (!fs.existsSync(filePath)) return fallback; const p = JSON.parse(fs.readFileSync(filePath, 'utf8')); return p == null ? fallback : p; } catch { return fallback; } }
function writeJsonAtomic(filePath: string, value: AnyObj) { ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath); }
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function relPath(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const idx = tok.indexOf('=');
    if (idx >= 0) { out[tok.slice(2, idx)] = tok.slice(idx + 1); continue; }
    const key = tok.slice(2); const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw || '', 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    min_trust_score: 0.55,
    receipts_path: 'state/assimilation/source_attestation_extension/receipts.jsonl',
    latest_path: 'state/assimilation/source_attestation_extension/latest.json'
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    min_trust_score: Number(src.min_trust_score != null ? src.min_trust_score : base.min_trust_score) || base.min_trust_score,
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path)
  };
}

function attest(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'source_attestation_extension_attest', error: 'policy_disabled' };

  const sourceId = normalizeToken(args['source-id'] || args.source_id || '', 180);
  const sourcePayload = cleanText(args.payload || args.text || '', 4000);
  const proof = cleanText(args.proof || '', 4000);
  if (!sourceId) return { ok: false, type: 'source_attestation_extension_attest', error: 'source_id_required' };
  if (!sourcePayload) return { ok: false, type: 'source_attestation_extension_attest', error: 'payload_required' };

  const digest = crypto.createHash('sha256').update(sourcePayload, 'utf8').digest('hex');
  const proofDigest = proof ? crypto.createHash('sha256').update(proof, 'utf8').digest('hex') : null;
  const trustScore = Math.max(0, Math.min(1, Number(args['trust-score'] || args.trust_score || (proofDigest ? 0.85 : 0.45)) || 0.45));
  const verified = proofDigest != null;
  const accepted = trustScore >= Number(policy.min_trust_score || 0.55);

  const out = {
    ok: accepted,
    type: 'source_attestation_extension_attest',
    ts: nowIso(),
    source_id: sourceId,
    digest,
    proof_digest: proofDigest,
    verified,
    trust_score: Number(trustScore.toFixed(4)),
    min_trust_score: Number(policy.min_trust_score || 0.55),
    routing_hint: accepted ? 'normal_confidence' : 'degraded_confidence'
  };
  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const count = fs.existsSync(policy.receipts_path)
    ? String(fs.readFileSync(policy.receipts_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  return {
    ok: true,
    type: 'source_attestation_extension_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      min_trust_score: policy.min_trust_score
    },
    receipts_count: count,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        source_id: latest.source_id || null,
        trust_score: Number(latest.trust_score || 0),
        routing_hint: latest.routing_hint || null
      }
      : null,
    paths: {
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/assimilation/source_attestation_extension.js attest --source-id=<id> --payload="..." [--proof="..."] [--trust-score=0.8]');
  console.log('  node systems/assimilation/source_attestation_extension.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) { usage(); process.exit(0); }
  if (cmd === 'attest') out = attest(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'source_attestation_extension', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  attest,
  status
};
