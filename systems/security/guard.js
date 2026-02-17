#!/usr/bin/env node
/**
 * systems/security/guard.js — deterministic clearance gate
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
 * Behavior:
 * - If any file is in a protected zone and caller clearance is too low -> exit(1)
 * - If BREAK_GLASS=1 and APPROVAL_NOTE is present -> allow but log the event
 *
 * Notes:
 * - This guard is intentionally simple. It's meant to be reliable and deterministic.
 * - It doesn't try to infer intent; it just checks paths.
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
  // You can later move this into config/security_policy.json if desired.
  // For now: hardcoded, deterministic, no IO dependencies.
  return {
    version: "1.0",
    // Minimum clearance required to *touch* (execute/modify) these zones.
    // (We treat running orchestration scripts as "touching" infrastructure.)
    zones: [
      { prefix: "systems/", min_clearance: 3, label: "infrastructure" },
      { prefix: "config/", min_clearance: 3, label: "configuration" },
      { prefix: "memory/", min_clearance: 3, label: "memory_tools" },
      // Habits are intended to be easy to change.
      { prefix: "habits/", min_clearance: 2, label: "habits_reflexes" },
      // State is writable by lower tiers; it's data, not code.
      { prefix: "state/", min_clearance: 1, label: "state_data" }
    ],
    // Explicitly protected files (even if outside systems/)
    // These require clearance 4 - the highest tier
    // NOTE: guard.js is NOT here; it's systems/ (clearance 3) so it can be called
    protected_files: [
      // e.g., "config/secrets.json", "config/root_keys.pem"
    ]
  };
}

function matchZone(policy, fileRel) {
  // Exact protected file match wins.
  if (policy.protected_files.includes(fileRel)) {
    return { prefix: fileRel, min_clearance: 4, label: "protected_core" };
  }
  for (const z of policy.zones) {
    if (fileRel.startsWith(z.prefix)) return z;
  }
  // Default: treat unknown as infra-ish to be safe.
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

function main() {
  const filesArg = parseArg("files");
  const files = (filesArg ? filesArg.split(",") : [])
    .map(s => s.trim())
    .filter(Boolean)
    .map(rel);

  if (!files.length) {
    console.error("guard: missing --files=...");
    process.exit(2);
  }

  const policy = loadPolicy();
  const clearance = asInt(process.env.CLEARANCE, 2);
  const breakGlass = String(process.env.BREAK_GLASS || "") === "1";
  const approvalNote = String(process.env.APPROVAL_NOTE || "").trim();

  // Determine highest required clearance across all files.
  let required = 0;
  const reasons = [];
  for (const f of files) {
    const z = matchZone(policy, f);
    required = Math.max(required, z.min_clearance);
    reasons.push({ file: f, zone: z.label, min_clearance: z.min_clearance });
  }

  if (clearance >= required) {
    return;
  }

  // Break glass path
  if (breakGlass) {
    if (!approvalNote) {
      console.error("guard: BREAK_GLASS=1 requires APPROVAL_NOTE");
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
    console.warn(`guard: BREAK_GLASS allowed (clearance=${clearance}, required=${required})`);
    return;
  }

  console.error("guard: BLOCKED");
  console.error(`  clearance=${clearance}, required=${required}`);
  console.error("  files:");
  for (const r of reasons) {
    console.error(`    - ${r.file} (zone=${r.zone}, min_clearance=${r.min_clearance})`);
  }
  console.error("  To override (not recommended):");
  console.error('    BREAK_GLASS=1 APPROVAL_NOTE="why" CLEARANCE=<your_level> node ...');
  process.exit(1);
}

main();
