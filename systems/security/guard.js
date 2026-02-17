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
 *
 * Output:
 *   - stdout: single JSON line (ok / blocked / break_glass)
 *   - stderr: human readable warnings/errors
 */

const fs = require("fs");
const path = require("path");

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
    ]
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

function emitJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
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

  const policy = loadPolicy();
  const clearance = asInt(process.env.CLEARANCE, 2);
  const breakGlass = String(process.env.BREAK_GLASS || "") === "1";
  let approvalNote = String(process.env.APPROVAL_NOTE || "").trim();
  if (approvalNote.length > 240) approvalNote = approvalNote.slice(0, 240);

  let required = 0;
  const reasons = [];
  for (const f of files) {
    const z = matchZone(policy, f);
    required = Math.max(required, z.min_clearance);
    reasons.push({ file: f, zone: z.label, min_clearance: z.min_clearance });
  }

  if (clearance >= required) {
    emitJson({
      ok: true,
      break_glass: false,
      ts: nowIso(),
      clearance,
      required,
      files,
      policy_version: policy.version
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
      policy_version: policy.version
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
    reasons
  });
  process.exit(1);
}

main();
