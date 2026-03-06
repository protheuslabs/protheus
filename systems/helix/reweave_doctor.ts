#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { collectProtectedFiles, buildHelixManifest, verifyHelixManifest } = require('./strand_verifier');
const { loadCodex } = require('./codex_root');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const token = cleanText(raw || fallbackRel, 360);
  if (!token) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(token) ? token : path.join(ROOT, token);
}

function planReweave(sentinel: AnyObj = {}, verifier: AnyObj = {}, policy: AnyObj = {}, opts: AnyObj = {}) {
  const tier = String(sentinel && sentinel.tier || 'clear');
  const shadowOnly = policy && policy.shadow_only !== false;
  const mismatches = Array.isArray(verifier && verifier.mismatches) ? verifier.mismatches : [];
  const changedFiles = mismatches
    .map((row: AnyObj) => String(row && row.file || '').trim())
    .filter(Boolean);
  const planId = `rwv_${crypto.randomBytes(6).toString('hex')}`;
  const strategy = tier === 'confirmed_malice'
    ? 'full_restore_from_last_good_manifest'
    : (
      changedFiles.length
        ? 'targeted_strand_reweave'
        : 'noop_verify_only'
    );
  const steps: AnyObj[] = [];
  if (strategy === 'targeted_strand_reweave') {
    steps.push({ step: 'freeze_affected_lanes', apply: !shadowOnly, shadow: shadowOnly });
    steps.push({ step: 'restore_changed_files_from_signed_source', apply: !shadowOnly, shadow: shadowOnly });
    steps.push({ step: 'rebuild_helix_manifest', apply: !shadowOnly, shadow: shadowOnly });
    steps.push({ step: 'verify_attestation', apply: !shadowOnly, shadow: shadowOnly });
  } else if (strategy === 'full_restore_from_last_good_manifest') {
    steps.push({ step: 'global_actuation_freeze', apply: !shadowOnly, shadow: shadowOnly });
    steps.push({ step: 'restore_full_protected_scope', apply: !shadowOnly, shadow: shadowOnly });
    steps.push({ step: 'reseed_codex_chain', apply: !shadowOnly, shadow: shadowOnly });
    steps.push({ step: 'reverify_and_resume_by_policy', apply: !shadowOnly, shadow: shadowOnly });
  } else {
    steps.push({ step: 'verify_only', apply: false, shadow: true });
  }
  return {
    ok: true,
    type: 'helix_reweave_plan',
    ts: nowIso(),
    plan_id: planId,
    strategy,
    tier,
    shadow_only: shadowOnly,
    reason: cleanText(opts.reason || '', 180) || null,
    changed_files: changedFiles.slice(0, 5000),
    steps
  };
}

function reweavePaths(policy: AnyObj = {}, opts: AnyObj = {}) {
  const base = {
    snapshot_path: 'state/helix/reweave_snapshot.json',
    receipts_path: 'state/helix/reweave_receipts.jsonl',
    quarantine_dir: 'state/helix/reweave_quarantine'
  };
  const cfg = policy && policy.reweave && typeof policy.reweave === 'object' ? policy.reweave : {};
  return {
    snapshot_path: resolvePath(cfg.snapshot_path, base.snapshot_path),
    receipts_path: resolvePath(cfg.receipts_path, base.receipts_path),
    quarantine_dir: resolvePath(cfg.quarantine_dir, base.quarantine_dir),
    manifest_path: resolvePath(opts.manifest_path || 'state/helix/manifest.json', 'state/helix/manifest.json'),
    codex_path: resolvePath(opts.codex_path || 'codex.helix', 'codex.helix')
  };
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function captureReweaveSnapshot(policy: AnyObj = {}, opts: AnyObj = {}) {
  const files = collectProtectedFiles(policy);
  const paths = reweavePaths(policy, opts);
  const rows: AnyObj[] = [];
  for (const relPath of files) {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) continue;
    const buf = fs.readFileSync(abs);
    rows.push({
      file: relPath,
      sha256: crypto.createHash('sha256').update(buf).digest('hex'),
      size_bytes: Number(buf.length || 0),
      content_b64: buf.toString('base64')
    });
  }
  const payload = {
    schema_id: 'helix_reweave_snapshot',
    schema_version: '1.0',
    created_at: nowIso(),
    file_count: rows.length,
    files: rows
  };
  writeJsonAtomic(paths.snapshot_path, payload);
  appendJsonl(paths.receipts_path, {
    ts: nowIso(),
    type: 'helix_reweave_snapshot',
    ok: true,
    file_count: rows.length,
    snapshot_path: rel(paths.snapshot_path)
  });
  return {
    ok: true,
    type: 'helix_reweave_snapshot',
    snapshot_path: rel(paths.snapshot_path),
    file_count: rows.length
  };
}

function applyReweave(plan: AnyObj = {}, verifier: AnyObj = {}, policy: AnyObj = {}, opts: AnyObj = {}) {
  const applyRequested = toBool(opts.apply, false);
  const shadowOnly = policy && policy.shadow_only !== false;
  const requireApproval = policy
    && policy.reweave
    && policy.reweave.require_approval_note !== false;
  const approvalNote = cleanText(opts.approval_note || '', 220) || null;
  if (!applyRequested || shadowOnly) {
    return {
      ok: true,
      type: 'helix_reweave_apply',
      applied: false,
      reason: !applyRequested ? 'apply_not_requested' : 'shadow_only_mode',
      restored_files: [],
      quarantined_files: []
    };
  }
  if (requireApproval && !approvalNote) {
    return {
      ok: false,
      type: 'helix_reweave_apply',
      error: 'approval_note_required',
      applied: false
    };
  }

  const paths = reweavePaths(policy, opts);
  const snapshot = readJson(paths.snapshot_path, {});
  const snapshotFiles = Array.isArray(snapshot.files) ? snapshot.files : [];
  const byFile = new Map<string, AnyObj>();
  for (const row of snapshotFiles) {
    const key = cleanText(row && row.file || '', 300);
    if (!key) continue;
    byFile.set(key, row);
  }

  const mismatches = Array.isArray(verifier && verifier.mismatches) ? verifier.mismatches : [];
  const touched = new Set<string>();
  const restored: string[] = [];
  const quarantined: string[] = [];
  const quarantineRoot = path.join(paths.quarantine_dir, nowIso().replace(/[:.]/g, '-'));
  for (const row of mismatches) {
    const file = cleanText(row && row.file || '', 300);
    if (!file) continue;
    touched.add(file);
    const abs = path.join(ROOT, file);
    const snap = byFile.get(file);
    if (snap && snap.content_b64) {
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, Buffer.from(String(snap.content_b64), 'base64'));
      restored.push(file);
      continue;
    }
    if (fs.existsSync(abs)) {
      const quarantineTarget = path.join(quarantineRoot, file);
      ensureDir(path.dirname(quarantineTarget));
      fs.renameSync(abs, quarantineTarget);
      quarantined.push(file);
    }
  }

  for (const file of Array.from(byFile.keys())) {
    if (touched.has(file)) continue;
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) {
      const snap = byFile.get(file);
      if (snap && snap.content_b64) {
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, Buffer.from(String(snap.content_b64), 'base64'));
        restored.push(file);
      }
    }
  }

  const codex = loadCodex(paths.codex_path);
  const manifest = buildHelixManifest(codex, policy, { generated_at: nowIso() });
  writeJsonAtomic(paths.manifest_path, manifest);
  const verify = verifyHelixManifest(codex, manifest, policy);
  const out = {
    ok: verify.ok === true,
    type: 'helix_reweave_apply',
    ts: nowIso(),
    applied: true,
    approval_note: approvalNote,
    restored_files: restored,
    quarantined_files: quarantined,
    quarantine_root: quarantined.length ? rel(quarantineRoot) : null,
    manifest_path: rel(paths.manifest_path),
    verify: {
      ok: verify.ok === true,
      mismatch_count: Array.isArray(verify.mismatches) ? verify.mismatches.length : 0
    }
  };
  appendJsonl(paths.receipts_path, out);
  return out;
}

module.exports = {
  planReweave,
  captureReweaveSnapshot,
  applyReweave
};
