#!/usr/bin/env node
/**
 * systems/security/guard.js — deterministic clearance gate (machine-readable)
 *
 * Purpose:
 * - Enforce "harder to change infrastructure, easier to change habits"
 * - Provide a single choke-point for permission checks
 *
 * Usage:
 *   node systems/security/guard.js --files=path1,path2,...
 *
 * Env:
 *   CLEARANCE=1|2|3|4 (default: 2)
 *   BREAK_GLASS=1 (optional override; requires APPROVAL_NOTE)
 *   APPROVAL_NOTE="..." (required if BREAK_GLASS=1)
 *   REQUEST_SOURCE=local|slack|... (optional; remote sources default to proposal-only)
 *   REQUEST_ACTION=apply|propose|dry_run|audit (optional; default: apply)
 *   REQUEST_KEY_ID (optional key selector; uses REQUEST_GATE_SECRET_<KEY_ID>)
 *   REQUEST_TS / REQUEST_NONCE / REQUEST_SIG (optional; required for remote direct apply)
 *   REQUEST_GATE_SECRET (required for verifying remote direct signatures)
 *   REQUEST_REPLAY_STATE_PATH (optional override for replay-state JSON path)
 *   REMOTE_DIRECT_OVERRIDE=1 (required for remote direct apply)
 *   APPROVER_ID / SECOND_APPROVER_ID + SECOND_APPROVAL_NOTE (required for remote direct apply)
 *
 * Output:
 *   - stdout: single JSON line (ok / blocked / break_glass)
 *   - stderr: human readable warnings/errors
 */

const fs = require("fs");
const path = require("path");
const {
  verifyIntegrity,
  appendIntegrityEvent
} = require("../../lib/security_integrity.js");
const {
  verifySignedEnvelopeFromEnv
} = require("../../lib/request_envelope.js");

const RISKY_ENV_TOGGLE_RULES = [
  { key: "AUTONOMY_ENABLED", mode: "truthy" },
  { key: "AUTONOMY_MODEL_CATALOG_AUTO_APPLY", mode: "truthy" },
  { key: "AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS", mode: "truthy" },
  { key: "REMOTE_DIRECT_OVERRIDE", mode: "truthy" },
  { key: "BREAK_GLASS", mode: "truthy" },
  { key: "ALLOW_MISSING_DIRECTIVES", mode: "bool" },
  { key: "ALLOW_WEAK_T1_DIRECTIVES", mode: "bool" }
];

function parseArg(name) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}

function nowIso() {
  return new Date().toISOString();
}

function asInt(x, dflt) {
  const n = Number(x);
  return Number.isFinite(n) ? n : dflt;
}

function normalizeLower(v) {
  return String(v || "").trim().toLowerCase();
}

function repoRoot() {
  // This script is at systems/security/guard.js → repo root is ../../
  return path.resolve(__dirname, "..", "..");
}

function rel(p) {
  const root = repoRoot();
  const abs = path.resolve(root, p);
  return path.relative(root, abs).replace(/\\/g, "/");
}

function loadPolicy() {
  // Hardcoded + deterministic. No external IO dependencies.
  return {
    version: "1.0",
    zones: [
      { prefix: "systems/", min_clearance: 3, label: "infrastructure" },
      { prefix: "config/", min_clearance: 3, label: "configuration" },
      { prefix: "memory/", min_clearance: 3, label: "memory_tools" },
      { prefix: "habits/", min_clearance: 2, label: "habits_reflexes" },
      { prefix: "state/", min_clearance: 1, label: "state_data" }
    ],
    protected_files: [
      // e.g., "config/secrets.json", "config/root_keys.pem"
    ],
    remote_request_gate: {
      remote_sources: ["slack", "discord", "webhook", "email", "api", "remote", "moltbook"],
      proposal_actions: ["propose", "proposal", "dry_run", "audit"],
      require_break_glass_for_direct: true,
      require_dual_approval_for_direct: true,
      require_signed_envelope_for_remote_direct: true,
      require_nonce_replay_guard: true,
      envelope_max_skew_sec: 900,
      replay_ttl_sec: 7200,
      replay_state_max_entries: 5000,
      min_approval_note_chars: 12
    }
  };
}

function matchZone(policy, fileRel) {
  if (policy.protected_files.includes(fileRel)) {
    return { prefix: fileRel, min_clearance: 4, label: "protected_core" };
  }
  for (const z of policy.zones) {
    if (fileRel.startsWith(z.prefix)) return z;
  }
  return { prefix: "(default)", min_clearance: 3, label: "default_protect" };
}

function logBreakGlass(entry) {
  try {
    const root = repoRoot();
    const dir = path.join(root, "state", "security");
    const file = path.join(dir, "break_glass.jsonl");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // Never block execution because logging failed.
  }
}

function logRemoteGate(entry) {
  try {
    const root = repoRoot();
    const dir = path.join(root, "state", "security");
    const file = path.join(dir, "remote_request_gate.jsonl");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // Never block execution because logging failed.
  }
}

function logRiskyToggleGate(entry) {
  try {
    const root = repoRoot();
    const dir = path.join(root, "state", "security");
    const file = path.join(dir, "risky_env_toggle_gate.jsonl");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(entry) + "\n");
  } catch {
    // Never block execution because logging failed.
  }
}

function isTruthyEnv(v) {
  const s = String(v || "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

function detectRiskyEnvToggles(env, approvalNote) {
  const note = String(approvalNote || "").trim().toLowerCase();
  const active = [];
  for (const rule of RISKY_ENV_TOGGLE_RULES) {
    const raw = String(env && env[rule.key] || "").trim();
    if (!raw) continue;
    if (rule.mode === "truthy" && isTruthyEnv(raw)) {
      active.push(rule.key);
      continue;
    }
    if (rule.mode === "bool") {
      const boolVal = raw.toLowerCase();
      if (boolVal === "1" || boolVal === "true") active.push(rule.key);
    }
  }
  if (!active.length) {
    return {
      ok: true,
      active_toggles: [],
      reason: "no_risky_toggles"
    };
  }

  const hasMarker = /\benv[_\s-]?toggle\b/.test(note) || /\bmanual[_\s-]?approval\b/.test(note);
  const missingNoteKeys = active.filter((k) => !note.includes(k.toLowerCase()));
  const approved = hasMarker && missingNoteKeys.length === 0;
  return {
    ok: approved,
    active_toggles: active,
    has_marker: hasMarker,
    missing_note_keys: missingNoteKeys,
    reason: approved ? "manual_toggle_approval_present" : "manual_toggle_approval_missing"
  };
}

function replayStatePath() {
  const custom = String(process.env.REQUEST_REPLAY_STATE_PATH || "").trim();
  if (custom) return path.resolve(custom);
  return path.join(repoRoot(), "state", "security", "request_replay_nonces.json");
}

function loadReplayState(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { version: 1, entries: {} };
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!raw || typeof raw !== "object") return { version: 1, entries: {} };
    const entries = raw.entries && typeof raw.entries === "object" ? raw.entries : {};
    return { version: 1, entries };
  } catch {
    return { version: 1, entries: {} };
  }
}

function saveReplayState(filePath, state) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    version: 1,
    updated_at: nowIso(),
    entries: state && state.entries && typeof state.entries === "object" ? state.entries : {}
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
}

function recordReplayNonce({ source, nonce, ts, ttlSec = 7200, maxEntries = 5000 }) {
  const safeNonce = String(nonce || "").trim();
  if (safeNonce.length < 8 || safeNonce.length > 128) {
    return { ok: false, reason: "nonce_invalid" };
  }
  const safeSource = normalizeLower(source || "remote") || "remote";
  const filePath = replayStatePath();
  const nowMs = Date.now();
  const ttl = Math.max(120, Number(ttlSec || 7200));
  const max = Math.max(200, Number(maxEntries || 5000));
  const baseMs = Number.isFinite(Number(ts)) ? Math.floor(Number(ts) * 1000) : nowMs;
  const expiresMs = Math.max(nowMs, baseMs) + (ttl * 1000);
  const key = `${safeSource}|${safeNonce}`;

  try {
    const state = loadReplayState(filePath);
    const entries = state.entries || {};

    for (const k of Object.keys(entries)) {
      const exp = Number((entries[k] && entries[k].expires_ms) || 0);
      if (!exp || exp <= nowMs) delete entries[k];
    }

    const existing = entries[key];
    if (existing && Number(existing.expires_ms || 0) > nowMs) {
      return { ok: false, reason: "nonce_replay", path: filePath };
    }

    entries[key] = {
      ts: nowIso(),
      source: safeSource,
      nonce: safeNonce,
      request_ts: Number.isFinite(Number(ts)) ? Math.floor(Number(ts)) : null,
      expires_ms: expiresMs
    };

    const keys = Object.keys(entries);
    if (keys.length > max) {
      keys
        .sort((a, b) => Number(entries[a].expires_ms || 0) - Number(entries[b].expires_ms || 0))
        .slice(0, keys.length - max)
        .forEach((k) => {
          delete entries[k];
        });
    }

    saveReplayState(filePath, { version: 1, entries });
    return { ok: true, reason: "ok", path: filePath };
  } catch {
    return { ok: false, reason: "nonce_store_error", path: filePath };
  }
}

function evaluateRemoteRequestGate(policy, ctx) {
  const gate = policy && policy.remote_request_gate ? policy.remote_request_gate : {};
  const remoteSources = new Set((gate.remote_sources || []).map(normalizeLower).filter(Boolean));
  const proposalActions = new Set((gate.proposal_actions || []).map(normalizeLower).filter(Boolean));
  const source = normalizeLower(ctx.request_source || "local") || "local";
  const action = normalizeLower(ctx.request_action || "apply") || "apply";
  const isRemote = remoteSources.has(source);
  const minChars = Math.max(8, Number(gate.min_approval_note_chars || 12));
  const requireBreakGlass = gate.require_break_glass_for_direct !== false;
  const requireDual = gate.require_dual_approval_for_direct !== false;
  const requireSignature = gate.require_signed_envelope_for_remote_direct !== false;
  const requireReplayNonce = gate.require_nonce_replay_guard !== false;
  const maxSkewSec = Math.max(30, Number(gate.envelope_max_skew_sec || 900));
  const replayTtlSec = Math.max(120, Number(gate.replay_ttl_sec || 7200));
  const replayMaxEntries = Math.max(200, Number(gate.replay_state_max_entries || 5000));

  const result = {
    enabled: true,
    source,
    action,
    is_remote: isRemote,
    proposal_only_mode: isRemote,
    allowed: true,
    reason: isRemote ? "proposal_only_remote" : "local_source",
    missing: [],
    signature_required: false,
    signature_valid: null,
    signature_reason: null,
    replay_nonce_required: false,
    replay_nonce_valid: null,
    replay_nonce_reason: null,
    min_approval_note_chars: minChars
  };

  if (!isRemote) return result;
  if (proposalActions.has(action)) {
    result.reason = "proposal_action_allowed";
    return result;
  }

  if (String(ctx.remote_direct_override || "") !== "1") {
    result.missing.push("remote_direct_override");
  }
  if (requireBreakGlass && ctx.break_glass !== true) {
    result.missing.push("break_glass");
  }
  if (String(ctx.approval_note || "").trim().length < minChars) {
    result.missing.push("approval_note");
  }
  if (String(ctx.approver_id || "").trim().length < 2) {
    result.missing.push("approver_id");
  }
  if (requireDual) {
    if (String(ctx.second_approval_note || "").trim().length < minChars) {
      result.missing.push("second_approval_note");
    }
    if (String(ctx.second_approver_id || "").trim().length < 2) {
      result.missing.push("second_approver_id");
    }
  }
  if (requireSignature) {
    result.signature_required = true;
    const sigCheck = verifySignedEnvelopeFromEnv({
      env: ctx.env || process.env,
      files: Array.isArray(ctx.files) ? ctx.files : [],
      secret: String(ctx.request_gate_secret || "").trim(),
      maxSkewSec
    });
    result.signature_valid = sigCheck.ok === true;
    result.signature_reason = sigCheck.reason || null;
    if (!sigCheck.ok) {
      result.missing.push("request_signature");
    }
  }
  if (requireReplayNonce && result.signature_valid === true) {
    result.replay_nonce_required = true;
    const replayCheck = recordReplayNonce({
      source,
      nonce: ctx && ctx.env ? ctx.env.REQUEST_NONCE : null,
      ts: ctx && ctx.env ? ctx.env.REQUEST_TS : null,
      ttlSec: replayTtlSec,
      maxEntries: replayMaxEntries
    });
    result.replay_nonce_valid = replayCheck.ok === true;
    result.replay_nonce_reason = replayCheck.reason || null;
    if (!replayCheck.ok) {
      result.missing.push("request_nonce_replay");
    }
  }

  if (result.missing.length) {
    result.allowed = false;
    result.reason = "remote_direct_apply_disallowed";
  } else {
    result.reason = "remote_direct_apply_allowed";
  }
  return result;
}

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function topViolations(violations, limit = 5) {
  if (!Array.isArray(violations)) return [];
  return violations.slice(0, limit).map(v => ({
    type: v && v.type ? v.type : "unknown",
    file: v && v.file ? v.file : null
  }));
}

function main() {
  const filesArg = parseArg("files");
  const files = (filesArg ? filesArg.split(",") : [])
    .map(s => s.trim())
    .filter(Boolean)
    .map(rel);

  if (!files.length) {
    process.stderr.write("guard: missing --files=...\n");
    emitJson({ ok: false, blocked: true, reason: "missing_files", ts: nowIso() });
    process.exit(2);
  }

  const enforceIntegrity = String(process.env.KERNEL_INTEGRITY_ENFORCE || "1") !== "0";
  if (enforceIntegrity) {
    const integrity = verifyIntegrity();
    if (!integrity.ok) {
      appendIntegrityEvent({
        ts: nowIso(),
        type: "integrity_violation_block",
        source: "systems/security/guard.js",
        violation_counts: integrity.violation_counts || {},
        violations: topViolations(integrity.violations, 12),
        policy_version: integrity.policy_version || null,
        policy_path: integrity.policy_path || null
      });
      process.stderr.write("guard: BLOCKED (integrity kernel)\n");
      process.stderr.write(`  policy=${String(integrity.policy_path || "").slice(0, 200)}\n`);
      process.stderr.write(`  violations=${JSON.stringify(integrity.violation_counts || {})}\n`);
      for (const v of topViolations(integrity.violations, 6)) {
        process.stderr.write(`    - ${v.type}${v.file ? ` (${v.file})` : ""}\n`);
      }
      emitJson({
        ok: false,
        blocked: true,
        break_glass: false,
        reason: "integrity_violation",
        ts: nowIso(),
        integrity: {
          policy_version: integrity.policy_version || null,
          policy_path: integrity.policy_path || null,
          checked_present_files: Number(integrity.checked_present_files || 0),
          expected_files: Number(integrity.expected_files || 0),
          violation_counts: integrity.violation_counts || {},
          violations: topViolations(integrity.violations, 12)
        }
      });
      process.exit(1);
    }
  }

  const policy = loadPolicy();
  const clearance = asInt(process.env.CLEARANCE, 2);
  const breakGlass = String(process.env.BREAK_GLASS || "") === "1";
  let approvalNote = String(process.env.APPROVAL_NOTE || "").trim();
  if (approvalNote.length > 240) approvalNote = approvalNote.slice(0, 240);
  const requestSource = String(process.env.REQUEST_SOURCE || "local").trim();
  const requestAction = String(process.env.REQUEST_ACTION || "apply").trim();
  const remoteDirectOverride = String(process.env.REMOTE_DIRECT_OVERRIDE || "").trim();
  const approverId = String(process.env.APPROVER_ID || process.env.APPROVER || "").trim();
  let secondApprovalNote = String(process.env.SECOND_APPROVAL_NOTE || "").trim();
  if (secondApprovalNote.length > 240) secondApprovalNote = secondApprovalNote.slice(0, 240);
  const secondApproverId = String(process.env.SECOND_APPROVER_ID || process.env.SECOND_APPROVER || "").trim();

  let required = 0;
  const reasons = [];
  for (const f of files) {
    const z = matchZone(policy, f);
    required = Math.max(required, z.min_clearance);
    reasons.push({ file: f, zone: z.label, min_clearance: z.min_clearance });
  }

  const remoteGate = evaluateRemoteRequestGate(policy, {
    request_source: requestSource,
    request_action: requestAction,
    break_glass: breakGlass,
    approval_note: approvalNote,
    approver_id: approverId,
    second_approval_note: secondApprovalNote,
    second_approver_id: secondApproverId,
    remote_direct_override: remoteDirectOverride,
    request_gate_secret: String(process.env.REQUEST_GATE_SECRET || "").trim(),
    files,
    env: process.env
  });

  if (remoteGate.is_remote) {
    logRemoteGate({
      ts: nowIso(),
      source: remoteGate.source,
      action: remoteGate.action,
      allowed: remoteGate.allowed,
      reason: remoteGate.reason,
      missing: remoteGate.missing,
      files,
      required_clearance: required
    });
  }

  if (remoteGate.allowed !== true) {
    process.stderr.write("guard: BLOCKED (remote request gate)\n");
    process.stderr.write(`  source=${remoteGate.source} action=${remoteGate.action}\n`);
    if (Array.isArray(remoteGate.missing) && remoteGate.missing.length) {
      process.stderr.write(`  missing: ${remoteGate.missing.join(", ")}\n`);
    }
    emitJson({
      ok: false,
      blocked: true,
      break_glass: breakGlass,
      ts: nowIso(),
      reason: remoteGate.reason,
      clearance,
      required,
      files,
      policy_version: policy.version,
      request_source: requestSource || "local",
      request_action: requestAction || "apply",
      remote_policy: remoteGate,
      reasons
    });
    process.exit(1);
  }

  const riskyToggleGate = detectRiskyEnvToggles(process.env, approvalNote);
  logRiskyToggleGate({
    ts: nowIso(),
    source: requestSource || "local",
    action: requestAction || "apply",
    allowed: riskyToggleGate.ok === true,
    reason: riskyToggleGate.reason || null,
    active_toggles: riskyToggleGate.active_toggles || [],
    missing_note_keys: riskyToggleGate.missing_note_keys || [],
    files
  });
  if (riskyToggleGate.ok !== true) {
    process.stderr.write("guard: BLOCKED (risky env toggle gate)\n");
    process.stderr.write(`  active_toggles=${(riskyToggleGate.active_toggles || []).join(",")}\n`);
    process.stderr.write('  approval_note must include "env_toggle" + each risky env key name\n');
    emitJson({
      ok: false,
      blocked: true,
      break_glass: breakGlass,
      ts: nowIso(),
      reason: "risky_env_toggle_requires_manual_approval",
      clearance,
      required,
      files,
      policy_version: policy.version,
      request_source: requestSource || "local",
      request_action: requestAction || "apply",
      remote_policy: remoteGate,
      risky_toggle_policy: riskyToggleGate,
      reasons
    });
    process.exit(1);
  }

  if (clearance >= required) {
    emitJson({
      ok: true,
      break_glass: false,
      ts: nowIso(),
      clearance,
      required,
      files,
      policy_version: policy.version,
      request_source: requestSource || "local",
      request_action: requestAction || "apply",
      remote_policy: remoteGate,
      risky_toggle_policy: riskyToggleGate
    });
    return;
  }

  if (breakGlass) {
    if (!approvalNote) {
      process.stderr.write("guard: BREAK_GLASS=1 requires APPROVAL_NOTE\n");
      emitJson({
        ok: false,
        blocked: true,
        break_glass: true,
        ts: nowIso(),
        clearance,
        required,
        files,
        policy_version: policy.version,
        reasons
      });
      process.exit(1);
    }
    logBreakGlass({
      ts: nowIso(),
      clearance,
      required,
      approval_note: approvalNote,
      approver_id: approverId || null,
      second_approver_id: secondApproverId || null,
      request_source: requestSource || "local",
      request_action: requestAction || "apply",
      files,
      reasons,
      policy_version: policy.version
    });
    process.stderr.write(`guard: BREAK_GLASS allowed (clearance=${clearance}, required=${required})\n`);
    emitJson({
      ok: true,
      break_glass: true,
      ts: nowIso(),
      clearance,
      required,
      files,
      policy_version: policy.version,
      request_source: requestSource || "local",
      request_action: requestAction || "apply",
      remote_policy: remoteGate,
      risky_toggle_policy: riskyToggleGate
    });
    return;
  }

  process.stderr.write("guard: BLOCKED\n");
  process.stderr.write(`  clearance=${clearance}, required=${required}\n`);
  process.stderr.write("  files:\n");
  for (const r of reasons) {
    process.stderr.write(`    - ${r.file} (zone=${r.zone}, min_clearance=${r.min_clearance})\n`);
  }
  process.stderr.write("  To override (not recommended):\n");
  process.stderr.write('    BREAK_GLASS=1 APPROVAL_NOTE="why" CLEARANCE=<your_level> node ...\n');

  emitJson({
    ok: false,
    blocked: true,
    break_glass: false,
    ts: nowIso(),
    clearance,
    required,
    files,
    policy_version: policy.version,
    reason: "insufficient_clearance",
    request_source: requestSource || "local",
    request_action: requestAction || "apply",
    remote_policy: remoteGate,
    risky_toggle_policy: riskyToggleGate,
    reasons
  });
  process.exit(1);
}

main();
export {};
