#!/usr/bin/env node
/**
 * systems/spine/spine.js — orchestration spine (plumbing only)
 *
 * Spine responsibilities:
 * - Sequence layers in a deterministic order
 * - Call systems/security/guard.js as the choke point
 * - Emit one run record (ledger) — not policy, not scoring
 *
 * What spine is NOT:
 * - Not the place for habits
 * - Not the place for scoring logic
 * - Not the place for LLM prompting
 *
 * Usage:
 *   node systems/spine/spine.js eyes [YYYY-MM-DD] [--max-eyes=N]
 *   node systems/spine/spine.js daily [YYYY-MM-DD] [--max-eyes=N]
 *
 * Env:
 *   CLEARANCE=1|2|3|4 (default: 3 here, because spine is infra)
 *   BREAK_GLASS=1, APPROVAL_NOTE="..." (optional)
 */

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

function arg(name) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}

function todayOr(dateStr) {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return new Date().toISOString().slice(0, 10);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) process.exit(r.status || 1);
}

function guard(files) {
  // guard expects repo-relative paths
  run("node", ["systems/security/guard.js", `--files=${files.join(",")}`]);
}

function nowIso() {
  return new Date().toISOString();
}

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function appendLedger(dateStr, evt) {
  try {
    const root = repoRoot();
    const dir = path.join(root, "state", "spine", "runs");
    const file = path.join(dir, `${dateStr}.jsonl`);
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(evt) + "\n");
  } catch {
    // ledger must never block spine execution
  }
}

function main() {
  const mode = process.argv[2];
  const dateStr = todayOr(process.argv[3]);
  const maxEyes = arg("max-eyes");

  // spine is infra: default clearance 3 if not explicitly set
  if (!process.env.CLEARANCE) process.env.CLEARANCE = "3";

  if (!mode || (mode !== "eyes" && mode !== "daily")) {
    console.error("Usage:");
    console.error("  node systems/spine/spine.js eyes [YYYY-MM-DD] [--max-eyes=N]");
    console.error("  node systems/spine/spine.js daily [YYYY-MM-DD] [--max-eyes=N]");
    process.exit(2);
  }

  // Declare what we will touch (guarded)
  const invoked = [
    "systems/spine/spine.js",
    "systems/security/guard.js",
    "habits/scripts/external_eyes.js",
    "habits/scripts/eyes_insight.js",
    "habits/scripts/sensory_queue.js"
  ];

  // daily mode adds optional deterministic helpers (still habits)
  if (mode === "daily") {
    invoked.push("habits/scripts/git_outcomes.js");
  }

  // Clearance gate
  guard(invoked);

  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_run_started",
    mode,
    date: dateStr,
    max_eyes: maxEyes || null,
    files_touched: invoked
  });

  // EYES PIPELINE (always included in both modes)
  const runArgs = ["habits/scripts/external_eyes.js", "run"];
  if (maxEyes) runArgs.push(`--max-eyes=${maxEyes}`);
  run("node", runArgs);

  run("node", ["habits/scripts/external_eyes.js", "score", dateStr]);
  run("node", ["habits/scripts/external_eyes.js", "evolve", dateStr]);

  run("node", ["habits/scripts/eyes_insight.js", "run", dateStr]);
  run("node", ["habits/scripts/sensory_queue.js", "ingest", dateStr]);
  run("node", ["habits/scripts/sensory_queue.js", "list", `--date=${dateStr}`]);

  if (mode === "daily") {
    // deterministic: auto-record shipped outcomes from git commit tags
    run("node", ["habits/scripts/git_outcomes.js", "run", dateStr]);
  }

  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_run_ok",
    mode,
    date: dateStr
  });

  console.log(` ✅ spine complete (${mode}) for ${dateStr}`);
}

main();
