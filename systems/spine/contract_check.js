#!/usr/bin/env node
/**
 * systems/spine/contract_check.js — deterministic interface validation
 *
 * Goal:
 * - Prevent silent coupling breakage between spine, queue_gc, git_outcomes,
 *   proposal_queue, sensory_queue, eyes_insight, external_eyes, etc.
 *
 * Strategy:
 * - Run each coupled script in "help/usage" mode
 * - Assert required tokens exist in output
 * - Allow non-zero exit codes that still produce usage text (common for CLI tools)
 *
 * This is NOT a policy engine. It's a smoke test for contracts.
 */

const { spawnSync } = require("child_process");
const path = require("path");

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function runCapture(args) {
  // Capture both streams to scan text; keep deterministic
  const r = spawnSync("node", args, { encoding: "utf8" });
  const out = (r.stdout || "") + " " + (r.stderr || "");
  return { code: r.status ?? 0, text: out };
}

function missingTokens(text, tokens) {
  const missing = [];
  for (const t of tokens) {
    if (!text.includes(t)) missing.push(t);
  }
  return missing;
}

function formatProbe(probeArgs) {
  return probeArgs.length ? probeArgs.join(" ") : "(no args)";
}

function checkUsage(relPath, probeArgs, requiredTokens) {
  const root = repoRoot();
  const abs = path.join(root, relPath);
  const r = runCapture([abs, ...probeArgs]);
  const missing = missingTokens(r.text, requiredTokens);

  if (r.code === 0 && missing.length === 0) return;

  console.error("contract_check: FAILED");
  console.error(` script: ${relPath}`);
  console.error(` probe: ${formatProbe(probeArgs)}`);
  console.error(` exit_code: ${r.code}`);
  if (missing.length) {
    console.error(` missing tokens: ${missing.join(", ")}`);
  }
  process.exit(1);
}

function checkScript(relPath, requiredTokens) {
  // Standard contract for all validated CLIs:
  //   1) --help prints usage and exits 0
  //   2) no-arg prints usage and exits 0
  checkUsage(relPath, ["--help"], requiredTokens);
  checkUsage(relPath, [], requiredTokens);
}

function main() {
  // Keep this list small and only for scripts that are hard-coupled by spine.
  // If you rename commands/flags in any of these, update tokens here.

  // external_eyes.js should advertise core commands
  checkScript(
    "habits/scripts/external_eyes.js",
    ["external_eyes.js", "run", "score", "evolve", "list"]
  );

  // eyes_insight.js should advertise run + date usage
  checkScript(
    "habits/scripts/eyes_insight.js",
    ["eyes_insight.js", "run"]
  );

  // sensory_queue.js should have ingest + list
  checkScript(
    "habits/scripts/sensory_queue.js",
    ["sensory_queue.js", "ingest", "list"]
  );

  // proposal_queue.js is used by gc/outcomes; require outcome keyword
  // (If you later namespace tags, update this token list.)
  checkScript(
    "habits/scripts/proposal_queue.js",
    ["proposal_queue.js", "outcome"]
  );

  // queue_gc.js is required by daily spine mode.
  checkScript(
    "habits/scripts/queue_gc.js",
    ["queue_gc.js", "run"]
  );

  // git_outcomes.js is required by daily spine mode.
  checkScript(
    "habits/scripts/git_outcomes.js",
    ["git_outcomes.js", "run"]
  );

  // improvement_lane.js is a habits compatibility wrapper.
  checkScript(
    "habits/scripts/improvement_lane.js",
    ["propose", "start-next", "evaluate-open"]
  );

  // improvement_orchestrator.js owns guarded improvement lane orchestration.
  checkScript(
    "systems/autonomy/improvement_orchestrator.js",
    ["improvement_orchestrator.js", "propose", "start-next", "evaluate-open"]
  );

  // autonomy_controller.js is optional by flag, but contract should remain valid.
  checkScript(
    "systems/autonomy/autonomy_controller.js",
    ["autonomy_controller.js", "run", "status"]
  );

  // improvement_controller.js manages bounded trial + rollback for self-improvements.
  checkScript(
    "systems/autonomy/improvement_controller.js",
    ["improvement_controller.js", "start", "evaluate", "status"]
  );

  // route_execute.js is called by autonomy_controller run path.
  checkScript(
    "systems/routing/route_execute.js",
    ["route_execute.js", "--task"]
  );

  // route_task.js is the decision contract consumed by route_execute.
  checkUsage(
    "systems/routing/route_task.js",
    ["--task", "contract_check_probe", "--tokens_est", "0", "--repeats_14d", "0", "--errors_30d", "0"],
    ["decision", "gate_decision"]
  );

  console.log("contract_check: OK");
}

main();
