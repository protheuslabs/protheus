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
const fs = require("fs");

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

function checkSourceContains(relPath, requiredTokens) {
  const root = repoRoot();
  const abs = path.join(root, relPath);
  let text = "";
  try {
    text = fs.readFileSync(abs, "utf8");
  } catch (err) {
    console.error("contract_check: FAILED");
    console.error(` script: ${relPath}`);
    console.error(` read_error: ${String(err && err.message ? err.message : err)}`);
    process.exit(1);
  }
  const missing = missingTokens(text, requiredTokens);
  if (missing.length === 0) return;
  console.error("contract_check: FAILED");
  console.error(` script: ${relPath}`);
  console.error(` missing source tokens: ${missing.join(", ")}`);
  process.exit(1);
}

function main() {
  // Keep this list small and only for scripts that are hard-coupled by spine.
  // If you rename commands/flags in any of these, update tokens here.

  // external_eyes.js should advertise core commands
  checkScript(
    "habits/scripts/external_eyes.js",
    ["external_eyes.js", "run", "score", "evolve", "list"]
  );
  checkSourceContains(
    "habits/scripts/external_eyes.js",
    ["buildCollectorRemediationProposal", "action_spec", "success_criteria"]
  );

  // eyes_intake.js should enforce directive-linked eye creation in sensory layer.
  checkScript(
    "systems/sensory/eyes_intake.js",
    ["eyes_intake.js", "create", "validate", "list-directives"]
  );

  // adaptive_layer_guard.js enforces channelized writes for adaptive-layer files.
  checkScript(
    "systems/sensory/adaptive_layer_guard.js",
    ["adaptive_layer_guard.js", "run", "--strict"]
  );
  checkUsage(
    "systems/sensory/adaptive_layer_guard.js",
    ["run", "--strict"],
    ['"ok": true']
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
    ["autonomy_controller.js", "run", "evidence", "readiness", "status"]
  );

  // canary_scheduler.js gates execution on readiness and always emits scheduler receipts.
  checkScript(
    "systems/autonomy/canary_scheduler.js",
    ["canary_scheduler.js", "run", "status"]
  );

  // proposal_enricher.js normalizes proposal meta/admission prior to autonomy selection.
  checkScript(
    "systems/autonomy/proposal_enricher.js",
    ["proposal_enricher.js", "run"]
  );

  // bridge_from_proposals.js must normalize legacy proposals into executable action_spec with success criteria.
  checkScript(
    "systems/actuation/bridge_from_proposals.js",
    ["bridge_from_proposals.js", "run", "--dry-run"]
  );
  checkSourceContains(
    "systems/actuation/bridge_from_proposals.js",
    ["normalizeActionSpec", "success_criteria", "requiresActionSpecContract"]
  );

  // receipt_summary.js reports deterministic run/receipt pass-fail scorecards.
  checkScript(
    "systems/autonomy/receipt_summary.js",
    ["receipt_summary.js", "run", "--days"]
  );

  // strategy_doctor.js validates/prints active strategy profile and effective policy.
  checkScript(
    "systems/autonomy/strategy_doctor.js",
    ["strategy_doctor.js", "--strict", "--id"]
  );

  // strategy_readiness.js reports score_only->execute readiness using deterministic checks.
  checkScript(
    "systems/autonomy/strategy_readiness.js",
    ["strategy_readiness.js", "run", "--days", "--strict"]
  );

  // strategy_mode.js manages status/recommend/set with readiness and approval note safeguards.
  checkScript(
    "systems/autonomy/strategy_mode.js",
    ["strategy_mode.js", "status", "recommend", "set", "--mode", "--approval-note", "--approver-id", "--second-approver-id", "--second-approval-note"]
  );

  // strategy_execute_guard.js auto-reverts execute mode on repeated readiness failure.
  checkScript(
    "systems/autonomy/strategy_execute_guard.js",
    ["strategy_execute_guard.js", "run", "status", "--days"]
  );

  // strategy_mode_governor.js applies deterministic score_only/canary/execute transitions.
  checkScript(
    "systems/autonomy/strategy_mode_governor.js",
    ["strategy_mode_governor.js", "run", "status", "--days"]
  );

  // emergency_stop.js provides one-command kill-switch for autonomy/routing/actuation.
  checkScript(
    "systems/security/emergency_stop.js",
    ["emergency_stop.js", "status", "engage", "release", "--approval-note"]
  );

  // improvement_controller.js manages bounded trial + rollback for self-improvements.
  checkScript(
    "systems/autonomy/improvement_controller.js",
    ["improvement_controller.js", "start", "evaluate", "status"]
  );

  // model_catalog_loop.js manages built-in model catalog propose/trial/report/apply capability.
  checkScript(
    "systems/autonomy/model_catalog_loop.js",
    ["model_catalog_loop.js", "propose", "trial", "report", "review", "approve", "reject", "apply"]
  );

  // model_catalog_rollback.js restores latest routing snapshot under elevated clearance.
  checkScript(
    "systems/autonomy/model_catalog_rollback.js",
    ["model_catalog_rollback.js", "latest", "approval-note"]
  );

  // route_execute.js is called by autonomy_controller run path.
  checkScript(
    "systems/routing/route_execute.js",
    ["route_execute.js", "--task"]
  );

  // eyes_memory_bridge.js wires enriched sensory proposals into memory nodes + pointer logs.
  checkScript(
    "systems/memory/eyes_memory_bridge.js",
    ["eyes_memory_bridge.js", "run", "status"]
  );

  // memory_dream.js synthesizes recent memory pointers into deterministic dream sheets.
  checkScript(
    "systems/memory/memory_dream.js",
    ["memory_dream.js", "run", "status"]
  );

  // idle_dream_cycle.js runs local-LLM idle dreaming + REM quantization passes.
  checkScript(
    "systems/memory/idle_dream_cycle.js",
    ["idle_dream_cycle.js", "run", "status", "--rem-only=1"]
  );

  // uid_connections.js crystallizes uid graph links and adaptive-memory suggestions.
  checkScript(
    "systems/memory/uid_connections.js",
    ["uid_connections.js", "build", "status"]
  );

  // creative_links.js promotes useful dream links into first-class memory nodes.
  checkScript(
    "systems/memory/creative_links.js",
    ["creative_links.js", "run", "status"]
  );

  // router_budget_calibration.js calibrates routing token multipliers with rollback support.
  checkScript(
    "systems/routing/router_budget_calibration.js",
    ["router_budget_calibration.js", "run", "apply", "rollback"]
  );

  // route_task.js is the decision contract consumed by route_execute.
  checkUsage(
    "systems/routing/route_task.js",
    ["--task", "contract_check_probe", "--tokens_est", "0", "--repeats_14d", "0", "--errors_30d", "0"],
    ["decision", "gate_decision"]
  );

  // habit_crystallizer.js is the habits-layer routine scaffolder used by route_task propose path.
  checkScript(
    "habits/scripts/habit_crystallizer.js",
    ["habit_crystallizer.js", "--from", "tokens_est", "repeats_14d"]
  );

  // install_skill_safe.js enforces skill install quarantine + trust pin workflow.
  checkScript(
    "habits/scripts/install_skill_safe.js",
    ["install_skill_safe.js", "--spec", "--dry-run", "--approve"]
  );

  // skill_quarantine.js provides deterministic inspect/verify/hash checks.
  checkScript(
    "systems/security/skill_quarantine.js",
    ["skill_quarantine.js", "inspect", "verify", "hash-tree"]
  );

  // skill_install_enforcer.js blocks direct installer bypasses outside safe wrapper.
  checkScript(
    "systems/security/skill_install_enforcer.js",
    ["skill_install_enforcer.js", "run", "--strict"]
  );

  // integrity_kernel.js enforces tamper-evident hashes for security/directive policy files.
  checkScript(
    "systems/security/integrity_kernel.js",
    ["integrity_kernel.js", "run", "seal", "--approval-note"]
  );

  // architecture_guard.js audits specialization leakage in systems layer.
  checkScript(
    "systems/security/architecture_guard.js",
    ["architecture_guard.js", "run", "--strict"]
  );

  // habit_hygiene_guard.js prevents arbitrary routine dumps in habits layer.
  checkScript(
    "systems/security/habit_hygiene_guard.js",
    ["habit_hygiene_guard.js", "run", "--strict"]
  );
  checkUsage(
    "systems/security/habit_hygiene_guard.js",
    ["run", "--strict"],
    ['"ok": true']
  );

  // workspace_dump_guard.js prevents source/code dumps in data layers and misplaced collectors.
  checkScript(
    "systems/security/workspace_dump_guard.js",
    ["workspace_dump_guard.js", "run", "--strict"]
  );
  checkUsage(
    "systems/security/workspace_dump_guard.js",
    ["run", "--strict"],
    ['"ok": true']
  );

  // request_ingress.js stamps source/action and signed envelopes for guarded command ingress.
  checkScript(
    "systems/security/request_ingress.js",
    ["request_ingress.js", "run", "print-env", "--source", "--action"]
  );

  // directive_intake.js enforces SMART-lite scope/specificity before writing Tier 1 directives.
  checkScript(
    "systems/security/directive_intake.js",
    ["directive_intake.js", "new", "validate", "--id", "--file"]
  );

  // state_backup.js provides optional external runtime-state backup and snapshot listing.
  checkScript(
    "systems/ops/state_backup.js",
    ["state_backup.js", "run", "list", "--dest", "--profile"]
  );

  // openclaw_backup_retention.js keeps recent OpenClaw config backups and archives older files.
  checkScript(
    "systems/ops/openclaw_backup_retention.js",
    ["openclaw_backup_retention.js", "run", "status", "--root", "--keep"]
  );

  // state_cleanup.js provides non-destructive stale runtime-state cleanup with allowlisted policy rules.
  checkScript(
    "systems/ops/state_cleanup.js",
    ["state_cleanup.js", "run", "profiles", "--apply", "--dry-run"]
  );

  // spawn_broker.js is centralized spawn allocation/budget control for module cell pools.
  checkScript(
    "systems/spawn/spawn_broker.js",
    ["spawn_broker.js", "status", "request", "release", "--module", "--requested_cells"]
  );

  // reflex_dispatcher.js manages hardware-capped low-risk reflex cell pool + worker dispatch.
  checkScript(
    "systems/reflex/reflex_dispatcher.js",
    [
      "reflex_dispatcher.js",
      "status",
      "plan",
      "run",
      "routine-list",
      "routine-create",
      "routine-run",
      "routine-enable",
      "routine-disable",
      "routine-dispose",
      "--demand",
      "--id",
      "--task"
    ]
  );

  // reflex_worker.js executes one bounded reflex task through router route_class=reflex.
  checkScript(
    "systems/reflex/reflex_worker.js",
    ["reflex_worker.js", "once", "--task"]
  );

  // strategy_learner.js grades strategies from outcomes (theory/trial/validated/scaled).
  checkScript(
    "systems/strategy/strategy_learner.js",
    ["strategy_learner.js", "run", "status", "--days"]
  );

  // outcome_fitness_loop.js derives adaptive policy updates from realized run/receipt outcomes.
  checkScript(
    "systems/autonomy/outcome_fitness_loop.js",
    ["outcome_fitness_loop.js", "run", "status", "--days", "--apply"]
  );

  console.log("contract_check: OK");
}

main();
