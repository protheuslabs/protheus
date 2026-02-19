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
const { isEmergencyStopEngaged } = require("../../lib/emergency_stop.js");

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

function runJson(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  const out = String(r.stdout || "").trim();
  const err = String(r.stderr || "").trim();
  let payload = null;
  if (out) {
    try {
      payload = JSON.parse(out);
    } catch {
      const line = out.split("\n").find(x => x.trim().startsWith("{")) || out;
      try { payload = JSON.parse(line); } catch {}
    }
  }
  return {
    ok: r.status === 0,
    code: r.status == null ? 1 : r.status,
    payload,
    stdout: out,
    stderr: err
  };
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

function readJsonl(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const lines = fs.readFileSync(filePath, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function modelCatalogPendingCount() {
  const root = repoRoot();
  const auditPath = path.join(root, "state", "routing", "model_catalog_audit.jsonl");
  const handoffsDir = path.join(root, "state", "routing", "model_catalog_handoffs");
  const audits = readJsonl(auditPath);
  const closed = new Set(
    audits
      .filter(e => e && (e.type === "handoff_approved" || e.type === "handoff_rejected"))
      .map(e => String(e.id || ""))
      .filter(Boolean)
  );
  if (!fs.existsSync(handoffsDir)) return 0;
  const files = fs.readdirSync(handoffsDir).filter(f => f.endsWith(".json"));
  let pending = 0;
  for (const f of files) {
    const id = f.replace(/\.json$/, "");
    if (closed.has(id)) continue;
    const obj = JSON.parse(fs.readFileSync(path.join(handoffsDir, f), "utf8"));
    const status = String((obj && obj.status) || "");
    if (status === "apply_pending") pending++;
  }
  return pending;
}

function routingCacheSummary() {
  const rep = runJson("node", [
    "systems/routing/model_router.js",
    "cache-summary",
    "--for-routing=1",
    "--risk=low",
    "--complexity=low",
    "--intent=spine_preflight",
    "--task=local routing health preflight"
  ]);
  if (!rep.ok || !rep.payload || !Array.isArray(rep.payload.results)) {
    return {
      ok: false,
      reason: rep.stderr || rep.stdout || `cache_summary_exit_${rep.code}`
    };
  }
  return { ok: true, payload: rep.payload };
}

function routingLocalPreflight(cacheSummary) {
  if (!cacheSummary || cacheSummary.ok !== true || !cacheSummary.payload) {
    return {
      ok: false,
      local_total: 0,
      local_eligible: 0,
      reason: cacheSummary && cacheSummary.reason ? cacheSummary.reason : "cache_summary_unavailable"
    };
  }
  const payload = cacheSummary.payload;
  return {
    ok: true,
    local_total: Number(payload.local_total || payload.total || 0),
    local_eligible: Number(payload.local_eligible || 0),
    local_degraded: Number(payload.local_degraded || 0),
    escalate_tier1_local: !!(payload.tier1_local_decision && payload.tier1_local_decision.escalate === true),
    escalate_reason: payload.tier1_local_decision ? payload.tier1_local_decision.reason || null : null,
    local_best: payload.tier1_local_decision ? payload.tier1_local_decision.local_best || null : null,
    local_best_source_runtime: (() => {
      const best = payload.tier1_local_decision ? payload.tier1_local_decision.local_best || null : null;
      const rows = Array.isArray(payload.results) ? payload.results : [];
      const row = rows.find(r => r && String(r.model || "") === String(best || ""));
      return row ? row.source_runtime || null : null;
    })(),
    source_runtime_counts: payload.source_runtime_counts || {},
    stale_count: Number(payload.stale_count || 0)
  };
}

function routingTelemetrySummary(cacheSummary) {
  if (!cacheSummary || cacheSummary.ok !== true || !cacheSummary.payload) {
    return {
      ok: false,
      total: 0,
      available: 0,
      unavailable: 0,
      unknown: 0,
      probe_blocked: 0,
      timeout: 0,
      instruction_fail: 0,
      stale_count: 0,
      source_runtime_counts: {},
      reason: cacheSummary && cacheSummary.reason ? cacheSummary.reason : "cache_summary_unavailable"
    };
  }
  const payload = cacheSummary.payload;
  return {
    ok: true,
    source: "cache",
    total: Number(payload.local_total || payload.total || 0),
    available: Number(payload.available || 0),
    unavailable: Number(payload.unavailable || 0),
    unknown: Number(payload.unknown || 0),
    probe_blocked: Number(payload.probe_blocked || 0),
    timeout: Number(payload.timeout || 0),
    instruction_fail: Number(payload.instruction_fail || 0),
    stale_count: Number(payload.stale_count || 0),
    source_runtime_counts: payload.source_runtime_counts || {},
    top_failures: Array.isArray(payload.top_failures) ? payload.top_failures : []
  };
}

function collectorHealthSummary() {
  const rep = runJson("node", ["habits/scripts/external_eyes.js", "doctor"]);
  if (!rep.ok || !rep.payload || !Array.isArray(rep.payload.report)) {
    return {
      ok: false,
      healthy: 0,
      total: 0,
      unhealthy: 0,
      reason: rep.stderr || rep.stdout || `doctor_exit_${rep.code}`
    };
  }
  const rows = rep.payload.report;
  const total = rows.length;
  const healthy = rows.filter(r => r && r.healthy === true).length;
  const unhealthyRows = rows.filter(r => !r || r.healthy !== true);
  const unhealthy = unhealthyRows.length;
  const topIssues = unhealthyRows
    .slice(0, 3)
    .map(r => ({
      eye_id: r.eye_id || null,
      reasons: Array.isArray(r.reasons) ? r.reasons.slice(0, 3) : []
    }));
  return { ok: true, healthy, total, unhealthy, top_issues: topIssues };
}

function collectorPreflightSummary() {
  const rep = runJson("node", ["habits/scripts/external_eyes.js", "preflight"]);
  if (!rep.ok || !rep.payload || !Array.isArray(rep.payload.report)) {
    return {
      ok: false,
      preflight_ok: false,
      checked: 0,
      failed_runnable_eyes: 0,
      reason: rep.stderr || rep.stdout || `preflight_exit_${rep.code}`
    };
  }
  const payload = rep.payload;
  const rows = payload.report;
  const failing = rows.filter(r => r && r.runnable === true && r.ok !== true);
  const topFailures = failing.slice(0, 3).map(r => ({
    eye_id: r.eye_id || null,
    parser_type: r.parser_type || null,
    failures: Array.isArray(r.failures) ? r.failures.slice(0, 3) : []
  }));
  return {
    ok: true,
    preflight_ok: payload.ok === true,
    checked: Number(payload.checked || rows.length),
    failed_runnable_eyes: Number(payload.failed_runnable_eyes || failing.length),
    failure_code_counts: payload.failure_code_counts || {},
    top_failures: topFailures
  };
}

function realExternalItemsToday(dateStr) {
  const fp = path.join(repoRoot(), "state", "sensory", "eyes", "raw", `${dateStr}.jsonl`);
  const events = readJsonl(fp);
  return events
    .filter(e => e && e.type === "external_item")
    .filter(e => !String(e.title || "").toUpperCase().includes("[STUB]"))
    .length;
}

function routingHealthStatePath() {
  return path.join(repoRoot(), "state", "spine", "router_health.json");
}

function readRoutingHealthState() {
  try {
    const fp = routingHealthStatePath();
    if (!fs.existsSync(fp)) return { consecutive_full_local_down: 0 };
    return JSON.parse(fs.readFileSync(fp, "utf8"));
  } catch {
    return { consecutive_full_local_down: 0 };
  }
}

function writeRoutingHealthState(obj) {
  const fp = routingHealthStatePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(obj, null, 2));
}

function main() {
  const mode = process.argv[2];
  const dateStr = todayOr(process.argv[3]);
  const maxEyes = arg("max-eyes");
  let signalGateOk = null;
  let signalSloOk = null;

  // spine is infra: default clearance 3 if not explicitly set
  if (!process.env.CLEARANCE) process.env.CLEARANCE = "3";

  if (!mode || (mode !== "eyes" && mode !== "daily")) {
    console.error("Usage:");
    console.error("  node systems/spine/spine.js eyes [YYYY-MM-DD] [--max-eyes=N]");
    console.error("  node systems/spine/spine.js daily [YYYY-MM-DD] [--max-eyes=N]");
    process.exit(2);
  }

  const emergency = isEmergencyStopEngaged("spine");
  if (emergency.engaged) {
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_emergency_stop",
      mode,
      date: dateStr,
      scope: emergency.scope || "spine",
      stop_state: emergency.state || null
    });
    console.log(" spine_emergency_stop engaged=true");
    return;
  }

  // Declare what we will touch (guarded)
  const invoked = [
    "systems/spine/spine.js",
    "systems/security/guard.js",
    "systems/security/directive_gate.js",
    "systems/security/skill_install_enforcer.js",
    "systems/security/integrity_kernel.js",
    "habits/scripts/external_eyes.js",
    "habits/scripts/eyes_insight.js",
    "habits/scripts/sensory_queue.js",
    // daily-mode extras (only executed in daily, but declared here for guard)
    "habits/scripts/git_outcomes.js",
    "habits/scripts/dopamine_engine.js",
    "habits/scripts/sensory_digest.js",
    "systems/autonomy/autonomy_controller.js",
    "systems/autonomy/proposal_enricher.js",
    "systems/autonomy/strategy_readiness.js",
    "systems/autonomy/strategy_execute_guard.js",
    "systems/autonomy/strategy_mode_governor.js",
    "systems/actuation/actuation_executor.js",
    "systems/actuation/bridge_from_proposals.js",
    "systems/ops/state_backup.js",
    "config/actuation_adapters.json",
    "config/state_backup_policy.json",
    "skills/moltbook/actuation_adapter.js",
    "skills/moltbook/moltbook_publish_guard.js",
    "systems/routing/route_execute.js",
    "systems/routing/route_task.js",
    "systems/routing/model_router.js",
    "habits/scripts/queue_gc.js",
    "habits/scripts/proposal_queue.js",
    "config/security_integrity_policy.json"
  ];

  // Clearance gate
  guard(invoked);

  if (mode === "daily") {
    const skillInstallEnforcer = runJson("node", ["systems/security/skill_install_enforcer.js", "run", "--strict"]);
    const enforcerPayload = skillInstallEnforcer.payload && typeof skillInstallEnforcer.payload === "object"
      ? skillInstallEnforcer.payload
      : null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_skill_install_enforcer",
      mode,
      date: dateStr,
      ok: skillInstallEnforcer.ok && !!enforcerPayload && enforcerPayload.ok === true,
      violation_count: enforcerPayload ? Number(enforcerPayload.violation_count || 0) : null,
      structure_ok: enforcerPayload && enforcerPayload.structure ? enforcerPayload.structure.ok === true : null,
      reason: (!skillInstallEnforcer.ok || !enforcerPayload)
        ? String(skillInstallEnforcer.stderr || skillInstallEnforcer.stdout || `skill_install_enforcer_exit_${skillInstallEnforcer.code}`).slice(0, 180)
        : null
    });
    if (!skillInstallEnforcer.ok || !enforcerPayload || enforcerPayload.ok !== true) {
      console.error(` skill_install_enforcer FAIL violations=${enforcerPayload ? Number(enforcerPayload.violation_count || 0) : "unknown"}`);
      process.exit(skillInstallEnforcer.code || 1);
    }
    console.log(` skill_install_enforcer ok violations=${Number(enforcerPayload.violation_count || 0)}`);

    const integrityPolicy = String(process.env.SPINE_INTEGRITY_POLICY || "config/security_integrity_policy.json").trim();
    const integrityStrict = String(process.env.SPINE_INTEGRITY_STRICT || "1") !== "0";
    const integrityArgs = ["systems/security/integrity_kernel.js", "run"];
    if (integrityPolicy) integrityArgs.push(`--policy=${integrityPolicy}`);
    const integrityKernel = runJson("node", integrityArgs);
    const integrityPayload = integrityKernel.payload && typeof integrityKernel.payload === "object"
      ? integrityKernel.payload
      : null;
    const integrityOk = integrityKernel.ok && !!integrityPayload && integrityPayload.ok === true;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_integrity_kernel",
      mode,
      date: dateStr,
      ok: integrityOk,
      strict: integrityStrict,
      policy_path: integrityPayload ? integrityPayload.policy_path || integrityPolicy : integrityPolicy,
      checked_present_files: integrityPayload ? Number(integrityPayload.checked_present_files || 0) : null,
      expected_files: integrityPayload ? Number(integrityPayload.expected_files || 0) : null,
      violation_counts: integrityPayload ? integrityPayload.violation_counts || {} : {},
      reason: !integrityOk
        ? String(integrityKernel.stderr || integrityKernel.stdout || `integrity_kernel_exit_${integrityKernel.code}`).slice(0, 180)
        : null
    });
    if (!integrityOk) {
      const reason = integrityPayload && integrityPayload.violation_counts
        ? JSON.stringify(integrityPayload.violation_counts)
        : String(integrityKernel.stderr || integrityKernel.stdout || "unknown").slice(0, 120);
      if (integrityStrict) {
        console.error(` integrity_kernel FAIL violations=${reason}`);
        process.exit(integrityKernel.code || 1);
      }
      console.log(` integrity_kernel WARN violations=${reason}`);
    } else {
      console.log(` integrity_kernel ok checked=${Number(integrityPayload.checked_present_files || 0)} expected=${Number(integrityPayload.expected_files || 0)}`);
    }
  }

  const routingCache = routingCacheSummary();

  if (mode === "daily" && String(process.env.SPINE_ROUTER_PROBE_ALL || "1") !== "0") {
    const probeAll = routingTelemetrySummary(routingCache);
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_router_probe_all",
      mode,
      date: dateStr,
      ...probeAll
    });
    if (probeAll.ok) {
      console.log(
        ` routing_probe_all available=${probeAll.available}/${probeAll.total}` +
        ` unknown=${probeAll.unknown}` +
        ` probe_blocked=${probeAll.probe_blocked}` +
        ` timeout=${probeAll.timeout}` +
        ` stale=${probeAll.stale_count}` +
        ` instruction_fail=${probeAll.instruction_fail}`
      );
    } else {
      console.log(` routing_probe_all unavailable reason=${String(probeAll.reason || "unknown").slice(0, 120)}`);
    }
  } else if (mode === "daily") {
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_router_probe_all_skipped",
      mode,
      date: dateStr,
      reason: "feature_flag_disabled",
      flag: "SPINE_ROUTER_PROBE_ALL",
      flag_value: String(process.env.SPINE_ROUTER_PROBE_ALL || "")
    });
    console.log(" routing_probe_all skipped reason=feature_flag_disabled flag=SPINE_ROUTER_PROBE_ALL");
  }

  const routerPreflight = routingLocalPreflight(routingCache);
  const healthState = readRoutingHealthState();
  const wasDown = Number(healthState.consecutive_full_local_down || 0);
  const isFullLocalDown = routerPreflight.ok && Number(routerPreflight.local_total || 0) > 0 && Number(routerPreflight.local_eligible || 0) === 0;
  const nextDown = isFullLocalDown ? (wasDown + 1) : 0;
  const alertAfter = Number(process.env.SPINE_ROUTER_LOCAL_DOWN_ALERT_AFTER || 2);
  writeRoutingHealthState({
    ts: nowIso(),
    consecutive_full_local_down: nextDown,
    last_preflight: routerPreflight
  });
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_router_preflight",
    mode,
    date: dateStr,
    consecutive_full_local_down: nextDown,
    ...routerPreflight
  });
  if (isFullLocalDown && nextDown >= alertAfter) {
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_router_alert",
      mode,
      date: dateStr,
      severity: "warning",
      alert: "local_models_unavailable_consecutive_runs",
      consecutive_full_local_down: nextDown,
      threshold: alertAfter
    });
    console.log(` routing_alert local_models_down consecutive=${nextDown} threshold=${alertAfter}`);
  }
  if (routerPreflight.ok) {
    console.log(` routing_local_preflight eligible=${routerPreflight.local_eligible}/${routerPreflight.local_total} degraded=${routerPreflight.local_degraded}`);
  } else {
    console.log(` routing_local_preflight unavailable reason=${String(routerPreflight.reason || "unknown").slice(0, 120)}`);
  }

  const collectorPreflight = collectorPreflightSummary();
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_collector_preflight",
    mode,
    date: dateStr,
    ...collectorPreflight
  });
  if (collectorPreflight.ok) {
    console.log(` collector_preflight ok=${collectorPreflight.preflight_ok} failed=${collectorPreflight.failed_runnable_eyes} checked=${collectorPreflight.checked}`);
  } else {
    console.log(` collector_preflight unavailable reason=${String(collectorPreflight.reason || "unknown").slice(0, 120)}`);
  }

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
  if (mode === "daily") {
    // Daily canary run: force one non-stub collector regardless cadence to detect recovery quickly.
    run("node", ["habits/scripts/external_eyes.js", "canary"]);
    // Daily signal canary: force the best healthy non-stub eye to maintain signal flow.
    run("node", ["habits/scripts/external_eyes.js", "canary-signal"]);
  }

  run("node", ["habits/scripts/external_eyes.js", "score", dateStr]);
  run("node", ["habits/scripts/external_eyes.js", "evolve", dateStr]);
  const collectorHealth = collectorHealthSummary();
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_collector_health",
    mode,
    date: dateStr,
    ...collectorHealth
  });
  if (collectorHealth.ok) {
    console.log(` collector_health healthy=${collectorHealth.healthy}/${collectorHealth.total} unhealthy=${collectorHealth.unhealthy}`);
  } else {
    console.log(` collector_health unavailable reason=${String(collectorHealth.reason || "unknown").slice(0, 120)}`);
  }

  const realItems = realExternalItemsToday(dateStr);
  signalGateOk = realItems > 0;
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_signal_gate",
    mode,
    date: dateStr,
    ok: signalGateOk,
    real_external_items: realItems,
    threshold: 1
  });
  if (signalGateOk) {
    run("node", ["habits/scripts/eyes_insight.js", "run", dateStr]);
    run("node", ["habits/scripts/sensory_queue.js", "ingest", dateStr]);
    run("node", ["systems/actuation/bridge_from_proposals.js", "run", dateStr]);
    const enrich = runJson("node", ["systems/autonomy/proposal_enricher.js", "run", dateStr]);
    const enrichPayload = enrich.payload && typeof enrich.payload === "object" ? enrich.payload : null;
    if (!enrich.ok || !enrichPayload || enrichPayload.ok !== true) {
      console.error(` proposal_enricher FAIL code=${enrich.code} reason=${String(enrich.stderr || enrich.stdout || "unknown").slice(0, 140)}`);
      process.exit(enrich.code || 1);
    }
    const admission = enrichPayload.admission && typeof enrichPayload.admission === "object"
      ? enrichPayload.admission
      : { total: 0, eligible: 0, blocked: 0, blocked_by_reason: {} };
    const topBlockedReason = Object.entries(admission.blocked_by_reason || {})
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0] || null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_proposal_admission",
      mode,
      date: dateStr,
      changed: Number(enrichPayload.changed || 0),
      total: Number(admission.total || 0),
      eligible: Number(admission.eligible || 0),
      blocked: Number(admission.blocked || 0),
      blocked_by_reason: admission.blocked_by_reason || {},
      top_blocked_reason: topBlockedReason ? { reason: topBlockedReason[0], count: Number(topBlockedReason[1] || 0) } : null
    });
    const topBlockedMsg = topBlockedReason ? ` top_blocked=${topBlockedReason[0]}:${Number(topBlockedReason[1] || 0)}` : "";
    console.log(` proposal_admission eligible=${Number(admission.eligible || 0)}/${Number(admission.total || 0)} blocked=${Number(admission.blocked || 0)}${topBlockedMsg}`);
  } else {
    console.log(" signal_gate SKIP reason=no_real_external_items");
  }
  if (mode === "daily") {
    const slo = runJson("node", ["habits/scripts/external_eyes.js", "slo", dateStr]);
    const payload = (slo.payload && typeof slo.payload === "object") ? slo.payload : null;
    signalSloOk = !!(slo.ok && payload && payload.ok === true);
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_signal_slo",
      mode,
      date: dateStr,
      ok: signalSloOk,
      checks: payload ? payload.checks : null,
      failed_checks: payload ? payload.failed_checks : null,
      reason: !signalSloOk
        ? (payload && Array.isArray(payload.failed_checks)
          ? `failed_checks:${payload.failed_checks.join(",")}`
          : `slo_exit_${slo.code}`)
        : null
    });
    if (signalSloOk) {
      console.log(" signal_slo ok");
    } else {
      const failed = payload && Array.isArray(payload.failed_checks) ? payload.failed_checks.join(",") : "unknown";
      console.log(` signal_slo FAIL failed_checks=${failed}`);
    }
  }

  if (mode === "daily") {
    // Backpressure + auto-triage (deterministic). Keeps queue from growing without bound.
    // Defaults: cap_per_eye=10, ttl_hours=48 (low-impact only)
    run("node", ["habits/scripts/queue_gc.js", "run", dateStr]);
  }

  // Always list after ingest (+ optional GC) so you see final queue state.
  run("node", ["habits/scripts/sensory_queue.js", "list", `--date=${dateStr}`]);

  if (mode === "daily") {
    if (String(process.env.AUTONOMY_ENABLED || "") === "1") {
      // Bounded autonomy loop (WIP=1) behind feature flag.
      run("node", ["systems/autonomy/autonomy_controller.js", "run", dateStr]);
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_autonomy_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "AUTONOMY_ENABLED",
        flag_value: String(process.env.AUTONOMY_ENABLED || "")
      });
      console.log(" autonomy_skipped reason=feature_flag_disabled flag=AUTONOMY_ENABLED");

      // Shadow evidence loop: dry-run/preflight verification receipts only (no execution side effects).
      // Default 2 attempts/day to build readiness signal while execution is disabled.
      const evidenceRunsRaw = Number(process.env.AUTONOMY_EVIDENCE_RUNS || 2);
      const evidenceRuns = Number.isFinite(evidenceRunsRaw)
        ? Math.max(0, Math.min(6, Math.floor(evidenceRunsRaw)))
        : 2;
      let evidenceOkCount = 0;
      if (evidenceRuns <= 0) {
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_autonomy_evidence_skipped",
          mode,
          date: dateStr,
          reason: "feature_flag_disabled",
          flag: "AUTONOMY_EVIDENCE_RUNS",
          flag_value: String(process.env.AUTONOMY_EVIDENCE_RUNS || "")
        });
        console.log(" autonomy_evidence skipped reason=feature_flag_disabled flag=AUTONOMY_EVIDENCE_RUNS");
      } else {
        for (let i = 0; i < evidenceRuns; i++) {
          const evidence = runJson("node", ["systems/autonomy/autonomy_controller.js", "evidence", dateStr]);
          const evPayload = evidence.payload && typeof evidence.payload === "object" ? evidence.payload : null;
          const ok = evidence.ok && !!evPayload;
          if (ok) evidenceOkCount++;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_autonomy_evidence",
            mode,
            date: dateStr,
            attempt_index: i + 1,
            attempts_total: evidenceRuns,
            ok,
            result: evPayload ? evPayload.result || null : null,
            proposal_id: evPayload ? evPayload.proposal_id || null : null,
            preview_receipt_id: evPayload ? evPayload.preview_receipt_id || null : null,
            reason: !evidence.ok
              ? String(evidence.stderr || evidence.stdout || `autonomy_evidence_exit_${evidence.code}`).slice(0, 180)
              : null
          });
          if (ok) {
            console.log(` autonomy_evidence attempt=${i + 1}/${evidenceRuns} result=${evPayload.result || "unknown"} receipt=${evPayload.preview_receipt_id || "none"}`);
          } else {
            console.log(` autonomy_evidence attempt=${i + 1}/${evidenceRuns} unavailable reason=${String(evidence.stderr || evidence.stdout || "unknown").slice(0, 120)}`);
          }
        }
        console.log(` autonomy_evidence summary ok=${evidenceOkCount}/${evidenceRuns}`);
      }
    }

    let strategyReadiness = runJson("node", ["systems/autonomy/strategy_readiness.js", "run", dateStr]);
    let readyPayload = strategyReadiness.payload && typeof strategyReadiness.payload === "object"
      ? strategyReadiness.payload
      : null;
    let readinessObj = readyPayload && readyPayload.readiness && typeof readyPayload.readiness === "object"
      ? readyPayload.readiness
      : null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_strategy_readiness",
      mode,
      date: dateStr,
      ok: strategyReadiness.ok && !!readyPayload,
      strategy_id: readyPayload && readyPayload.strategy ? readyPayload.strategy.id || null : null,
      current_mode: readinessObj ? readinessObj.current_mode || null : null,
      ready_for_execute: readinessObj ? readinessObj.ready_for_execute === true : null,
      recommended_mode: readinessObj ? readinessObj.recommended_mode || null : null,
      failed_checks: readinessObj && Array.isArray(readinessObj.failed_checks) ? readinessObj.failed_checks : [],
      attempted: readinessObj && readinessObj.metrics ? Number(readinessObj.metrics.attempted || 0) : null,
      verified_rate: readinessObj && readinessObj.metrics ? Number(readinessObj.metrics.verified_rate || 0) : null,
      reason: !strategyReadiness.ok
        ? String(strategyReadiness.stderr || strategyReadiness.stdout || `readiness_exit_${strategyReadiness.code}`).slice(0, 180)
        : null
    });
    if (strategyReadiness.ok && readinessObj) {
      const failed = Array.isArray(readinessObj.failed_checks) ? readinessObj.failed_checks.join(",") : "";
      console.log(` strategy_readiness mode=${readinessObj.current_mode} ready=${readinessObj.ready_for_execute} recommended=${readinessObj.recommended_mode} failed_checks=${failed || "none"}`);
    } else {
      console.log(` strategy_readiness unavailable reason=${String(strategyReadiness.stderr || strategyReadiness.stdout || "unknown").slice(0, 120)}`);
    }

    if (
      String(process.env.AUTONOMY_ENABLED || "") === "1"
      && strategyReadiness.ok
      && readinessObj
      && readinessObj.current_mode === "score_only"
      && Array.isArray(readinessObj.failed_checks)
      && readinessObj.failed_checks.length === 1
      && readinessObj.failed_checks[0] === "attempted"
    ) {
      const boostRunsRaw = Number(process.env.AUTONOMY_GRADUATION_EVIDENCE_BOOST_RUNS || 2);
      const boostRuns = Number.isFinite(boostRunsRaw)
        ? Math.max(0, Math.min(6, Math.floor(boostRunsRaw)))
        : 2;
      let boostOk = 0;
      for (let i = 0; i < boostRuns; i++) {
        const evidence = runJson("node", ["systems/autonomy/autonomy_controller.js", "evidence", dateStr]);
        const evPayload = evidence.payload && typeof evidence.payload === "object" ? evidence.payload : null;
        const ok = evidence.ok && !!evPayload;
        if (ok) boostOk++;
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_autonomy_graduation_evidence",
          mode,
          date: dateStr,
          attempt_index: i + 1,
          attempts_total: boostRuns,
          ok,
          result: evPayload ? evPayload.result || null : null,
          proposal_id: evPayload ? evPayload.proposal_id || null : null,
          preview_receipt_id: evPayload ? evPayload.preview_receipt_id || null : null,
          reason: !evidence.ok
            ? String(evidence.stderr || evidence.stdout || `autonomy_evidence_exit_${evidence.code}`).slice(0, 180)
            : null
        });
        if (ok) {
          console.log(` autonomy_graduation_evidence attempt=${i + 1}/${boostRuns} result=${evPayload.result || "unknown"} receipt=${evPayload.preview_receipt_id || "none"}`);
        } else {
          console.log(` autonomy_graduation_evidence attempt=${i + 1}/${boostRuns} unavailable reason=${String(evidence.stderr || evidence.stdout || "unknown").slice(0, 120)}`);
        }
      }
      if (boostRuns > 0) {
        console.log(` autonomy_graduation_evidence summary ok=${boostOk}/${boostRuns}`);
        strategyReadiness = runJson("node", ["systems/autonomy/strategy_readiness.js", "run", dateStr]);
        readyPayload = strategyReadiness.payload && typeof strategyReadiness.payload === "object"
          ? strategyReadiness.payload
          : null;
        readinessObj = readyPayload && readyPayload.readiness && typeof readyPayload.readiness === "object"
          ? readyPayload.readiness
          : null;
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_strategy_readiness_refresh",
          mode,
          date: dateStr,
          ok: strategyReadiness.ok && !!readyPayload,
          strategy_id: readyPayload && readyPayload.strategy ? readyPayload.strategy.id || null : null,
          current_mode: readinessObj ? readinessObj.current_mode || null : null,
          ready_for_execute: readinessObj ? readinessObj.ready_for_execute === true : null,
          recommended_mode: readinessObj ? readinessObj.recommended_mode || null : null,
          failed_checks: readinessObj && Array.isArray(readinessObj.failed_checks) ? readinessObj.failed_checks : [],
          attempted: readinessObj && readinessObj.metrics ? Number(readinessObj.metrics.attempted || 0) : null,
          verified_rate: readinessObj && readinessObj.metrics ? Number(readinessObj.metrics.verified_rate || 0) : null,
          source: "autonomy_graduation_evidence"
        });
        if (strategyReadiness.ok && readinessObj) {
          const failed = Array.isArray(readinessObj.failed_checks) ? readinessObj.failed_checks.join(",") : "";
          console.log(` strategy_readiness_refresh mode=${readinessObj.current_mode} ready=${readinessObj.ready_for_execute} recommended=${readinessObj.recommended_mode} failed_checks=${failed || "none"}`);
        } else {
          console.log(` strategy_readiness_refresh unavailable reason=${String(strategyReadiness.stderr || strategyReadiness.stdout || "unknown").slice(0, 120)}`);
        }
      }
    }

    const strategyExecuteGuard = runJson("node", ["systems/autonomy/strategy_execute_guard.js", "run", dateStr]);
    const guardPayload = strategyExecuteGuard.payload && typeof strategyExecuteGuard.payload === "object"
      ? strategyExecuteGuard.payload
      : null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_strategy_execute_guard",
      mode,
      date: dateStr,
      ok: strategyExecuteGuard.ok && !!guardPayload,
      result: guardPayload ? guardPayload.result || null : null,
      strategy_id: guardPayload ? guardPayload.strategy_id || null : null,
      consecutive_not_ready: guardPayload ? Number(guardPayload.consecutive_not_ready || 0) : null,
      threshold: guardPayload ? Number(guardPayload.max_consecutive_not_ready || guardPayload.threshold || 0) : null,
      reason: !strategyExecuteGuard.ok
        ? String(strategyExecuteGuard.stderr || strategyExecuteGuard.stdout || `execute_guard_exit_${strategyExecuteGuard.code}`).slice(0, 180)
        : null
    });
    if (strategyExecuteGuard.ok && guardPayload) {
      console.log(` strategy_execute_guard result=${guardPayload.result || "unknown"} consecutive_not_ready=${Number(guardPayload.consecutive_not_ready || 0)}`);
    } else {
      console.log(` strategy_execute_guard unavailable reason=${String(strategyExecuteGuard.stderr || strategyExecuteGuard.stdout || "unknown").slice(0, 120)}`);
    }

    const strategyGovernor = runJson("node", ["systems/autonomy/strategy_mode_governor.js", "run", dateStr]);
    const governorPayload = strategyGovernor.payload && typeof strategyGovernor.payload === "object"
      ? strategyGovernor.payload
      : null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_strategy_mode_governor",
      mode,
      date: dateStr,
      ok: strategyGovernor.ok && !!governorPayload,
      result: governorPayload ? governorPayload.result || null : null,
      strategy_id: governorPayload ? governorPayload.strategy_id || null : null,
      from_mode: governorPayload ? governorPayload.from_mode || null : null,
      to_mode: governorPayload ? governorPayload.to_mode || null : null,
      reason: governorPayload
        ? governorPayload.reason || null
        : String(strategyGovernor.stderr || strategyGovernor.stdout || `mode_governor_exit_${strategyGovernor.code}`).slice(0, 180)
    });
    if (strategyGovernor.ok && governorPayload) {
      console.log(` strategy_mode_governor result=${governorPayload.result || "unknown"} from=${governorPayload.from_mode || "n/a"} to=${governorPayload.to_mode || "n/a"}`);
    } else {
      console.log(` strategy_mode_governor unavailable reason=${String(strategyGovernor.stderr || strategyGovernor.stdout || "unknown").slice(0, 120)}`);
    }

    // DAILY MODE (orchestration only)
    // 1) auto-record shipped outcomes from git tags
    run("node", ["habits/scripts/git_outcomes.js", "run", dateStr]);

    // 2) end-of-day closeout (includes scoring + summary)
    run("node", ["habits/scripts/dopamine_engine.js", "closeout", dateStr]);

    // 3) sensory digest + anomalies
    run("node", ["habits/scripts/sensory_digest.js", "daily", dateStr]);

    // 4) optional external state backup (outside git workspace)
    if (String(process.env.STATE_BACKUP_ENABLED || "") === "1") {
      const backupArgs = ["systems/ops/state_backup.js", "run", `--date=${dateStr}`];
      if (String(process.env.STATE_BACKUP_DEST || "").trim()) {
        backupArgs.push(`--dest=${String(process.env.STATE_BACKUP_DEST).trim()}`);
      }
      if (String(process.env.STATE_BACKUP_DRY_RUN || "") === "1") {
        backupArgs.push("--dry-run");
      }
      const backup = runJson("node", backupArgs);
      const backupPayload = backup.payload && typeof backup.payload === "object" ? backup.payload : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_state_backup",
        mode,
        date: dateStr,
        ok: backup.ok && !!backupPayload && backupPayload.ok === true,
        profile: backupPayload ? backupPayload.profile || null : null,
        destination: backupPayload ? backupPayload.destination || null : null,
        snapshot_id: backupPayload ? backupPayload.snapshot_id || null : null,
        file_count: backupPayload ? Number(backupPayload.file_count || 0) : null,
        total_bytes: backupPayload ? Number(backupPayload.total_bytes || 0) : null,
        reason: (!backup.ok || !backupPayload || backupPayload.ok !== true)
          ? String(backup.stderr || backup.stdout || `state_backup_exit_${backup.code}`).slice(0, 180)
          : null
      });
      if (backup.ok && backupPayload && backupPayload.ok === true) {
        console.log(` state_backup ok snapshot=${backupPayload.snapshot_id || "unknown"} files=${Number(backupPayload.file_count || 0)}`);
      } else {
        console.log(` state_backup unavailable reason=${String(backup.stderr || backup.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_state_backup_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "STATE_BACKUP_ENABLED",
        flag_value: String(process.env.STATE_BACKUP_ENABLED || "")
      });
      console.log(" state_backup skipped reason=feature_flag_disabled flag=STATE_BACKUP_ENABLED");
    }
  }

  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_run_ok",
    mode,
    date: dateStr,
    signal_gate_ok: signalGateOk,
    signal_slo_ok: signalSloOk
  });

  if (mode === "daily") {
    const pending = modelCatalogPendingCount();
    console.log(` model_catalog_apply_pending=${pending}`);
  }

  console.log(` ✅ spine complete (${mode}) for ${dateStr}`);
}

main();
