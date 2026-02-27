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
    if (text.includes(t)) continue;
    const compactJsonToken = String(t || '').replace(/":\s+/g, '":');
    if (compactJsonToken !== t && text.includes(compactJsonToken)) continue;
    missing.push(t);
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

function checkUsageTextOnly(relPath, probeArgs, requiredTokens) {
  const root = repoRoot();
  const abs = path.join(root, relPath);
  const r = runCapture([abs, ...probeArgs]);
  const missing = missingTokens(r.text, requiredTokens);
  if (missing.length === 0) return;

  console.error("contract_check: FAILED");
  console.error(` script: ${relPath}`);
  console.error(` probe: ${formatProbe(probeArgs)}`);
  console.error(` exit_code: ${r.code}`);
  console.error(` missing tokens: ${missing.join(", ")}`);
  process.exit(1);
}

function checkScript(relPath, requiredTokens) {
  // Standard contract for all validated CLIs:
  //   1) --help prints usage and exits 0
  //   2) no-arg prints usage and exits 0
  checkUsage(relPath, ["--help"], requiredTokens);
  checkUsage(relPath, [], requiredTokens);
}

function isTsBootstrapWrapper(jsSource) {
  const normalized = String(jsSource || '')
    .replace(/\r\n/g, '\n')
    .replace(/^#!.*\n/, '')
    .trim();
  if (!normalized) return false;
  const withoutUseStrict = normalized
    .replace(/^(['"])use strict\1;\s*/i, '')
    .trim();
  return /^require\((['"])(?:(?:\.{1,2}\/)+lib\/ts_bootstrap|\.\/ts_bootstrap)\1\)\.bootstrap\(__filename,\s*module\);\s*$/m.test(withoutUseStrict);
}

function resolveContractSource(absPath) {
  const jsSource = fs.readFileSync(absPath, "utf8");
  if (!isTsBootstrapWrapper(jsSource)) return jsSource;
  if (path.extname(absPath) !== ".js") return jsSource;
  const tsPath = `${absPath.slice(0, -3)}.ts`;
  if (!fs.existsSync(tsPath)) return jsSource;
  try {
    return fs.readFileSync(tsPath, "utf8");
  } catch {
    return jsSource;
  }
}

function checkSourceContains(relPath, requiredTokens) {
  const root = repoRoot();
  const abs = path.join(root, relPath);
  let text = "";
  try {
    text = resolveContractSource(abs);
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

function effectiveRuntimeMode(root) {
  const envMode = String(process.env.PROTHEUS_RUNTIME_MODE || '').trim().toLowerCase();
  if (envMode === 'dist' || envMode === 'source') return envMode;
  const statePath = process.env.PROTHEUS_RUNTIME_MODE_STATE_PATH
    ? path.resolve(process.env.PROTHEUS_RUNTIME_MODE_STATE_PATH)
    : path.join(root, 'state', 'ops', 'runtime_mode.json');
  try {
    if (!fs.existsSync(statePath)) return 'source';
    const payload = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    const mode = String(payload && payload.mode || '').trim().toLowerCase();
    if (mode === 'dist' || mode === 'source') return mode;
  } catch {}
  return 'source';
}

function walkJsFiles(dirAbs, out) {
  if (!fs.existsSync(dirAbs)) return;
  const ents = fs.readdirSync(dirAbs, { withFileTypes: true });
  for (const ent of ents) {
    if (!ent) continue;
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist') continue;
    const abs = path.join(dirAbs, ent.name);
    if (ent.isDirectory()) {
      walkJsFiles(abs, out);
      continue;
    }
    if (ent.isFile() && abs.endsWith('.js')) out.push(abs);
  }
}

function checkDistRuntimeGuardrails(root) {
  const mode = effectiveRuntimeMode(root);
  if (mode !== 'dist') return;
  if (String(process.env.PROTHEUS_RUNTIME_DIST_REQUIRED || '0') !== '1') {
    console.error('contract_check: FAILED');
    console.error(' runtime_mode: dist');
    console.error(' reason: dist_mode_requires_PROTHEUS_RUNTIME_DIST_REQUIRED=1 to prevent source fallback');
    process.exit(1);
  }
  if (String(process.env.CONTRACT_CHECK_DIST_WRAPPER_STRICT || '0') !== '1') return;
  const files = [];
  walkJsFiles(path.join(root, 'systems'), files);
  walkJsFiles(path.join(root, 'lib'), files);
  const missing = [];
  for (const abs of files) {
    let src = '';
    try { src = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (!isTsBootstrapWrapper(src)) continue;
    const rel = path.relative(root, abs);
    const distPath = path.join(root, 'dist', rel);
    if (!fs.existsSync(distPath)) missing.push(rel);
  }
  if (missing.length === 0) return;
  console.error('contract_check: FAILED');
  console.error(' runtime_mode: dist');
  console.error(` reason: missing_dist_wrappers count=${missing.length}`);
  console.error(` sample: ${missing.slice(0, 10).join(', ')}`);
  process.exit(1);
}

function main() {
  const root = repoRoot();
  checkDistRuntimeGuardrails(root);
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
  checkUsageTextOnly(
    "systems/sensory/adaptive_layer_guard.js",
    ["run", "--strict"],
    ['"ok":']
  );

  // memory_layer_guard.js enforces channelized writes for memory/state-memory files.
  checkScript(
    "systems/memory/memory_layer_guard.js",
    ["memory_layer_guard.js", "run", "--strict"]
  );
  checkUsageTextOnly(
    "systems/memory/memory_layer_guard.js",
    ["run", "--strict"],
    ['"ok":']
  );

  // workspace_dump_guard.js blocks source dumps into memory/adaptive data roots.
  checkScript(
    "systems/security/workspace_dump_guard.js",
    ["workspace_dump_guard.js", "run", "--strict"]
  );
  checkUsageTextOnly(
    "systems/security/workspace_dump_guard.js",
    ["run", "--strict"],
    ['"ok":']
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

  // pain_adaptive_router.js routes recurring pain into disabled reflex/habit candidates.
  checkScript(
    "systems/autonomy/pain_adaptive_router.js",
    ["pain_adaptive_router.js", "run", "status"]
  );

  // adaptive_crystallizer.js proposes generic system-primitive candidates from stable adaptive routines.
  checkScript(
    "systems/autonomy/adaptive_crystallizer.js",
    ["adaptive_crystallizer.js", "run", "status"]
  );

  // runtime sync controllers keep adaptive stores wired to concrete executors.
  checkScript(
    "systems/adaptive/reflex/reflex_runtime_sync.js",
    ["reflex_runtime_sync.js", "run", "status"]
  );
  checkScript(
    "systems/adaptive/habits/habit_runtime_sync.js",
    ["habit_runtime_sync.js", "run", "status"]
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

  // health_status.js reports daily/weekly autonomy SLOs and alert receipts.
  // It intentionally runs status on no-arg, so validate help contract only.
  checkUsage(
    "systems/autonomy/health_status.js",
    ["--help"],
    ["health_status.js", "--window", "--days", "--alerts"]
  );

  // pipeline_spc_gate.js enforces process-control limits for escalation safety.
  checkScript(
    "systems/autonomy/pipeline_spc_gate.js",
    ["pipeline_spc_gate.js", "run", "--days", "--baseline-days", "--sigma"]
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
    ["improvement_controller.js", "start", "start-validated", "evaluate", "status"]
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

  // Primitive baseline scripts must remain callable for canonical replay checks and foundational gates.
  checkScript(
    "systems/primitives/replay_verify.js",
    ["replay_verify.js", "run", "status"]
  );
  checkScript(
    "systems/primitives/emergent_primitive_synthesis.js",
    ["emergent_primitive_synthesis.js", "propose", "evaluate", "approve", "reject", "promote", "status"]
  );
  checkScript(
    "systems/hardware/embodiment_layer.js",
    ["embodiment_layer.js", "sense", "verify-parity", "status"]
  );
  checkScript(
    "systems/hardware/surface_budget_controller.js",
    ["surface_budget_controller.js", "run", "status", "--apply", "--strict"]
  );
  checkScript(
    "systems/hardware/compression_transfer_plane.js",
    ["compression_transfer_plane.js", "compress", "expand", "auto", "status", "--bundle-id", "--target-profile", "--apply", "--strict"]
  );
  checkSourceContains(
    "systems/hardware/compression_transfer_plane.js",
    ["digest_ok", "bundle_id", "compression_transfer_bundle"]
  );
  checkScript(
    "systems/hardware/opportunistic_offload_plane.js",
    ["opportunistic_offload_plane.js", "dispatch", "status", "--job-id", "--complexity", "--required-ram-gb", "--required-cpu-threads", "--strict"]
  );
  checkSourceContains(
    "systems/hardware/opportunistic_offload_plane.js",
    ["effective_route", "fallback_reason", "schedule_command"]
  );
  checkSourceContains(
    "systems/primitives/runtime_scheduler.js",
    ["surface_budget_mode_block", "surface_budget", "allow_modes"]
  );
  checkScript(
    "systems/ops/foundation_contract_gate.js",
    ["foundation_contract_gate.js", "run", "status"]
  );
  checkScript(
    "systems/ops/scale_envelope_baseline.js",
    ["scale_envelope_baseline.js", "run", "status"]
  );
  checkScript(
    "systems/ops/simplicity_budget_gate.js",
    ["simplicity_budget_gate.js", "run", "status", "capture-baseline"]
  );
  checkUsageTextOnly(
    "systems/ops/simplicity_budget_gate.js",
    ["run"],
    ['simplicity_budget_gate']
  );
  checkSourceContains(
    "systems/workflow/workflow_executor.js",
    ["primitive_runtime.js", "executeCommandPrimitiveSync"]
  );
  checkSourceContains(
    "systems/actuation/actuation_executor.js",
    ["primitive_runtime.js", "executeActuationPrimitiveAsync"]
  );

  // system_budget.js centralizes strategy-allocated caps + system enforcement + usage recording.
  checkScript(
    "systems/budget/system_budget.js",
    ["system_budget.js", "status", "project", "record", "decision", "--request_tokens_est"]
  );
  checkScript(
    "systems/budget/capital_allocation_organ.js",
    ["capital_allocation_organ.js", "seed", "simulate", "allocate", "settle", "evaluate", "status", "--bucket", "--amount", "--simulation-id", "--allocation-id", "--actual-return", "--strict"]
  );
  checkSourceContains(
    "systems/budget/capital_allocation_organ.js",
    ["min_simulation_score", "drawdown_stop_pct", "risk_adjusted_return", "simulation_id"]
  );
  checkScript(
    "systems/weaver/drift_aware_revenue_optimizer.js",
    ["drift_aware_revenue_optimizer.js", "optimize", "status", "--strict", "--days"]
  );
  checkSourceContains(
    "systems/weaver/drift_aware_revenue_optimizer.js",
    ["drift_cap_30d", "execution_slo_pass", "balanced_growth", "conservative"]
  );

  // eyes_memory_bridge.js wires enriched sensory proposals into memory nodes + pointer logs.
  checkScript(
    "systems/memory/eyes_memory_bridge.js",
    ["eyes_memory_bridge.js", "run", "status"]
  );

  // failure_memory_bridge.js persists runtime failures into memory nodes + pointer logs.
  checkScript(
    "systems/memory/failure_memory_bridge.js",
    ["failure_memory_bridge.js", "run", "status"]
  );
  checkScript(
    "systems/memory/causal_temporal_graph.js",
    ["causal_temporal_graph.js", "build", "query", "status"]
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
  checkUsageTextOnly(
    "systems/security/habit_hygiene_guard.js",
    ["run", "--strict"],
    ['"ok":']
  );

  // workspace_dump_guard.js prevents source/code dumps in data layers and misplaced collectors.
  checkScript(
    "systems/security/workspace_dump_guard.js",
    ["workspace_dump_guard.js", "run", "--strict"]
  );
  checkUsageTextOnly(
    "systems/security/workspace_dump_guard.js",
    ["run", "--strict"],
    ['"ok":']
  );

  // llm_gateway_guard.js prevents direct runtime LLM-provider calls outside routing gateway files.
  checkScript(
    "systems/security/llm_gateway_guard.js",
    ["llm_gateway_guard.js", "run", "--strict"]
  );
  checkUsageTextOnly(
    "systems/security/llm_gateway_guard.js",
    ["run", "--strict"],
    ['"ok":']
  );

  // capability_lease.js issues/verifies single-use scoped lease tokens for high-tier mutations.
  checkScript(
    "systems/security/capability_lease.js",
    ["capability_lease.js", "issue", "verify", "consume", "--scope"]
  );

  // secret_broker.js mints scoped secret handles, resolves handles, and checks rotation posture.
  checkScript(
    "systems/security/secret_broker.js",
    ["secret_broker.js", "issue", "resolve", "status", "rotation-check", "--scope", "--policy", "--strict", "--secret-ids"]
  );

  // policy_rootd.js authorizes sensitive scope mutations via out-of-process policy root.
  checkScript(
    "systems/security/policy_rootd.js",
    ["policy_rootd.js", "authorize", "status", "--scope"]
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

  // offsite_backup.js synchronizes encrypted offsite snapshots and runs restore drills.
  checkScript(
    "systems/ops/offsite_backup.js",
    ["offsite_backup.js", "sync", "restore-drill", "status", "list", "--profile", "--policy", "--strict"]
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

  // cleanup_orchestrator.js coordinates cleanup crews and centralizes retention policy execution.
  checkScript(
    "systems/ops/cleanup_orchestrator.js",
    ["cleanup_orchestrator.js", "run", "status", "profiles", "--profile", "--apply", "--dry-run", "--policy"]
  );

  // metrics_exporter.js emits Prometheus and JSON snapshots from runtime health artifacts.
  checkScript(
    "systems/observability/metrics_exporter.js",
    ["metrics_exporter.js", "run", "prom", "status", "--window", "--policy", "--write"]
  );

  // trace_bridge.js emits structured trace spans and summaries for local observability lanes.
  checkScript(
    "systems/observability/trace_bridge.js",
    ["trace_bridge.js", "span", "summary", "status", "--name", "--status", "--duration-ms", "--attrs-json", "--policy", "--write"]
  );

  // slo_alert_router.js routes SLO breach alerts to local sinks (file/stdout/webhook).
  checkScript(
    "systems/observability/slo_alert_router.js",
    ["slo_alert_router.js", "route", "status", "--source", "--window", "--min-level", "--max", "--policy", "--write"]
  );

  // blank_slate_reset.js performs reversible archive-based adaptive+memory resets with rollback.
  checkScript(
    "systems/ops/blank_slate_reset.js",
    ["blank_slate_reset.js", "run", "rollback", "list", "--confirm=RESET"]
  );

  // backup_integrity_check.js validates state + blank-slate + offsite snapshot integrity.
  checkScript(
    "systems/ops/backup_integrity_check.js",
    ["backup_integrity_check.js", "run", "list", "--strict", "--channel"]
  );

  // startup_attestation.js signs/verifies critical boot hashes before autonomy execution.
  checkScript(
    "systems/security/startup_attestation.js",
    ["startup_attestation.js", "issue", "verify", "status", "--ttl-hours"]
  );

  // repo_hygiene_guard.js blocks generated/runtime artifacts from merge diffs.
  checkScript(
    "systems/security/repo_hygiene_guard.js",
    ["repo_hygiene_guard.js", "run", "--strict", "--base-ref"]
  );

  // quorum_validator.js performs deterministic second-pass agreement checks for high-tier proposals.
  checkScript(
    "systems/autonomy/quorum_validator.js",
    ["quorum_validator.js", "check", "--proposal-file"]
  );

  // weekly_strategy_synthesis.js summarizes executed outcomes into strategy weight signals.
  checkScript(
    "systems/strategy/weekly_strategy_synthesis.js",
    ["weekly_strategy_synthesis.js", "run", "--days", "--write"]
  );

  // ops_dashboard.js consolidates daily/weekly SLO failures for operator visibility.
  checkScript(
    "systems/autonomy/ops_dashboard.js",
    ["ops_dashboard.js", "run", "--days"]
  );

  // reflex_habit_bridge.js promotes/degrades reflex micro-routines from active habit telemetry.
  checkScript(
    "habits/scripts/reflex_habit_bridge.js",
    ["reflex_habit_bridge.js", "sync", "gc", "status", "--apply"]
  );

  // habit_cell_pool.js executes bounded habits in a spawn-broker-managed cell pool.
  checkScript(
    "systems/habits/habit_cell_pool.js",
    ["habit_cell_pool.js", "status", "run", "--ids", "--max-workers"]
  );

  // active_state_bridge.js manages continuity lease + checkpoint/replay transfers.
  checkScript(
    "systems/continuity/active_state_bridge.js",
    ["active_state_bridge.js", "acquire", "renew", "release", "checkpoint", "replay"]
  );

  // session_continuity_vault.js archives encrypted continuity checkpoints + verified restores.
  checkScript(
    "systems/continuity/session_continuity_vault.js",
    ["session_continuity_vault.js", "archive", "restore", "verify", "status", "--writer", "--checkpoint", "--vault-id", "--dry-run"]
  );
  checkScript(
    "systems/continuity/resurrection_protocol.js",
    ["resurrection_protocol.js", "bundle", "verify", "restore", "status", "--bundle-id", "--attestation-token", "--target-host", "--shards", "--apply"]
  );
  checkScript(
    "systems/echo/value_anchor_renewal.js",
    ["value_anchor_renewal.js", "run", "status", "--apply", "--approved-by", "--approval-note"]
  );
  checkScript(
    "systems/primitives/explanation_primitive.js",
    ["explanation_primitive.js", "explain", "verify", "status", "--event-id", "--category", "--summary", "--narrative", "--decision", "--objective-id", "--proof-link", "--explanation-id"]
  );
  checkSourceContains(
    "systems/primitives/explanation_primitive.js",
    ["proof_links", "verifyCanonicalEvents", "appendAction"]
  );

  // agent_passport.js provides cryptographic action passport chain + export for audit.
  checkScript(
    "systems/security/agent_passport.js",
    ["agent_passport.js", "issue", "append", "verify", "export-pdf", "status", "--actor", "--role", "--tenant", "--model", "--framework", "--org"]
  );

  // alias_verification_vault.js manages secure alias issuance + verification code routing.
  checkScript(
    "systems/security/alias_verification_vault.js",
    ["alias_verification_vault.js", "issue", "route-code", "consume-code", "revoke", "cleanup", "status", "--channel", "--alias-id", "--code", "--passport-id"]
  );
  checkUsage(
    "systems/workflow/gated_account_creation_organ.js",
    ["--help"],
    ["gated_account_creation_organ.js", "create", "status", "--template", "--objective-id", "--apply", "--human-approved", "--mock-execution"]
  );
  checkUsageTextOnly(
    "systems/workflow/gated_account_creation_organ.js",
    [],
    ['"type": "gated_account_creation_status"', '"ok": true']
  );
  checkSourceContains(
    "systems/workflow/gated_account_creation_organ.js",
    ["runConstitutionGate", "runSoulGate", "runWeaverGate", "universal_execution_primitive.js", "high_risk_classes"]
  );
  checkScript(
    "systems/security/delegated_authority_branching.js",
    ["delegated_authority_branching.js", "issue", "evaluate", "revoke", "handoff-contract", "status", "--delegate-id", "--roles", "--scopes", "--branch-id", "--scope", "--revoked-by"]
  );
  checkSourceContains(
    "systems/security/delegated_authority_branching.js",
    ["constitution_denied_scopes", "required_key_class", "handoff_contract"]
  );

  // capability_profile_compiler.js compiles canonical profile-only capability artifacts.
  checkScript(
    "systems/assimilation/capability_profile_compiler.js",
    ["capability_profile_compiler.js", "compile", "from-research", "validate", "status", "--in", "--capability-id", "--source-type", "--research-json"]
  );
  checkScript(
    "systems/assimilation/world_model_freshness.js",
    ["world_model_freshness.js", "run", "status", "--apply", "--strict", "--max-profiles"]
  );
  checkSourceContains(
    "systems/assimilation/world_model_freshness.js",
    ["freshness_slo_target", "compiler_queue_path", "required_surface_checks"]
  );

  // js_holdout_audit.js enforces JS->TS exception registry in strict runtime lanes.
  checkScript(
    "systems/ops/js_holdout_audit.js",
    ["js_holdout_audit.js", "run", "status", "--registry", "--strict"]
  );
  checkScript(
    "systems/observability/siem_bridge.js",
    ["siem_bridge.js", "export", "correlate", "status", "--format", "--strict"]
  );
  checkSourceContains(
    "systems/observability/siem_bridge.js",
    ["auth_anomaly", "integrity_drift", "guard_denies", "alert_roundtrip"]
  );
  checkScript(
    "systems/ops/continuous_chaos_resilience.js",
    ["continuous_chaos_resilience.js", "tick", "gate", "status", "--apply", "--strict", "--max-scenarios"]
  );
  checkSourceContains(
    "systems/ops/continuous_chaos_resilience.js",
    ["promotion_blocked", "scenario_cadence_minutes", "runbook_action"]
  );
  checkScript(
    "systems/ops/self_hosted_bootstrap_compiler.js",
    ["self_hosted_bootstrap_compiler.js", "compile", "verify", "promote", "rollback", "status", "--build-id", "--approved-by", "--approval-note", "--source-root", "--apply"]
  );
  checkSourceContains(
    "systems/ops/self_hosted_bootstrap_compiler.js",
    ["verify_commands", "active_build_id", "previous_active_build_id"]
  );
  checkScript(
    "systems/ops/phone_seed_profile.js",
    ["phone_seed_profile.js", "run", "status", "--strict"]
  );
  checkSourceContains(
    "systems/ops/phone_seed_profile.js",
    ["heavy_lanes_disabled_by_policy", "seed_boot_probe.js", "memory_federation_plane.js"]
  );

  // offdevice_memory_replication.js performs proof-verified off-device memory replication drills.
  checkScript(
    "systems/memory/offdevice_memory_replication.js",
    ["offdevice_memory_replication.js", "sync", "verify", "restore-drill", "status", "--provider", "--snapshot", "--scope", "--apply"]
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

  // strategy_controller.js manages adaptive strategy queue/intake/materialization via channelized store mutations.
  checkScript(
    "systems/strategy/strategy_controller.js",
    [
      "strategy_controller.js",
      "status",
      "get",
      "intake",
      "collect",
      "queue",
      "materialize",
      "set-profile",
      "mutate-profile",
      "touch-use",
      "sync-usage",
      "gc",
      "restore",
      "--approval-note"
    ]
  );

  // outcome_fitness_loop.js derives adaptive policy updates from realized run/receipt outcomes.
  checkScript(
    "systems/autonomy/outcome_fitness_loop.js",
    ["outcome_fitness_loop.js", "run", "status", "--days", "--apply"]
  );

  // capability_switchboard.js provides dual-control feature kill switches with immutable audit paths.
  checkScript(
    "systems/security/capability_switchboard.js",
    ["capability_switchboard.js", "status", "evaluate", "set", "--switch", "--state", "--approver-id"]
  );

  // anti_sabotage_shield.js snapshots and verifies protected files with auto-reset option.
  checkScript(
    "systems/security/anti_sabotage_shield.js",
    ["anti_sabotage_shield.js", "snapshot", "verify", "status", "--auto-reset", "--strict"]
  );

  // chaos_program.js runs controlled failure injection scenarios.
  checkScript(
    "systems/ops/chaos_program.js",
    ["chaos_program.js", "run", "status", "--scenario", "--strict"]
  );

  // scale_benchmark.js emits throughput/latency/error-budget baseline reports.
  checkScript(
    "systems/ops/scale_benchmark.js",
    ["scale_benchmark.js", "run", "status", "--tier", "--strict"]
  );

  // compliance_reports.js generates evidence/inventory/framework readiness reports.
  checkScript(
    "systems/ops/compliance_reports.js",
    ["compliance_reports.js", "evidence-index", "control-inventory", "framework-readiness", "soc2-readiness", "status", "--days", "--strict", "--framework"]
  );
  checkScript(
    "systems/ops/soc2_type2_track.js",
    ["soc2_type2_track.js", "run", "exception-open", "exception-close", "bundle", "status", "--days", "--id", "--control", "--reason", "--resolution", "--window-id", "--strict"]
  );
  checkSourceContains(
    "systems/ops/soc2_type2_track.js",
    ["minimum_window_days", "max_open_exception_days", "soc2_type2_attestation_bundle"]
  );
  checkScript(
    "systems/ops/predictive_capacity_forecast.js",
    ["predictive_capacity_forecast.js", "run", "status", "--strict"]
  );
  checkSourceContains(
    "systems/ops/predictive_capacity_forecast.js",
    ["forecast_horizons_days", "recommendation", "forecast_errors"]
  );
  checkScript(
    "systems/symbiosis/neural_dormant_seed.js",
    ["neural_dormant_seed.js", "status", "check", "request-sim", "request-live", "--profile", "--strict", "--purpose", "--approval-note"]
  );
  checkSourceContains(
    "systems/symbiosis/neural_dormant_seed.js",
    ["allow_non_simulated_prototypes", "blocked_runtime_profiles", "no_runtime_activation_path"]
  );
  checkScript(
    "systems/security/execution_sandbox_envelope.js",
    ["execution_sandbox_envelope.js", "status", "evaluate-workflow", "evaluate-actuation", "--step-id", "--step-type", "--command", "--kind"]
  );
  checkSourceContains(
    "systems/security/execution_sandbox_envelope.js",
    ["blocked_command_tokens", "high_risk_actuation_classes", "sandbox_escape_attempt_denied"]
  );
  checkScript(
    "systems/security/organ_state_encryption_plane.js",
    ["organ_state_encryption_plane.js", "encrypt", "decrypt", "rotate-key", "verify", "status", "--organ", "--lane", "--source", "--cipher", "--out"]
  );
  checkSourceContains(
    "systems/security/organ_state_encryption_plane.js",
    ["key_version", "mac_b64", "unauthorized_decrypt_attempt", "unauthorized_fail_closed"]
  );
  checkScript(
    "systems/security/remote_tamper_heartbeat.js",
    ["remote_tamper_heartbeat.js", "emit", "verify", "status", "clear-quarantine", "--build-id", "--watermark", "--strict", "--reason"]
  );
  checkSourceContains(
    "systems/security/remote_tamper_heartbeat.js",
    ["constitution_hash", "integrity_ok", "trusted_watermark_mismatch", "quarantine_activated"]
  );
  checkScript(
    "systems/security/critical_path_formal_verifier.js",
    ["critical_path_formal_verifier.js", "run", "status", "--strict"]
  );
  checkSourceContains(
    "systems/security/critical_path_formal_verifier.js",
    ["required_weaver_weights", "required_axiom_ids", "model_check_live_gate_ordering"]
  );
  checkScript(
    "systems/helix/helix_admission_gate.js",
    ["helix_admission_gate.js", "candidate", "admit", "status", "--capability-id", "--candidate-json", "--doctor-approved"]
  );
  checkSourceContains(
    "systems/helix/helix_admission_gate.js",
    ["strand_hash_mismatch", "doctor_approval_required", "manifest_updated", "codex_root_hash_mismatch"]
  );
  checkUsageTextOnly(
    "systems/helix/confirmed_malice_quarantine.js",
    ["--help"],
    ['"type": "helix_permanent_quarantine_status"', '"release_requires_human":']
  );
  checkUsageTextOnly(
    "systems/helix/confirmed_malice_quarantine.js",
    [],
    ['"type": "helix_permanent_quarantine_status"', '"ok": true']
  );
  checkSourceContains(
    "systems/helix/confirmed_malice_quarantine.js",
    ["insufficient_independent_signals", "confidence_below_threshold", "permanent_quarantine", "human_approval_required"]
  );
  checkScript(
    "systems/redteam/ant_colony_controller.js",
    ["ant_colony_controller.js", "run", "status", "--red-confidence", "--critical-fail-cases", "--executed-cases"]
  );
  checkSourceContains(
    "systems/redteam/ant_colony_controller.js",
    ["require_helix_tamper", "require_sentinel_agreement", "recentAssimilationTargets", "distillWisdom"]
  );
  checkUsage(
    "systems/autonomy/gated_self_improvement_loop.js",
    ["--help"],
    ["gated_self_improvement_loop.js", "propose", "run", "rollback", "status", "--proposal-id", "--objective-id", "--target-path", "--apply"]
  );
  checkUsageTextOnly(
    "systems/autonomy/gated_self_improvement_loop.js",
    [],
    ['"type": "gated_self_improvement_status"', '"ok": true']
  );
  checkSourceContains(
    "systems/autonomy/gated_self_improvement_loop.js",
    ["rollout_stages", "auto_rollback_on_regression", "extractSimulationMetrics", "evaluateGates"]
  );

  // environment_promotion_gate.js enforces promotion sequencing and approvals across env tiers.
  checkScript(
    "systems/ops/environment_promotion_gate.js",
    ["environment_promotion_gate.js", "promote", "status", "--from", "--to", "--owner", "--artifact", "--checks"]
  );

  // optimization_aperture_controller.js computes risk-adaptive optimization posture per lane.
  checkScript(
    "systems/autonomy/optimization_aperture_controller.js",
    ["optimization_aperture_controller.js", "run", "status", "--lane", "--risk", "--impact", "--budget-pressure"]
  );

  // objective_optimization_floor.js enforces criticality-aware good-enough floor decisions.
  checkScript(
    "systems/autonomy/objective_optimization_floor.js",
    ["objective_optimization_floor.js", "run", "status", "--objective", "--criticality", "--delta"]
  );

  // specialist_training.js handles curation/plan/evaluate/promote for local specialist checkpoints.
  checkScript(
    "systems/nursery/specialist_training.js",
    ["specialist_training.js", "curate", "plan", "evaluate", "promote", "--profile", "--checkpoint"]
  );

  // collective_shadow.js distills non-yield/red-team outcomes into bounded ranking archetypes.
  checkScript(
    "systems/autonomy/collective_shadow.js",
    ["collective_shadow.js", "run", "status", "--days", "--policy"]
  );

  // observer_mirror.js emits read-only health narration and machine summary snapshots.
  checkScript(
    "systems/autonomy/observer_mirror.js",
    ["observer_mirror.js", "run", "status", "--days"]
  );

  // continuum_core.js runs bounded background pulse/daemon/status contracts.
  checkScript(
    "systems/continuum/continuum_core.js",
    ["continuum_core.js", "pulse", "daemon", "status", "--profile", "--policy", "--dry-run"]
  );

  // strategy_principles.js derives implementation principles from active strategy policy.
  checkScript(
    "systems/strategy/strategy_principles.js",
    ["strategy_principles.js", "run", "status"]
  );

  // inversion_controller.js enforces maturity/impact/certainty-gated inversion sessions and outcomes.
  checkScript(
    "systems/autonomy/inversion_controller.js",
    [
      "inversion_controller.js",
      "run",
      "resolve",
      "record-test",
      "sweep",
      "status",
      "--objective",
      "--impact",
      "--target",
      "--certainty",
      "--mode",
      "--apply"
    ]
  );

  // workflow_generator.js emits proposal-only adaptive workflow drafts.
  checkScript(
    "systems/workflow/workflow_generator.js",
    ["workflow_generator.js", "run", "status", "--days", "--max", "--policy"]
  );

  // workflow_controller.js applies/surfaces workflow registry materialization.
  checkScript(
    "systems/workflow/workflow_controller.js",
    ["workflow_controller.js", "run", "promote", "list", "status", "--apply", "--days", "--max", "--policy", "--orchestron", "--orchestron-apply", "--orchestron-auto", "--intent", "--value-currency", "--objective-id", "--approval-note", "--approver-id"]
  );

  // orchestron_controller.js is the branded alias entrypoint for workflow_controller.
  checkScript(
    "systems/workflow/orchestron_controller.js",
    ["workflow_controller.js", "run", "promote", "list", "status", "--apply", "--days", "--max", "--policy", "--orchestron", "--orchestron-apply", "--orchestron-auto", "--intent", "--value-currency", "--objective-id", "--approval-note", "--approver-id"]
  );
  checkScript(
    "systems/workflow/client_relationship_manager.js",
    ["client_relationship_manager.js", "case-open", "event", "evaluate", "status", "--client-id", "--case-id", "--type", "--handled-by", "--workflow-id", "--days", "--strict"]
  );
  checkSourceContains(
    "systems/workflow/client_relationship_manager.js",
    ["manual_intervention_target", "require_workflow_ref_for_auto", "sla_hours_by_type"]
  );

  // identity_anchor.js enforces objective/value coherence for workflow graft + morph proposals.
  checkScript(
    "systems/identity/identity_anchor.js",
    ["identity_anchor.js", "run", "status", "--scope", "--strict", "--workflow-snapshot", "--workflow-registry", "--morph-plan"]
  );

  // orchestron adaptive_controller.js runs intent->candidate->nursery scorecard cycles.
  checkScript(
    "systems/workflow/orchestron/adaptive_controller.js",
    ["adaptive_controller.js", "run", "status", "--intent", "--max-candidates", "--value-currency", "--objective-id", "--policy"]
  );

  // intent_analyzer.js must expose bounded intent contracts (objective/constraints/uncertainty/trit signals).
  checkScript(
    "systems/workflow/orchestron/intent_analyzer.js",
    ["intent_analyzer.js", "run", "--intent"]
  );
  checkSourceContains(
    "systems/workflow/orchestron/nursery_tester.js",
    ["orchestron_nursery_scorecard", "contract_version: '1.0'", "summary:", "blocked,"]
  );

  // workflow_executor.js runs active workflow steps with retries/gate checks/receipt checks.
  checkScript(
    "systems/workflow/workflow_executor.js",
    ["workflow_executor.js", "run", "status", "--id", "--max", "--include-draft", "--dry-run", "--continue-on-error", "--receipt-strict"]
  );

  // eye_kernel.js enforces control-plane lane routing with budget/clearance receipts.
  checkScript(
    "systems/eye/eye_kernel.js",
    ["eye_kernel.js", "route", "status", "--lane", "--target", "--action", "--risk", "--clearance", "--estimated-tokens", "--apply"]
  );

  // subsumption_registry.js manages provider/vassal contracts with trust/budget/disable gates.
  checkScript(
    "systems/eye/subsumption_registry.js",
    ["subsumption_registry.js", "register", "evaluate", "disable", "enable", "status", "--provider", "--trust", "--daily-tokens", "--estimated-tokens", "--approval-note", "--apply"]
  );

  // claw_registry.js governs high-power actuation lanes (browser/computer/payment).
  checkScript(
    "systems/actuation/claw_registry.js",
    ["claw_registry.js", "status", "evaluate", "--kind", "--dry-run", "--context", "--policy"]
  );

  // personal_protheus_installer.js provides one-command local bootstrap.
  checkScript(
    "systems/ops/personal_protheus_installer.js",
    ["personal_protheus_installer.js", "install", "status", "--profile", "--workspace", "--dry-run"]
  );

  // public_benchmark_pack.js emits reproducible public benchmark artifacts.
  checkScript(
    "systems/ops/public_benchmark_pack.js",
    ["public_benchmark_pack.js", "run", "status", "--days"]
  );

  // deployment_packaging.js validates container/k8s packaging hardening posture.
  checkScript(
    "systems/ops/deployment_packaging.js",
    ["deployment_packaging.js", "run", "status", "--profile", "--strict"]
  );

  // compliance_posture.js aggregates SOC2/integrity/packaging/contract posture.
  checkScript(
    "systems/ops/compliance_posture.js",
    ["compliance_posture.js", "run", "status", "--days", "--profile", "--strict"]
  );

  // skill_generation_pipeline.js guards pattern->candidate skill generation with policy checks.
  checkScript(
    "systems/autonomy/skill_generation_pipeline.js",
    ["skill_generation_pipeline.js", "run", "status", "--days", "--max-candidates", "--apply"]
  );

  // evolution_arena.js runs bounded spawn-broker variant trials for promotion decisions.
  checkScript(
    "systems/fractal/evolution_arena.js",
    ["evolution_arena.js", "run", "status", "--objective", "--variants", "--scores", "--strict"]
  );

  // mutation_safety_kernel.js expands adaptive mutation containment with risk bands + lineage checks.
  checkScript(
    "systems/autonomy/mutation_safety_kernel.js",
    ["mutation_safety_kernel.js", "evaluate", "status", "--proposal-file"]
  );

  // polyglot_service_adapter.js is the strict-contract pilot adapter for non-TS service workers.
  checkScript(
    "systems/polyglot/polyglot_service_adapter.js",
    ["polyglot_service_adapter.js", "run", "benchmark", "status", "--task-type", "--signals"]
  );

  // dist_runtime_cutover.js controls source/dist runtime mode and verification checks.
  checkScript(
    "systems/ops/dist_runtime_cutover.js",
    ["dist_runtime_cutover.js", "status", "set-mode", "verify", "--mode", "--build", "--strict"]
  );

  // external_security_cycle.js ingests third-party findings and tracks closure evidence.
  checkScript(
    "systems/security/external_security_cycle.js",
    ["external_security_cycle.js", "ingest", "status", "--report-file", "--assessor"]
  );

  console.log("contract_check: OK");
}

main();
export {};
