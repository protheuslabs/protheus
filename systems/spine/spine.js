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
const crypto = require("crypto");
const { isEmergencyStopEngaged } = require("../../lib/emergency_stop.js");
const { stampGuardEnv } = require("../../lib/request_envelope.js");
const { compactCommandOutput } = require("../../lib/command_output_compactor.js");

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
  const rawOut = String(r.stdout || "").trim();
  const rawErr = String(r.stderr || "").trim();
  const compactStdout = compactCommandOutput(rawOut, `${path.basename(String(args && args[0] || cmd || "command"))}:stdout`);
  const compactStderr = compactCommandOutput(rawErr, `${path.basename(String(args && args[0] || cmd || "command"))}:stderr`);
  const out = compactStdout.text;
  const err = compactStderr.text;
  let payload = null;
  if (rawOut) {
    try {
      payload = JSON.parse(rawOut);
    } catch {
      const line = rawOut.split("\n").find(x => x.trim().startsWith("{")) || rawOut;
      try { payload = JSON.parse(line); } catch {}
    }
  }
  return {
    ok: r.status === 0,
    code: r.status == null ? 1 : r.status,
    payload,
    stdout: out,
    stderr: err,
    stdout_compacted: compactStdout.compacted === true,
    stdout_raw_path: compactStdout.raw_path || null,
    stderr_compacted: compactStderr.compacted === true,
    stderr_raw_path: compactStderr.raw_path || null
  };
}

function guard(files) {
  // guard expects repo-relative paths
  const source = String(process.env.REQUEST_SOURCE || "local").trim() || "local";
  const action = String(process.env.REQUEST_ACTION || "apply").trim() || "apply";
  const env = stampGuardEnv({ ...process.env }, { source, action, files });
  run("node", ["systems/security/guard.js", `--files=${files.join(",")}`], { env });
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

function spineShortCircuitStatePath() {
  return path.join(repoRoot(), "state", "spine", "short_circuit_state.json");
}

function readSpineShortCircuitState() {
  try {
    const fp = spineShortCircuitStatePath();
    if (!fs.existsSync(fp)) return { entries: {} };
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!parsed || typeof parsed !== "object") return { entries: {} };
    if (!parsed.entries || typeof parsed.entries !== "object") parsed.entries = {};
    return parsed;
  } catch {
    return { entries: {} };
  }
}

function writeSpineShortCircuitState(state) {
  const fp = spineShortCircuitStatePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(state || { entries: {} }, null, 2));
}

function hashFileOrMissing(fp) {
  try {
    if (!fs.existsSync(fp)) return "missing";
    const st = fs.statSync(fp);
    const h = crypto.createHash("sha1");
    h.update(String(st.size));
    h.update("|");
    h.update(String(st.mtimeMs));
    return h.digest("hex");
  } catch {
    return "error";
  }
}

function spineStateFingerprint(mode, dateStr) {
  const root = repoRoot();
  const tracked = [
    path.join(root, "state", "sensory", "eyes", "raw", `${dateStr}.jsonl`),
    path.join(root, "state", "sensory", "eyes", "metrics", `${dateStr}.json`),
    path.join(root, "state", "sensory", "proposals", `${dateStr}.json`),
    path.join(root, "state", "queue", "decisions", `${dateStr}.jsonl`),
    path.join(root, "state", "autonomy", "cooldowns.json")
  ];
  const payload = {
    mode: String(mode || ""),
    date: String(dateStr || ""),
    files: tracked.map(fp => ({
      path: path.relative(root, fp),
      hash: hashFileOrMissing(fp)
    }))
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex");
}

function shouldShortCircuitDaily(mode, dateStr) {
  if (mode !== "daily") {
    return { enabled: false, hit: false, reason: "mode_not_daily" };
  }
  if (String(process.env.SPINE_UNCHANGED_SHORT_CIRCUIT || "1") === "0") {
    return { enabled: false, hit: false, reason: "feature_flag_disabled" };
  }
  const ttlMinutesRaw = Number(process.env.SPINE_UNCHANGED_SHORT_CIRCUIT_MINUTES || 45);
  const ttlMinutes = Number.isFinite(ttlMinutesRaw) ? Math.max(5, Math.min(240, Math.round(ttlMinutesRaw))) : 45;
  const key = `${mode}:${dateStr}`;
  const fingerprint = spineStateFingerprint(mode, dateStr);
  const state = readSpineShortCircuitState();
  const prev = state.entries && state.entries[key] ? state.entries[key] : null;
  const nowMs = Date.now();
  const prevMs = prev && prev.ts ? Date.parse(String(prev.ts)) : NaN;
  const ageMinutes = Number.isFinite(prevMs) ? (nowMs - prevMs) / 60000 : null;
  const same = !!(prev && String(prev.fingerprint || "") === fingerprint);
  const hit = same && ageMinutes != null && ageMinutes >= 0 && ageMinutes <= ttlMinutes;
  state.entries = state.entries || {};
  state.entries[key] = {
    ts: nowIso(),
    fingerprint,
    ttl_minutes: ttlMinutes
  };
  writeSpineShortCircuitState(state);
  return {
    enabled: true,
    hit,
    key,
    fingerprint,
    ttl_minutes: ttlMinutes,
    age_minutes: ageMinutes == null ? null : Number(ageMinutes.toFixed(2))
  };
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
    "systems/ops/openclaw_backup_retention.js",
    "systems/memory/eyes_memory_bridge.js",
    "systems/memory/memory_dream.js",
    "systems/memory/uid_connections.js",
    "systems/memory/creative_links.js",
    "systems/sensory/cross_signal_engine.js",
    "config/actuation_adapters.json",
    "config/state_backup_policy.json",
    "skills/moltbook/actuation_adapter.js",
    "skills/moltbook/moltbook_publish_guard.js",
    "systems/routing/route_execute.js",
    "systems/routing/route_task.js",
    "systems/routing/model_router.js",
    "systems/routing/router_budget_calibration.js",
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
  run("node", ["systems/sensory/cross_signal_engine.js", "run", dateStr]);
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
    const eyesMemoryBridge = runJson("node", ["systems/memory/eyes_memory_bridge.js", "run", dateStr]);
    const bridgePayload = eyesMemoryBridge.payload && typeof eyesMemoryBridge.payload === "object"
      ? eyesMemoryBridge.payload
      : null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_eyes_memory_bridge",
      mode,
      date: dateStr,
      ok: eyesMemoryBridge.ok && !!bridgePayload && bridgePayload.ok === true,
      created_nodes: bridgePayload ? Number(bridgePayload.created_nodes || 0) : null,
      selected: bridgePayload ? Number(bridgePayload.selected || 0) : null,
      eligible_candidates: bridgePayload ? Number(bridgePayload.eligible_candidates || 0) : null,
      pointers_file: bridgePayload ? bridgePayload.pointers_file || null : null,
      reason: (!eyesMemoryBridge.ok || !bridgePayload || bridgePayload.ok !== true)
        ? String(eyesMemoryBridge.stderr || eyesMemoryBridge.stdout || `eyes_memory_bridge_exit_${eyesMemoryBridge.code}`).slice(0, 180)
        : null
    });
    if (!eyesMemoryBridge.ok || !bridgePayload || bridgePayload.ok !== true) {
      console.error(` eyes_memory_bridge FAIL code=${eyesMemoryBridge.code} reason=${String(eyesMemoryBridge.stderr || eyesMemoryBridge.stdout || "unknown").slice(0, 140)}`);
      process.exit(eyesMemoryBridge.code || 1);
    }
    console.log(
      ` eyes_memory_bridge nodes=${Number(bridgePayload.created_nodes || 0)}` +
      ` selected=${Number(bridgePayload.selected || 0)}` +
      ` eligible=${Number(bridgePayload.eligible_candidates || 0)}`
    );
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

  const shortCircuit = shouldShortCircuitDaily(mode, dateStr);
  if (shortCircuit.enabled && shortCircuit.hit) {
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_short_circuit",
      mode,
      date: dateStr,
      reason: "unchanged_state",
      key: shortCircuit.key,
      fingerprint: shortCircuit.fingerprint,
      ttl_minutes: shortCircuit.ttl_minutes,
      age_minutes: shortCircuit.age_minutes
    });
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_run_ok",
      mode,
      date: dateStr,
      signal_gate_ok: signalGateOk,
      signal_slo_ok: signalSloOk,
      short_circuit: true
    });
    console.log(
      ` spine_short_circuit reason=unchanged_state ttl_minutes=${shortCircuit.ttl_minutes}` +
      ` age_minutes=${shortCircuit.age_minutes == null ? "n/a" : shortCircuit.age_minutes}`
    );
    console.log(` ✅ spine complete (${mode}) for ${dateStr}`);
    return;
  }

  if (mode === "daily") {
    if (String(process.env.AUTONOMY_ENABLED || "") === "1") {
      const scheduler = runJson("node", ["systems/autonomy/canary_scheduler.js", "run", dateStr]);
      const schedulerPayload = scheduler.payload && typeof scheduler.payload === "object"
        ? scheduler.payload
        : null;
      const readinessPayload = schedulerPayload && schedulerPayload.readiness && typeof schedulerPayload.readiness === "object"
        ? schedulerPayload.readiness
        : null;
      const blockers = readinessPayload && Array.isArray(readinessPayload.blockers)
        ? readinessPayload.blockers
        : [];
      const topBlocker = blockers.length ? blockers[0] : null;
      const readinessOk = !!(readinessPayload && readinessPayload.ok === true);
      const schedulerQuality = schedulerPayload && schedulerPayload.scheduler_quality && typeof schedulerPayload.scheduler_quality === "object"
        ? schedulerPayload.scheduler_quality
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_autonomy_readiness",
        mode,
        date: dateStr,
        ok: readinessOk,
        can_run: readinessPayload ? readinessPayload.can_run === true : null,
        next_runnable_at: readinessPayload ? readinessPayload.next_runnable_at || null : null,
        manual_action_required: readinessPayload ? readinessPayload.manual_action_required === true : null,
        blocker_count: blockers.length,
        scheduler_attempted: schedulerQuality ? schedulerQuality.attempted === true : null,
        scheduler_verified: schedulerQuality ? schedulerQuality.verified === true : null,
        scheduler_fail_reason: schedulerQuality && schedulerQuality.fail_reason
          ? String(schedulerQuality.fail_reason).slice(0, 120)
          : null,
        top_blocker: topBlocker ? {
          code: topBlocker.code || null,
          detail: String(topBlocker.detail || "").slice(0, 160),
          retryable: topBlocker.retryable !== false,
          next_at: topBlocker.next_at || null
        } : null,
        reason: !readinessOk
          ? String(
              (schedulerPayload && schedulerPayload.error)
              || scheduler.stderr
              || scheduler.stdout
              || `canary_scheduler_exit_${scheduler.code}`
            ).slice(0, 180)
          : null
      });
      if (!scheduler.ok || !schedulerPayload) {
        console.log(` autonomy_scheduler unavailable reason=${String(scheduler.stderr || scheduler.stdout || "unknown").slice(0, 120)} fallback=run`);
        run("node", ["systems/autonomy/autonomy_controller.js", "run", dateStr]);
      } else if (String(schedulerPayload.result || "") === "skipped_blocked") {
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_autonomy_skipped",
          mode,
          date: dateStr,
          reason: "readiness_blocked",
          blocker_count: blockers.length,
          top_blocker: topBlocker ? topBlocker.code || null : null,
          next_runnable_at: readinessPayload.next_runnable_at || null
        });
        console.log(
          ` autonomy_skipped reason=readiness_blocked` +
          ` blocker=${topBlocker ? String(topBlocker.code || "unknown") : "none"}` +
          ` next=${String(readinessPayload && readinessPayload.next_runnable_at || "n/a")}`
        );
        if (schedulerQuality) {
          console.log(
            ` autonomy_scheduler_quality attempted=${schedulerQuality.attempted === true}` +
            ` verified=${schedulerQuality.verified === true}` +
            ` fail=${String(schedulerQuality.fail_reason || "none")}`
          );
        }
      } else {
        const runPayload = schedulerPayload.run && schedulerPayload.run.payload && typeof schedulerPayload.run.payload === "object"
          ? schedulerPayload.run.payload
          : null;
        const proposalId = runPayload && runPayload.proposal_id
          ? String(runPayload.proposal_id)
          : "none";
        const receiptId = runPayload && runPayload.receipt_id
          ? String(runPayload.receipt_id)
          : String(schedulerPayload.scheduler_receipt_id || "none");
        console.log(
          ` autonomy_scheduler result=${String(schedulerPayload.result || "unknown")}` +
          ` proposal=${proposalId}` +
          ` receipt=${receiptId}`
        );
        if (schedulerQuality) {
          console.log(
            ` autonomy_scheduler_quality attempted=${schedulerQuality.attempted === true}` +
            ` verified=${schedulerQuality.verified === true}` +
            ` fail=${String(schedulerQuality.fail_reason || "none")}`
          );
        }
      }
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

    // 0) realized-outcome feedback loop -> adaptive policy updates for strategy/focus/proposal filters.
    if (String(process.env.SPINE_OUTCOME_FITNESS_ENABLED || "1") !== "0") {
      const fitnessArgs = [
        "systems/autonomy/outcome_fitness_loop.js",
        "run",
        dateStr,
        `--days=${Math.max(1, Number(process.env.SPINE_OUTCOME_FITNESS_DAYS || 14) || 14)}`
      ];
      if (String(process.env.SPINE_OUTCOME_FITNESS_APPLY || "1") !== "0") {
        fitnessArgs.push("--apply=1");
      } else {
        fitnessArgs.push("--apply=0");
      }
      const fitness = runJson("node", fitnessArgs);
      const fitnessPayload = fitness.payload && typeof fitness.payload === "object"
        ? fitness.payload
        : null;
      const strict = String(process.env.SPINE_OUTCOME_FITNESS_STRICT || "0") === "1";
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_outcome_fitness",
        mode,
        date: dateStr,
        ok: fitness.ok && !!fitnessPayload && fitnessPayload.ok === true,
        applied: fitnessPayload ? fitnessPayload.applied === true : null,
        realized_outcome_score: fitnessPayload ? Number(fitnessPayload.realized_outcome_score || 0) : null,
        shipped_rate: fitnessPayload && fitnessPayload.metrics && fitnessPayload.metrics.runs
          ? Number(fitnessPayload.metrics.runs.shipped_rate || 0)
          : null,
        verified_rate: fitnessPayload && fitnessPayload.metrics && fitnessPayload.metrics.receipts
          ? Number(fitnessPayload.metrics.receipts.verified_rate || 0)
          : null,
        focus_delta: fitnessPayload && fitnessPayload.focus_policy
          ? Number(fitnessPayload.focus_policy.min_focus_score_delta || 0)
          : null,
        min_success_criteria_count: fitnessPayload && fitnessPayload.proposal_filter_policy
          ? Number(fitnessPayload.proposal_filter_policy.min_success_criteria_count || 0)
          : null,
        reason: (!fitness.ok || !fitnessPayload)
          ? String(fitness.stderr || fitness.stdout || `outcome_fitness_exit_${fitness.code}`).slice(0, 180)
          : null
      });
      if (!fitness.ok || !fitnessPayload) {
        const reason = String(fitness.stderr || fitness.stdout || "unknown").slice(0, 120);
        console.log(` outcome_fitness unavailable reason=${reason}`);
        if (strict) process.exit(fitness.code || 1);
      } else {
        console.log(
          ` outcome_fitness score=${Number(fitnessPayload.realized_outcome_score || 0)}` +
          ` shipped_rate=${Number(fitnessPayload.metrics && fitnessPayload.metrics.runs ? fitnessPayload.metrics.runs.shipped_rate || 0 : 0)}` +
          ` verified_rate=${Number(fitnessPayload.metrics && fitnessPayload.metrics.receipts ? fitnessPayload.metrics.receipts.verified_rate || 0 : 0)}`
        );
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_outcome_fitness_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_OUTCOME_FITNESS_ENABLED",
        flag_value: String(process.env.SPINE_OUTCOME_FITNESS_ENABLED || "")
      });
      console.log(" outcome_fitness skipped reason=feature_flag_disabled flag=SPINE_OUTCOME_FITNESS_ENABLED");
    }

    // DAILY MODE (orchestration only)
    // 1) auto-record shipped outcomes from git tags
    run("node", ["habits/scripts/git_outcomes.js", "run", dateStr]);

    // 2) end-of-day closeout (includes scoring + summary)
    run("node", ["habits/scripts/dopamine_engine.js", "closeout", dateStr]);

    // 3) sensory digest + anomalies
    run("node", ["habits/scripts/sensory_digest.js", "daily", dateStr]);

    // 3b) deterministic memory "dream" synthesis from recent eyes-memory pointers.
    if (String(process.env.MEMORY_DREAM_ENABLED || "1") !== "0") {
      const dream = runJson("node", ["systems/memory/memory_dream.js", "run", dateStr]);
      const dreamPayload = dream.payload && typeof dream.payload === "object"
        ? dream.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_memory_dream",
        mode,
        date: dateStr,
        ok: dream.ok && !!dreamPayload && dreamPayload.ok === true,
        pointer_rows: dreamPayload ? Number(dreamPayload.pointer_rows || 0) : null,
        themes: dreamPayload ? Number(dreamPayload.themes || 0) : null,
        markdown_path: dreamPayload ? dreamPayload.markdown_path || null : null,
        json_path: dreamPayload ? dreamPayload.json_path || null : null,
        reason: (!dream.ok || !dreamPayload || dreamPayload.ok !== true)
          ? String(dream.stderr || dream.stdout || `memory_dream_exit_${dream.code}`).slice(0, 180)
          : null
      });
      if (dream.ok && dreamPayload && dreamPayload.ok === true) {
        console.log(` memory_dream themes=${Number(dreamPayload.themes || 0)} pointers=${Number(dreamPayload.pointer_rows || 0)}`);
      } else {
        console.log(` memory_dream unavailable reason=${String(dream.stderr || dream.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_memory_dream_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "MEMORY_DREAM_ENABLED",
        flag_value: String(process.env.MEMORY_DREAM_ENABLED || "")
      });
      console.log(" memory_dream skipped reason=feature_flag_disabled flag=MEMORY_DREAM_ENABLED");
    }

    // 3b.1) idle/REM dream cycle for passive consolidation.
    if (String(process.env.IDLE_DREAM_CYCLE_ENABLED || "1") !== "0") {
      const idleCycle = runJson("node", ["systems/memory/idle_dream_cycle.js", "run", dateStr]);
      const idlePayload = idleCycle.payload && typeof idleCycle.payload === "object"
        ? idleCycle.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_idle_dream_cycle",
        mode,
        date: dateStr,
        ok: idleCycle.ok && !!idlePayload && idlePayload.ok === true,
        idle_skipped: idlePayload && idlePayload.idle ? !!idlePayload.idle.skipped : null,
        idle_reason: idlePayload && idlePayload.idle ? idlePayload.idle.reason || null : null,
        rem_skipped: idlePayload && idlePayload.rem ? !!idlePayload.rem.skipped : null,
        rem_reason: idlePayload && idlePayload.rem ? idlePayload.rem.reason || null : null,
        rem_quantized_count: idlePayload && idlePayload.rem ? Number(idlePayload.rem.quantized_count || 0) : null,
        reason: (!idleCycle.ok || !idlePayload || idlePayload.ok !== true)
          ? String(idleCycle.stderr || idleCycle.stdout || `idle_dream_cycle_exit_${idleCycle.code}`).slice(0, 180)
          : null
      });
      if (idleCycle.ok && idlePayload && idlePayload.ok === true) {
        console.log(
          ` idle_dream_cycle idle=${idlePayload.idle && idlePayload.idle.skipped ? "skip" : "run"}` +
          ` rem=${idlePayload.rem && idlePayload.rem.skipped ? "skip" : "run"}`
        );
      } else {
        console.log(` idle_dream_cycle unavailable reason=${String(idleCycle.stderr || idleCycle.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_idle_dream_cycle_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "IDLE_DREAM_CYCLE_ENABLED",
        flag_value: String(process.env.IDLE_DREAM_CYCLE_ENABLED || "")
      });
      console.log(" idle_dream_cycle skipped reason=feature_flag_disabled flag=IDLE_DREAM_CYCLE_ENABLED");
    }

    // 3c) crystallize uid graph connections and adaptive-memory candidates from pointer activity.
    if (String(process.env.UID_CONNECTIONS_ENABLED || "1") !== "0") {
      const links = runJson("node", ["systems/memory/uid_connections.js", "build", dateStr]);
      const linksPayload = links.payload && typeof links.payload === "object"
        ? links.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_uid_connections",
        mode,
        date: dateStr,
        ok: links.ok && !!linksPayload && linksPayload.ok === true,
        pointers_considered: linksPayload ? Number(linksPayload.pointers_considered || 0) : null,
        new_connections: linksPayload ? Number(linksPayload.new_connections || 0) : null,
        new_adaptive_suggestions: linksPayload ? Number(linksPayload.new_adaptive_suggestions || 0) : null,
        adaptive_suggestions_file: linksPayload ? linksPayload.adaptive_suggestions_file || null : null,
        reason: (!links.ok || !linksPayload || linksPayload.ok !== true)
          ? String(links.stderr || links.stdout || `uid_connections_exit_${links.code}`).slice(0, 180)
          : null
      });
      if (links.ok && linksPayload && linksPayload.ok === true) {
        console.log(
          ` uid_connections links=${Number(linksPayload.new_connections || 0)}` +
          ` suggestions=${Number(linksPayload.new_adaptive_suggestions || 0)}` +
          ` pointers=${Number(linksPayload.pointers_considered || 0)}`
        );
      } else {
        console.log(` uid_connections unavailable reason=${String(links.stderr || links.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_uid_connections_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "UID_CONNECTIONS_ENABLED",
        flag_value: String(process.env.UID_CONNECTIONS_ENABLED || "")
      });
      console.log(" uid_connections skipped reason=feature_flag_disabled flag=UID_CONNECTIONS_ENABLED");
    }

    // 3d) promote useful dream links into first-class creative memory nodes.
    if (String(process.env.CREATIVE_LINKS_ENABLED || "1") !== "0") {
      const creativeLinks = runJson("node", ["systems/memory/creative_links.js", "run", dateStr]);
      const payload = creativeLinks.payload && typeof creativeLinks.payload === "object"
        ? creativeLinks.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_creative_links",
        mode,
        date: dateStr,
        ok: creativeLinks.ok && !!payload && payload.ok === true,
        themes_considered: payload ? Number(payload.themes_considered || 0) : null,
        candidates_total: payload ? Number(payload.candidates_total || 0) : null,
        promoted_count: payload ? Number(payload.promoted_count || 0) : null,
        reason: (!creativeLinks.ok || !payload || payload.ok !== true)
          ? String(creativeLinks.stderr || creativeLinks.stdout || `creative_links_exit_${creativeLinks.code}`).slice(0, 180)
          : null
      });
      if (creativeLinks.ok && payload && payload.ok === true) {
        console.log(
          ` creative_links promoted=${Number(payload.promoted_count || 0)}` +
          ` candidates=${Number(payload.candidates_total || 0)}` +
          ` themes=${Number(payload.themes_considered || 0)}`
        );
      } else {
        console.log(` creative_links unavailable reason=${String(creativeLinks.stderr || creativeLinks.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_creative_links_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "CREATIVE_LINKS_ENABLED",
        flag_value: String(process.env.CREATIVE_LINKS_ENABLED || "")
      });
      console.log(" creative_links skipped reason=feature_flag_disabled flag=CREATIVE_LINKS_ENABLED");
    }

    // 4) routing budget calibration report/apply from recent telemetry.
    if (String(process.env.SPINE_ROUTER_BUDGET_CALIBRATION || "1") !== "0") {
      const calibrationArgs = [
        "systems/routing/router_budget_calibration.js",
        "run",
        `--days=${Math.max(1, Number(process.env.SPINE_ROUTER_BUDGET_CALIBRATION_DAYS || 7) || 7)}`
      ];
      if (String(process.env.SPINE_ROUTER_BUDGET_CALIBRATION_APPLY || "") === "1") {
        calibrationArgs.push("--apply=1");
      }
      const approvalNote = String(process.env.SPINE_ROUTER_BUDGET_CALIBRATION_APPROVAL_NOTE || "").trim();
      if (approvalNote) {
        calibrationArgs.push(`--approval-note=${approvalNote}`);
      }
      if (String(process.env.SPINE_ROUTER_BUDGET_CALIBRATION_BREAK_GLASS || "") === "1") {
        calibrationArgs.push("--break-glass=1");
      }

      const calibration = runJson("node", calibrationArgs);
      const payload = calibration.payload && typeof calibration.payload === "object" ? calibration.payload : null;
      const applyResult = payload && payload.apply_result && typeof payload.apply_result === "object"
        ? payload.apply_result
        : null;
      const changed = payload ? Number(payload.changed_models || 0) : null;
      const applied = applyResult ? Number(applyResult.applied || 0) : 0;
      const strict = String(process.env.SPINE_ROUTER_BUDGET_CALIBRATION_STRICT || "0") === "1";
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_router_budget_calibration",
        mode,
        date: dateStr,
        ok: calibration.ok && !!payload,
        changed_models: changed,
        applied_models: applied,
        days: payload && payload.options ? Number(payload.options.days || 0) : null,
        actual_samples_total: payload && payload.telemetry ? Number(payload.telemetry.actual_samples_total || 0) : null,
        requests_total: payload && payload.telemetry ? Number(payload.telemetry.requests_total || 0) : null,
        reason: (!calibration.ok || !payload)
          ? String(calibration.stderr || calibration.stdout || `router_budget_calibration_exit_${calibration.code}`).slice(0, 180)
          : null
      });
      if (!calibration.ok || !payload) {
        const reason = String(calibration.stderr || calibration.stdout || "unknown").slice(0, 120);
        console.log(` router_budget_calibration unavailable reason=${reason}`);
        if (strict) process.exit(calibration.code || 1);
      } else if (applyResult && applyResult.ok === false) {
        const reason = String(applyResult.error || "apply_failed").slice(0, 120);
        console.log(` router_budget_calibration apply_fail reason=${reason}`);
        if (strict) process.exit(applyResult.code || 1);
      } else {
        const modeMsg = String(process.env.SPINE_ROUTER_BUDGET_CALIBRATION_APPLY || "") === "1" ? "apply" : "report";
        console.log(` router_budget_calibration mode=${modeMsg} changed=${changed == null ? "n/a" : changed} applied=${applied}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_router_budget_calibration_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_ROUTER_BUDGET_CALIBRATION",
        flag_value: String(process.env.SPINE_ROUTER_BUDGET_CALIBRATION || "")
      });
      console.log(" router_budget_calibration skipped reason=feature_flag_disabled flag=SPINE_ROUTER_BUDGET_CALIBRATION");
    }

    // 5) optional external state backup (outside git workspace)
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

    // 6) external OpenClaw config backup retention (keep recent backups + archive older).
    if (String(process.env.SPINE_OPENCLAW_BACKUP_RETENTION || "1") !== "0") {
      const retentionArgs = ["systems/ops/openclaw_backup_retention.js", "run"];
      if (String(process.env.OPENCLAW_BACKUP_ROOT || "").trim()) {
        retentionArgs.push(`--root=${String(process.env.OPENCLAW_BACKUP_ROOT).trim()}`);
      }
      if (String(process.env.OPENCLAW_BACKUP_KEEP || "").trim()) {
        retentionArgs.push(`--keep=${String(process.env.OPENCLAW_BACKUP_KEEP).trim()}`);
      }
      if (String(process.env.OPENCLAW_BACKUP_DRY_RUN || "") === "1") {
        retentionArgs.push("--dry-run");
      }
      const retention = runJson("node", retentionArgs);
      const retentionPayload = retention.payload && typeof retention.payload === "object" ? retention.payload : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_openclaw_backup_retention",
        mode,
        date: dateStr,
        ok: retention.ok && !!retentionPayload && retentionPayload.ok === true,
        dry_run: retentionPayload ? retentionPayload.dry_run === true : null,
        root: retentionPayload ? retentionPayload.root || null : null,
        keep_count: retentionPayload ? Number(retentionPayload.keep_count || 0) : null,
        total_backups: retentionPayload ? Number(retentionPayload.total_backups || 0) : null,
        retained_count: retentionPayload ? Number(retentionPayload.retained_count || 0) : null,
        archive_count: retentionPayload ? Number(retentionPayload.archive_count || 0) : null,
        moved_count: retentionPayload ? Number(retentionPayload.moved_count || 0) : null,
        archive_dir: retentionPayload ? retentionPayload.archive_dir || null : null,
        reason: (!retention.ok || !retentionPayload || retentionPayload.ok !== true)
          ? String(retention.stderr || retention.stdout || `openclaw_backup_retention_exit_${retention.code}`).slice(0, 180)
          : null
      });
      if (retention.ok && retentionPayload && retentionPayload.ok === true) {
        console.log(
          ` openclaw_backup_retention ok` +
          ` moved=${Number(retentionPayload.moved_count || 0)}` +
          ` kept=${Number(retentionPayload.retained_count || 0)}` +
          ` total=${Number(retentionPayload.total_backups || 0)}`
        );
      } else {
        console.log(` openclaw_backup_retention unavailable reason=${String(retention.stderr || retention.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_openclaw_backup_retention_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_OPENCLAW_BACKUP_RETENTION",
        flag_value: String(process.env.SPINE_OPENCLAW_BACKUP_RETENTION || "")
      });
      console.log(" openclaw_backup_retention skipped reason=feature_flag_disabled flag=SPINE_OPENCLAW_BACKUP_RETENTION");
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
