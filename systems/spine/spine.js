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
const {
  setSystemBudgetAutopause,
  clearSystemBudgetAutopause,
  loadSystemBudgetAutopauseState
} = require("../budget/system_budget.js");
const { emitPainSignal } = require("../autonomy/pain_signal.js");
const { computeEvidenceRunPlan } = require("./evidence_run_plan.js");
const { evaluateProviderGate } = require("../routing/provider_readiness.js");

let ACTIVE_SPINE_CONTEXT = { mode: null, date: null };

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
  if (r.status !== 0) {
    try {
      const mode = String(ACTIVE_SPINE_CONTEXT.mode || "unknown");
      const dateStr = todayOr(ACTIVE_SPINE_CONTEXT.date || null);
      const arg0 = String(args && args[0] || cmd || "command");
      emitPainSignal({
        ts: nowIso(),
        source: "spine",
        subsystem: "orchestration",
        code: `command_failed:${path.basename(arg0).replace(/[^a-zA-Z0-9._-]/g, "_")}`,
        summary: `Spine command failed (${arg0})`,
        details: `mode=${mode} date=${dateStr} exit_code=${Number(r.status || 1)}`,
        severity: "high",
        risk: "high",
        proposal_type: "spine_escalation",
        suggested_next_command: `node systems/spine/spine.js ${mode === "daily" ? "daily" : "eyes"} ${dateStr}`,
        window_hours: Number(process.env.SPINE_PAIN_WINDOW_HOURS || 12),
        escalate_after: Number(process.env.SPINE_PAIN_ESCALATE_AFTER || 1),
        cooldown_hours: Number(process.env.SPINE_PAIN_COOLDOWN_HOURS || 2),
        signature_extra: `${mode}:${dateStr}:${arg0}`,
        evidence: [
          {
            source: "spine_run",
            path: `state/spine/runs/${dateStr}.jsonl`,
            match: `command_failed:${arg0}`.slice(0, 120),
            evidence_ref: `spine:${mode}:${dateStr}`
          }
        ]
      });
    } catch {
      // pain signal must never block exit
    }
    process.exit(r.status || 1);
  }
}

function runJson(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  const spawnError = r.error ? String(r.error && r.error.message ? r.error.message : r.error) : "";
  const timedOut = /\bETIMEDOUT\b/i.test(spawnError);
  const rawOut = String(r.stdout || "").trim();
  const rawErr = [String(r.stderr || "").trim(), timedOut ? "process_timeout" : "", spawnError]
    .filter(Boolean)
    .join("\n")
    .trim();
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
    signal: r.signal || null,
    timed_out: timedOut,
    error: spawnError || null,
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

function emitSpinePainSignal(mode, dateStr, code, summary, details, options = {}) {
  try {
    emitPainSignal({
      ts: nowIso(),
      source: "spine",
      subsystem: "orchestration",
      code: String(code || "spine_failure").slice(0, 96),
      summary: String(summary || "Spine failure").slice(0, 240),
      details: String(details || "").slice(0, 900),
      severity: String(options.severity || "high"),
      risk: String(options.risk || "high"),
      proposal_type: "spine_escalation",
      suggested_next_command: `node systems/spine/spine.js ${mode === "daily" ? "daily" : "eyes"} ${dateStr}`,
      window_hours: Number(process.env.SPINE_PAIN_WINDOW_HOURS || 12),
      escalate_after: Number(process.env.SPINE_PAIN_ESCALATE_AFTER || 1),
      cooldown_hours: Number(process.env.SPINE_PAIN_COOLDOWN_HOURS || 2),
      signature_extra: String(options.signature_extra || `${mode}:${dateStr}`),
      evidence: [
        {
          source: "spine_run",
          path: `state/spine/runs/${dateStr}.jsonl`,
          match: String(code || "spine_failure").slice(0, 120),
          evidence_ref: `spine:${mode}:${dateStr}`
        }
      ]
    });
  } catch {
    // pain signal must never block spine
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

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function proposalTypeMapForDate(dateStr) {
  const fp = path.join(repoRoot(), "state", "sensory", "proposals", `${String(dateStr || "").slice(0, 10)}.json`);
  const raw = readJson(fp, []);
  const list = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.proposals) ? raw.proposals : []);
  const out = {};
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const id = String(row.id || "").trim();
    if (!id) continue;
    const t = String(row.type || "").trim().toLowerCase();
    if (!t) continue;
    out[id] = t;
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

function previousDateStr(dateStr) {
  const d = new Date(`${String(dateStr || "").slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) return null;
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function budgetEventsPath() {
  return path.join(repoRoot(), "state", "autonomy", "budget_events.jsonl");
}

function topModuleFromBudgetEvents(dateStr) {
  const rows = readJsonl(budgetEventsPath());
  const sums = new Map();
  for (const row of rows) {
    if (!row || row.type !== "system_budget_record") continue;
    if (String(row.date || "") !== String(dateStr || "")) continue;
    const moduleName = String(row.module || "").trim() || "unknown";
    const tokens = Number(row.tokens_est || 0);
    if (!Number.isFinite(tokens) || tokens <= 0) continue;
    sums.set(moduleName, Number(sums.get(moduleName) || 0) + tokens);
  }
  let best = null;
  for (const [name, used] of sums.entries()) {
    if (!best || used > best.used_est) best = { module: name, used_est: used };
  }
  return best;
}

function parseBudgetStatusPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const state = payload.state && typeof payload.state === "object" ? payload.state : null;
  const projection = payload.projection && typeof payload.projection === "object" ? payload.projection : {};
  if (!state) return null;
  const cap = Number(state.token_cap || 0);
  const used = Number(state.used_est || 0);
  const ratio = Number.isFinite(cap) && cap > 0 && Number.isFinite(used)
    ? Number((used / cap).toFixed(4))
    : null;
  const byModule = state.by_module && typeof state.by_module === "object" ? state.by_module : {};
  let topModule = null;
  for (const [name, ent] of Object.entries(byModule)) {
    const usedEst = Number(ent && ent.used_est || 0);
    if (!Number.isFinite(usedEst) || usedEst < 0) continue;
    if (!topModule || usedEst > topModule.used_est) {
      topModule = { module: String(name || "unknown"), used_est: usedEst };
    }
  }
  return {
    token_cap: Number.isFinite(cap) ? cap : null,
    used_est: Number.isFinite(used) ? used : null,
    ratio,
    pressure: String(projection.pressure || "none"),
    projected_pressure: String(projection.projected_pressure || projection.pressure || "none"),
    strategy_id: state.strategy_id ? String(state.strategy_id) : null,
    top_module: topModule
  };
}

function budgetHealthSummary(dateStr) {
  const current = runJson("node", ["systems/budget/system_budget.js", "status", dateStr]);
  const currentParsed = parseBudgetStatusPayload(current.payload);
  if (!current.ok || !currentParsed) {
    return {
      ok: false,
      reason: String(current.stderr || current.stdout || `system_budget_status_exit_${current.code}`).slice(0, 160)
    };
  }

  const prevDay = previousDateStr(dateStr);
  let prevPressure = null;
  if (prevDay) {
    const prev = runJson("node", ["systems/budget/system_budget.js", "status", prevDay]);
    const prevParsed = parseBudgetStatusPayload(prev.payload);
    if (prev.ok && prevParsed) prevPressure = prevParsed.pressure;
  }

  let topModule = currentParsed.top_module;
  let topModuleSource = "daily_state";
  if (!topModule || Number(topModule.used_est || 0) <= 0) {
    const fromEvents = topModuleFromBudgetEvents(dateStr);
    if (fromEvents) {
      topModule = fromEvents;
      topModuleSource = "budget_events";
    } else {
      topModuleSource = "none";
    }
  }

  const currentPressure = String(currentParsed.pressure || "none");
  return {
    ok: true,
    token_cap: currentParsed.token_cap,
    used_est: currentParsed.used_est,
    ratio: currentParsed.ratio,
    burn_pct: currentParsed.ratio == null ? null : Number((Number(currentParsed.ratio) * 100).toFixed(2)),
    pressure: currentPressure,
    projected_pressure: currentParsed.projected_pressure,
    previous_pressure: prevPressure,
    pressure_transition: prevPressure == null ? null : `${String(prevPressure)}->${currentPressure}`,
    strategy_id: currentParsed.strategy_id,
    top_module: topModule ? topModule.module : null,
    top_module_used_est: topModule ? Number(topModule.used_est || 0) : null,
    top_module_source: topModuleSource
  };
}

function budgetGuardStatePath() {
  return path.join(repoRoot(), "state", "spine", "budget_guard_state.json");
}

function readBudgetGuardState() {
  try {
    const fp = budgetGuardStatePath();
    if (!fs.existsSync(fp)) {
      return {
        consecutive_hard: 0,
        soft_run_counter: 0,
        paused_until_ms: 0,
        paused_until: null,
        last_pressure: null,
        last_action: null,
        last_reason: null,
        last_updated: null
      };
    }
    const raw = JSON.parse(fs.readFileSync(fp, "utf8"));
    if (!raw || typeof raw !== "object") throw new Error("invalid_state");
    return {
      consecutive_hard: Number.isFinite(Number(raw.consecutive_hard)) ? Math.max(0, Math.floor(Number(raw.consecutive_hard))) : 0,
      soft_run_counter: Number.isFinite(Number(raw.soft_run_counter)) ? Math.max(0, Math.floor(Number(raw.soft_run_counter))) : 0,
      paused_until_ms: Number.isFinite(Number(raw.paused_until_ms)) ? Math.max(0, Number(raw.paused_until_ms)) : 0,
      paused_until: raw.paused_until ? String(raw.paused_until) : null,
      last_pressure: raw.last_pressure ? String(raw.last_pressure) : null,
      last_action: raw.last_action ? String(raw.last_action) : null,
      last_reason: raw.last_reason ? String(raw.last_reason) : null,
      last_updated: raw.last_updated ? String(raw.last_updated) : null
    };
  } catch {
    return {
      consecutive_hard: 0,
      soft_run_counter: 0,
      paused_until_ms: 0,
      paused_until: null,
      last_pressure: null,
      last_action: null,
      last_reason: null,
      last_updated: null
    };
  }
}

function writeBudgetGuardState(state) {
  try {
    const fp = budgetGuardStatePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(state, null, 2));
  } catch {
    // fail-open: budget guard should never crash spine
  }
}

function budgetGuardSuggestionPath(dateStr) {
  const dir = path.join(repoRoot(), "state", "autonomy", "budget_guard_suggestions");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${dateStr}.json`);
}

function writeBudgetGuardSuggestion(dateStr, suggestion) {
  try {
    const fp = budgetGuardSuggestionPath(dateStr);
    let raw = [];
    if (fs.existsSync(fp)) {
      try {
        raw = JSON.parse(fs.readFileSync(fp, "utf8"));
      } catch {
        raw = [];
      }
    }
    const rows = Array.isArray(raw) ? raw : [];
    if (!rows.some((x) => x && String(x.id || "") === String(suggestion.id || ""))) {
      rows.push(suggestion);
    }
    fs.writeFileSync(fp, JSON.stringify(rows, null, 2));
    return fp;
  } catch {
    return null;
  }
}

function evaluateBudgetGuard(dateStr, budgetHealth) {
  if (!budgetHealth || budgetHealth.ok !== true) {
    return {
      enabled: true,
      ok: false,
      action: "allow",
      reason: "budget_health_unavailable",
      pressure: "none",
      projected_pressure: "none",
      suggestion_written: false,
      suggestion_path: null
    };
  }

  const hardRepeatThresholdRaw = Number(process.env.SPINE_BUDGET_GUARD_HARD_REPEAT_THRESHOLD || 2);
  const hardRepeatThreshold = Number.isFinite(hardRepeatThresholdRaw)
    ? Math.max(1, Math.min(10, Math.round(hardRepeatThresholdRaw)))
    : 2;
  const hardPauseMinutesRaw = Number(process.env.SPINE_BUDGET_GUARD_HARD_PAUSE_MINUTES || 360);
  const hardPauseMinutes = Number.isFinite(hardPauseMinutesRaw)
    ? Math.max(15, Math.min(24 * 60, Math.round(hardPauseMinutesRaw)))
    : 360;
  const softEveryRunsRaw = Number(process.env.SPINE_BUDGET_GUARD_SOFT_THROTTLE_EVERY_RUNS || 2);
  const softEveryRuns = Number.isFinite(softEveryRunsRaw)
    ? Math.max(2, Math.min(10, Math.round(softEveryRunsRaw)))
    : 2;

  const nowMs = Date.now();
  const pressure = String(budgetHealth.pressure || "none");
  const projectedPressure = String(budgetHealth.projected_pressure || pressure || "none");
  const state = readBudgetGuardState();

  let consecutiveHard = pressure === "hard"
    ? Number(state.consecutive_hard || 0) + 1
    : 0;
  let softRunCounter = pressure === "soft"
    ? Number(state.soft_run_counter || 0) + 1
    : 0;
  let pausedUntilMs = Number(state.paused_until_ms || 0);

  let action = "allow";
  let reason = "no_pressure";
  const pauseActive = Number.isFinite(pausedUntilMs) && pausedUntilMs > nowMs;

  if (pressure === "none" && projectedPressure === "none" && pauseActive) {
    pausedUntilMs = 0;
    consecutiveHard = 0;
    action = "allow";
    reason = "hard_pause_recovered";
  } else if (pressure === "hard" && consecutiveHard >= hardRepeatThreshold) {
    pausedUntilMs = Math.max(pausedUntilMs, nowMs + (hardPauseMinutes * 60 * 1000));
    action = "pause";
    reason = "repeated_hard_pressure";
  } else if (pauseActive) {
    action = "pause";
    reason = "hard_pause_cooldown_active";
  } else if (pressure === "soft") {
    const cycleIdx = (softRunCounter - 1) % softEveryRuns;
    if (cycleIdx === 0) {
      action = "allow";
      reason = "soft_pressure_allow_window";
    } else {
      action = "throttle";
      reason = "soft_pressure_throttle_window";
    }
  } else if (pressure === "hard") {
    action = "allow";
    reason = "hard_pressure_below_repeat_threshold";
  }

  const pausedUntilIso = pausedUntilMs > nowMs ? new Date(pausedUntilMs).toISOString() : null;
  const nextState = {
    consecutive_hard: consecutiveHard,
    soft_run_counter: softRunCounter,
    paused_until_ms: pausedUntilMs > nowMs ? pausedUntilMs : 0,
    paused_until: pausedUntilIso,
    last_pressure: pressure,
    last_action: action,
    last_reason: reason,
    last_updated: nowIso()
  };
  writeBudgetGuardState(nextState);
  try {
    if (action === "pause" && pausedUntilMs > nowMs) {
      setSystemBudgetAutopause({
        date: dateStr,
        source: "spine_budget_guard",
        reason,
        pressure,
        until_ms: pausedUntilMs
      });
    } else {
      const autopause = loadSystemBudgetAutopauseState();
      if (autopause && autopause.active === true && String(autopause.source || "") === "spine_budget_guard") {
        clearSystemBudgetAutopause({
          source: "spine_budget_guard",
          reason: `spine_budget_guard_${reason}`
        });
      }
    }
  } catch {
    // fail-open: global budget autopause sync should never block spine
  }

  let suggestionPath = null;
  let suggestionWritten = false;
  if (action === "pause" || action === "throttle") {
    const hash = crypto.createHash("sha1")
      .update(`${dateStr}|${pressure}|${action}|${reason}|${Number(budgetHealth.token_cap || 0)}|${Number(budgetHealth.used_est || 0)}`)
      .digest("hex")
      .slice(0, 16);
    const suggestion = {
      id: `BGS-${hash}`,
      date: dateStr,
      ts: nowIso(),
      type: "strategy_budget_adjustment_suggestion",
      source: "spine_budget_guard",
      status: "proposed",
      pressure,
      projected_pressure: projectedPressure,
      action,
      reason,
      token_cap: Number(budgetHealth.token_cap || 0),
      used_est: Number(budgetHealth.used_est || 0),
      burn_pct: budgetHealth.burn_pct == null ? null : Number(budgetHealth.burn_pct),
      top_module: budgetHealth.top_module || null,
      suggested_adjustments: action === "pause"
        ? [
            "Temporarily reduce strategy budget_policy.daily_token_cap by 10-20% for the next cycle.",
            "Increase local-first routing pressure controls under hard budget states before cloud fallback.",
            "Reduce autonomous execution frequency until pressure returns to soft/none."
          ]
        : [
            "Reduce autonomous execution frequency while budget pressure remains soft.",
            "Tighten per-action token estimates for non-critical runs to preserve headroom.",
            "Prioritize lower-cost route classes for repetitive low-risk work until pressure clears."
          ]
    };
    suggestionPath = writeBudgetGuardSuggestion(dateStr, suggestion);
    suggestionWritten = !!suggestionPath;
  }

  return {
    enabled: true,
    ok: true,
    action,
    reason,
    pressure,
    projected_pressure: projectedPressure,
    hard_repeat_threshold: hardRepeatThreshold,
    hard_pause_minutes: hardPauseMinutes,
    soft_throttle_every_runs: softEveryRuns,
    consecutive_hard: consecutiveHard,
    soft_run_counter: softRunCounter,
    paused_until: pausedUntilIso,
    suggestion_written: suggestionWritten,
    suggestion_path: suggestionPath
  };
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

function providerRecoveryPulse() {
  if (String(process.env.SPINE_PROVIDER_RECOVERY_PULSE || "1") === "0") {
    return {
      ok: true,
      skipped: true,
      reason: "feature_flag_disabled",
      flag: "SPINE_PROVIDER_RECOVERY_PULSE",
      flag_value: String(process.env.SPINE_PROVIDER_RECOVERY_PULSE || "")
    };
  }
  const forceCheck = String(process.env.SPINE_PROVIDER_RECOVERY_FORCE_CHECK || "1") !== "0";
  try {
    const gate = evaluateProviderGate("ollama", {
      source: "spine_startup_pulse",
      force_check: forceCheck
    });
    return {
      ok: true,
      skipped: false,
      provider: gate && gate.provider ? gate.provider : "ollama",
      available: !!(gate && gate.available === true),
      reason: gate && gate.reason ? String(gate.reason) : null,
      source: gate && gate.source ? String(gate.source) : null,
      checked: gate && gate.checked === true,
      circuit_open: !!(gate && gate.circuit_open === true),
      circuit_open_until_ts: gate && gate.circuit_open_until_ts ? gate.circuit_open_until_ts : null,
      last_check_ts: gate && gate.last_check_ts ? gate.last_check_ts : null
    };
  } catch (err) {
    return {
      ok: false,
      skipped: false,
      provider: "ollama",
      available: null,
      reason: "provider_recovery_pulse_failed",
      error: String(err && err.message ? err.message : err).slice(0, 180)
    };
  }
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

function providerRecoveryStatePath() {
  return path.join(repoRoot(), "state", "spine", "provider_recovery_state.json");
}

function readProviderRecoveryState() {
  try {
    const fp = providerRecoveryStatePath();
    if (!fs.existsSync(fp)) {
      return {
        ts: null,
        last_provider: "ollama",
        last_available: null,
        last_reason: null,
        last_transition_ts: null,
        last_warmup_ts: null,
        last_warmup_ok: null
      };
    }
    const parsed = JSON.parse(fs.readFileSync(fp, "utf8"));
    return {
      ts: parsed && parsed.ts ? String(parsed.ts) : null,
      last_provider: parsed && parsed.last_provider ? String(parsed.last_provider) : "ollama",
      last_available: parsed && typeof parsed.last_available === "boolean" ? parsed.last_available : null,
      last_reason: parsed && parsed.last_reason ? String(parsed.last_reason) : null,
      last_transition_ts: parsed && parsed.last_transition_ts ? String(parsed.last_transition_ts) : null,
      last_warmup_ts: parsed && parsed.last_warmup_ts ? String(parsed.last_warmup_ts) : null,
      last_warmup_ok: parsed && typeof parsed.last_warmup_ok === "boolean" ? parsed.last_warmup_ok : null
    };
  } catch {
    return {
      ts: null,
      last_provider: "ollama",
      last_available: null,
      last_reason: null,
      last_transition_ts: null,
      last_warmup_ts: null,
      last_warmup_ok: null
    };
  }
}

function writeProviderRecoveryState(state) {
  const fp = providerRecoveryStatePath();
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  fs.writeFileSync(fp, JSON.stringify(state || {}, null, 2));
}

function runProviderRecoveryWarmup() {
  if (String(process.env.SPINE_PROVIDER_RECOVERY_WARMUP_ENABLED || "1") === "0") {
    return {
      ok: true,
      skipped: true,
      reason: "feature_flag_disabled",
      flag: "SPINE_PROVIDER_RECOVERY_WARMUP_ENABLED",
      flag_value: String(process.env.SPINE_PROVIDER_RECOVERY_WARMUP_ENABLED || "")
    };
  }
  const maxProbesRaw = Number(process.env.SPINE_PROVIDER_RECOVERY_WARMUP_MAX_PROBES || 2);
  const maxProbes = Number.isFinite(maxProbesRaw) && maxProbesRaw > 0
    ? Math.max(1, Math.min(6, Math.round(maxProbesRaw)))
    : 2;
  const args = [
    "systems/routing/model_router.js",
    "warmup",
    "--force=1",
    `--max-probes=${maxProbes}`
  ];
  const rep = runJson("node", args);
  const payload = rep.payload && typeof rep.payload === "object" ? rep.payload : null;
  if (!rep.ok || !payload) {
    return {
      ok: false,
      skipped: false,
      reason: "warmup_failed",
      error: String(rep.stderr || rep.stdout || `warmup_exit_${rep.code}`).slice(0, 180)
    };
  }
  return {
    ok: true,
    skipped: false,
    reason: payload.reason || "warmup_ok",
    warmed_count: Number(payload.warmed_count || 0),
    candidate_count: Number(payload.candidate_count || 0),
    recovered_count: Number(payload.recovered_count || 0),
    local_health: payload.local_health || null
  };
}

function providerRecoveryTestOverride(kind) {
  const key = `SPINE_PROVIDER_RECOVERY_TEST_FORCE_${String(kind || "").trim().toUpperCase()}`;
  const raw = String(process.env[key] || "").trim().toLowerCase();
  if (!raw) return null;
  const forcedReason = String(process.env.SPINE_PROVIDER_RECOVERY_TEST_FORCE_REASON || "").trim().slice(0, 120);
  if (raw === "ok" || raw === "success" || raw === "pass") {
    if (String(kind || "").toUpperCase() === "PATH_PULSE") {
      return {
        ok: true,
        skipped: false,
        reason: forcedReason || "forced_test_ok",
        reflex: { ok: true, selected_model: "forced_test_model" },
        dream: { ok: true, idle_ok: true, rem_ok: true }
      };
    }
    return {
      ok: true,
      skipped: false,
      reason: forcedReason || "forced_test_ok",
      warmed_count: 1,
      candidate_count: 1,
      recovered_count: 1
    };
  }
  if (raw === "skip" || raw === "skipped") {
    return {
      ok: true,
      skipped: true,
      reason: forcedReason || "forced_test_skip"
    };
  }
  if (raw === "fail" || raw === "error") {
    if (String(kind || "").toUpperCase() === "PATH_PULSE") {
      return {
        ok: false,
        skipped: false,
        reason: forcedReason || "forced_test_fail",
        reflex: { ok: false, reason: "forced_test_fail" },
        dream: { ok: false, reason: "forced_test_fail" }
      };
    }
    return {
      ok: false,
      skipped: false,
      reason: forcedReason || "forced_test_fail",
      error: forcedReason || "forced_test_fail"
    };
  }
  return null;
}

function runProviderRecoveryPathPulse(dateStr) {
  if (String(process.env.SPINE_PROVIDER_RECOVERY_PATH_PULSE_ENABLED || "1") === "0") {
    return {
      ok: true,
      skipped: true,
      reason: "feature_flag_disabled",
      flag: "SPINE_PROVIDER_RECOVERY_PATH_PULSE_ENABLED",
      flag_value: String(process.env.SPINE_PROVIDER_RECOVERY_PATH_PULSE_ENABLED || "")
    };
  }
  const reflexTask = String(process.env.SPINE_PROVIDER_RECOVERY_REFLEX_TASK || "provider recovery route pulse").slice(0, 160);
  const reflexTokensRaw = Number(process.env.SPINE_PROVIDER_RECOVERY_REFLEX_TOKENS_EST || 80);
  const reflexTokens = Number.isFinite(reflexTokensRaw) && reflexTokensRaw > 0
    ? Math.max(50, Math.min(420, Math.round(reflexTokensRaw)))
    : 80;
  const reflex = runJson("node", [
    "systems/reflex/reflex_worker.js",
    "once",
    `--task=${reflexTask}`,
    "--intent=spine_provider_recovery",
    `--tokens_est=${reflexTokens}`,
    "--worker-id=spine-recovery"
  ]);
  const reflexPayload = reflex.payload && typeof reflex.payload === "object" ? reflex.payload : null;
  const reflexSummary = {
    ok: reflex.ok && !!reflexPayload,
    selected_model: reflexPayload && reflexPayload.route ? reflexPayload.route.selected_model || null : null,
    local_provider_forced_cloud_bias: reflexPayload ? reflexPayload.local_provider_forced_cloud_bias === true : null,
    reason: !reflex.ok ? String(reflex.stderr || reflex.stdout || `reflex_recovery_exit_${reflex.code}`).slice(0, 160) : null
  };

  const dreamRemStrategy = String(process.env.SPINE_PROVIDER_RECOVERY_DREAM_REM_STRATEGY || "local").trim() || "local";
  const dreamAttemptsRaw = Number(process.env.SPINE_PROVIDER_RECOVERY_DREAM_MODEL_MAX_ATTEMPTS || 1);
  const dreamAttempts = Number.isFinite(dreamAttemptsRaw) && dreamAttemptsRaw > 0
    ? Math.max(1, Math.min(2, Math.round(dreamAttemptsRaw)))
    : 1;
  const dreamModelsPerPassRaw = Number(process.env.SPINE_PROVIDER_RECOVERY_DREAM_MAX_MODELS_PER_PASS || 1);
  const dreamModelsPerPass = Number.isFinite(dreamModelsPerPassRaw) && dreamModelsPerPassRaw > 0
    ? Math.max(1, Math.min(2, Math.round(dreamModelsPerPassRaw)))
    : 1;
  const dreamIdlePassMaxMsRaw = Number(process.env.SPINE_PROVIDER_RECOVERY_DREAM_IDLE_PASS_MAX_MS || 45000);
  const dreamRemPassMaxMsRaw = Number(process.env.SPINE_PROVIDER_RECOVERY_DREAM_REM_PASS_MAX_MS || 45000);
  const dreamEnv = {
    ...process.env,
    IDLE_DREAM_REM_STRATEGY: dreamRemStrategy,
    IDLE_DREAM_MODEL_MAX_ATTEMPTS: String(dreamAttempts),
    IDLE_DREAM_MAX_MODELS_PER_PASS: String(dreamModelsPerPass),
    IDLE_DREAM_IDLE_PASS_MAX_MS: String(
      Number.isFinite(dreamIdlePassMaxMsRaw)
        ? Math.max(15000, Math.min(120000, Math.round(dreamIdlePassMaxMsRaw)))
        : 45000
    ),
    IDLE_DREAM_REM_PASS_MAX_MS: String(
      Number.isFinite(dreamRemPassMaxMsRaw)
        ? Math.max(15000, Math.min(120000, Math.round(dreamRemPassMaxMsRaw)))
        : 45000
    )
  };
  const dream = runJson("node", [
    "systems/memory/idle_dream_cycle.js",
    "run",
    String(dateStr || "").slice(0, 10),
    "--force=1"
  ], {
    env: dreamEnv
  });
  const dreamPayload = dream.payload && typeof dream.payload === "object" ? dream.payload : null;
  const dreamIdle = dreamPayload && dreamPayload.idle && typeof dreamPayload.idle === "object" ? dreamPayload.idle : null;
  const dreamRem = dreamPayload && dreamPayload.rem && typeof dreamPayload.rem === "object" ? dreamPayload.rem : null;
  const dreamSummary = {
    ok: dream.ok && !!dreamPayload && dreamPayload.ok === true,
    idle_ok: dreamIdle ? dreamIdle.ok === true : null,
    idle_skipped: dreamIdle ? dreamIdle.skipped === true : null,
    idle_reason: dreamIdle ? (dreamIdle.reason || dreamIdle.fallback_reason || null) : null,
    idle_model: dreamIdle ? (dreamIdle.model || dreamIdle.failed_model || null) : null,
    rem_ok: dreamRem ? dreamRem.ok === true : null,
    rem_skipped: dreamRem ? dreamRem.skipped === true : null,
    rem_reason: dreamRem ? (dreamRem.reason || dreamRem.fallback_reason || null) : null,
    rem_model: dreamRem ? (dreamRem.model || dreamRem.failed_model || null) : null,
    reason: !dream.ok ? String(dream.stderr || dream.stdout || `dream_recovery_exit_${dream.code}`).slice(0, 160) : null
  };

  const overallOk = reflexSummary.ok === true && dreamSummary.ok === true;
  return {
    ok: overallOk,
    skipped: false,
    reason: overallOk ? "path_pulse_ok" : "path_pulse_partial_or_failed",
    reflex: reflexSummary,
    dream: dreamSummary
  };
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
  ACTIVE_SPINE_CONTEXT = { mode, date: dateStr };
  const maxEyes = arg("max-eyes");
  let signalGateOk = null;
  let signalSloOk = null;
  let budgetHealth = null;
  let budgetGuard = null;

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
    "systems/security/startup_attestation.js",
    "habits/scripts/external_eyes.js",
    "habits/scripts/eyes_insight.js",
    "habits/scripts/sensory_queue.js",
    // daily-mode extras (only executed in daily, but declared here for guard)
    "habits/scripts/git_outcomes.js",
    "habits/scripts/dopamine_engine.js",
    "habits/scripts/sensory_digest.js",
    "systems/autonomy/autonomy_controller.js",
    "systems/autonomy/proposal_enricher.js",
    "systems/autonomy/pain_signal.js",
    "systems/autonomy/pain_adaptive_router.js",
    "systems/autonomy/adaptive_crystallizer.js",
    "systems/adaptive/reflex/reflex_runtime_sync.js",
    "systems/adaptive/habits/habit_runtime_sync.js",
    "systems/autonomy/strategy_readiness.js",
    "systems/autonomy/strategy_execute_guard.js",
    "systems/autonomy/strategy_mode_governor.js",
    "systems/autonomy/health_status.js",
    "systems/actuation/actuation_executor.js",
    "systems/actuation/bridge_from_proposals.js",
    "systems/ops/state_backup.js",
    "systems/ops/backup_integrity_check.js",
    "systems/ops/openclaw_backup_retention.js",
    "systems/memory/eyes_memory_bridge.js",
    "systems/memory/failure_memory_bridge.js",
    "systems/memory/idle_dream_cycle.js",
    "systems/memory/memory_dream.js",
    "systems/memory/uid_connections.js",
    "systems/memory/creative_links.js",
    "systems/sensory/cross_signal_engine.js",
    "systems/strategy/weekly_strategy_synthesis.js",
    "systems/autonomy/ops_dashboard.js",
    "config/actuation_adapters.json",
    "config/state_backup_policy.json",
    "skills/moltbook/actuation_adapter.js",
    "skills/moltbook/moltbook_publish_guard.js",
    "systems/routing/route_execute.js",
    "systems/routing/route_task.js",
    "systems/routing/model_router.js",
    "systems/routing/provider_readiness.js",
    "systems/routing/router_budget_calibration.js",
    "systems/budget/system_budget.js",
    "systems/reflex/reflex_worker.js",
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
      emitSpinePainSignal(
        mode,
        dateStr,
        "skill_install_enforcer_failed",
        "Skill install enforcer blocked spine run",
        String(skillInstallEnforcer.stderr || skillInstallEnforcer.stdout || "skill_install_enforcer_failed"),
        { signature_extra: String(enforcerPayload ? enforcerPayload.violation_count : "unknown") }
      );
      process.exit(skillInstallEnforcer.code || 1);
    }
    console.log(` skill_install_enforcer ok violations=${Number(enforcerPayload.violation_count || 0)}`);

    const llmGatewayGuard = runJson("node", ["systems/security/llm_gateway_guard.js", "run", "--strict"]);
    const llmGatewayPayload = llmGatewayGuard.payload && typeof llmGatewayGuard.payload === "object"
      ? llmGatewayGuard.payload
      : null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_llm_gateway_guard",
      mode,
      date: dateStr,
      ok: llmGatewayGuard.ok && !!llmGatewayPayload && llmGatewayPayload.ok === true,
      checked_files: llmGatewayPayload ? Number(llmGatewayPayload.checked_files || 0) : null,
      violation_count: llmGatewayPayload ? Number(llmGatewayPayload.violation_count || 0) : null,
      violation_counts: llmGatewayPayload ? llmGatewayPayload.violation_counts || {} : {},
      reason: (!llmGatewayGuard.ok || !llmGatewayPayload)
        ? String(llmGatewayGuard.stderr || llmGatewayGuard.stdout || `llm_gateway_guard_exit_${llmGatewayGuard.code}`).slice(0, 180)
        : null
    });
    if (!llmGatewayGuard.ok || !llmGatewayPayload || llmGatewayPayload.ok !== true) {
      console.error(` llm_gateway_guard FAIL violations=${llmGatewayPayload ? Number(llmGatewayPayload.violation_count || 0) : "unknown"}`);
      emitSpinePainSignal(
        mode,
        dateStr,
        "llm_gateway_guard_failed",
        "LLM gateway guard blocked spine run",
        String(llmGatewayGuard.stderr || llmGatewayGuard.stdout || "llm_gateway_guard_failed"),
        { signature_extra: String(llmGatewayPayload ? llmGatewayPayload.violation_count : "unknown") }
      );
      process.exit(llmGatewayGuard.code || 1);
    }
    console.log(
      ` llm_gateway_guard ok checked=${Number(llmGatewayPayload.checked_files || 0)}` +
      ` violations=${Number(llmGatewayPayload.violation_count || 0)}`
    );

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
        emitSpinePainSignal(
          mode,
          dateStr,
          "integrity_kernel_failed",
          "Integrity kernel blocked spine run",
          String(reason || "integrity_violation"),
          { signature_extra: String(reason || "integrity") }
        );
        process.exit(integrityKernel.code || 1);
      }
      console.log(` integrity_kernel WARN violations=${reason}`);
    } else {
      console.log(` integrity_kernel ok checked=${Number(integrityPayload.checked_present_files || 0)} expected=${Number(integrityPayload.expected_files || 0)}`);
    }
  }

  const providerPulse = providerRecoveryPulse();
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_provider_recovery_pulse",
    mode,
    date: dateStr,
    ...providerPulse
  });
  if (providerPulse.ok) {
    if (providerPulse.skipped) {
      console.log(` provider_recovery_pulse skipped reason=${String(providerPulse.reason || "unknown").slice(0, 120)}`);
    } else {
      console.log(
        ` provider_recovery_pulse provider=${String(providerPulse.provider || "ollama")}` +
        ` available=${providerPulse.available === true ? 1 : 0}` +
        ` reason=${String(providerPulse.reason || "unknown").slice(0, 120)}` +
        ` checked=${providerPulse.checked === true ? 1 : 0}`
      );
    }
  } else {
    console.log(` provider_recovery_pulse unavailable reason=${String(providerPulse.error || providerPulse.reason || "unknown").slice(0, 120)}`);
  }

  const providerRecoveryState = readProviderRecoveryState();
  const pulseHasAvailability = providerPulse && providerPulse.ok === true && providerPulse.skipped !== true && typeof providerPulse.available === "boolean";
  const providerRecovered = !!(
    pulseHasAvailability
    && providerPulse.available === true
    && providerRecoveryState.last_available === false
  );
  let recoveryWarmup = {
    ok: true,
    skipped: true,
    reason: providerRecovered ? "warmup_not_attempted" : "no_down_to_up_transition"
  };
  if (providerRecovered) {
    const warmupOverride = providerRecoveryTestOverride("WARMUP");
    recoveryWarmup = warmupOverride || runProviderRecoveryWarmup();
  }
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_provider_recovery_warmup",
    mode,
    date: dateStr,
    provider: providerPulse && providerPulse.provider ? providerPulse.provider : "ollama",
    provider_recovered: providerRecovered,
    ...recoveryWarmup
  });
  if (providerRecovered) {
    if (recoveryWarmup.ok) {
      if (recoveryWarmup.skipped) {
        console.log(` provider_recovery_warmup skipped reason=${String(recoveryWarmup.reason || "unknown").slice(0, 120)}`);
      } else {
        console.log(
          ` provider_recovery_warmup ok warmed=${Number(recoveryWarmup.warmed_count || 0)}` +
          ` recovered=${Number(recoveryWarmup.recovered_count || 0)}`
        );
      }
    } else {
      console.log(` provider_recovery_warmup fail reason=${String(recoveryWarmup.error || recoveryWarmup.reason || "unknown").slice(0, 120)}`);
    }
  }
  let recoveryPathPulse = {
    ok: true,
    skipped: true,
    reason: providerRecovered ? "warmup_not_ready" : "no_down_to_up_transition"
  };
  if (providerRecovered && recoveryWarmup.ok && recoveryWarmup.skipped !== true) {
    const pathOverride = providerRecoveryTestOverride("PATH_PULSE");
    recoveryPathPulse = pathOverride || runProviderRecoveryPathPulse(dateStr);
  }
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_provider_recovery_path_pulse",
    mode,
    date: dateStr,
    provider: providerPulse && providerPulse.provider ? providerPulse.provider : "ollama",
    provider_recovered: providerRecovered,
    warmup_ok: recoveryWarmup.ok === true,
    warmup_skipped: recoveryWarmup.skipped === true,
    ...recoveryPathPulse
  });
  if (providerRecovered) {
    if (recoveryPathPulse.ok) {
      if (recoveryPathPulse.skipped) {
        console.log(` provider_recovery_path_pulse skipped reason=${String(recoveryPathPulse.reason || "unknown").slice(0, 120)}`);
      } else {
        const reflexOk = recoveryPathPulse.reflex && recoveryPathPulse.reflex.ok === true ? 1 : 0;
        const dreamOk = recoveryPathPulse.dream && recoveryPathPulse.dream.ok === true ? 1 : 0;
        console.log(` provider_recovery_path_pulse ok reflex_ok=${reflexOk} dream_ok=${dreamOk}`);
      }
    } else {
      console.log(` provider_recovery_path_pulse fail reason=${String(recoveryPathPulse.reason || "unknown").slice(0, 120)}`);
    }
  }
  if (
    providerRecovered
    && recoveryPathPulse
    && recoveryPathPulse.ok !== true
    && !(recoveryPathPulse.skipped === true && String(recoveryPathPulse.reason || "") === "feature_flag_disabled")
  ) {
    const providerName = String(providerPulse && providerPulse.provider ? providerPulse.provider : "ollama");
    const reflexOk = recoveryPathPulse && recoveryPathPulse.reflex && recoveryPathPulse.reflex.ok === true ? 1 : 0;
    const dreamOk = recoveryPathPulse && recoveryPathPulse.dream && recoveryPathPulse.dream.ok === true ? 1 : 0;
    emitSpinePainSignal(
      mode,
      dateStr,
      "provider_recovery_path_pulse_failed",
      "Provider recovered but post-recovery path pulse failed",
      `provider=${providerName} pulse_reason=${String(recoveryPathPulse.reason || "unknown").slice(0, 120)} reflex_ok=${reflexOk} dream_ok=${dreamOk} warmup_ok=${recoveryWarmup.ok === true ? 1 : 0}`,
      { signature_extra: `provider_recovery_path_pulse:${providerName}` }
    );
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_provider_recovery_alert",
      mode,
      date: dateStr,
      severity: "warning",
      alert: "provider_recovery_path_pulse_failed",
      provider: providerName,
      reason: String(recoveryPathPulse.reason || "unknown").slice(0, 120),
      reflex_ok: reflexOk === 1,
      dream_ok: dreamOk === 1,
      warmup_ok: recoveryWarmup.ok === true
    });
  }
  const nextAvailability = pulseHasAvailability
    ? providerPulse.available === true
    : providerRecoveryState.last_available;
  writeProviderRecoveryState({
    ts: nowIso(),
    last_provider: providerPulse && providerPulse.provider ? String(providerPulse.provider) : String(providerRecoveryState.last_provider || "ollama"),
    last_available: typeof nextAvailability === "boolean" ? nextAvailability : null,
    last_reason: providerPulse && providerPulse.reason ? String(providerPulse.reason) : (providerRecoveryState.last_reason || null),
    last_transition_ts: providerRecovered ? nowIso() : (providerRecoveryState.last_transition_ts || null),
    last_warmup_ts: providerRecovered ? nowIso() : (providerRecoveryState.last_warmup_ts || null),
    last_warmup_ok: providerRecovered ? (recoveryWarmup.ok === true) : providerRecoveryState.last_warmup_ok
  });

  let routingCache;
  const skipRoutingCacheOnProviderDown = String(process.env.SPINE_ROUTING_CACHE_SKIP_ON_PROVIDER_DOWN || "1") !== "0";
  if (
    skipRoutingCacheOnProviderDown
    && providerPulse
    && providerPulse.ok === true
    && providerPulse.skipped !== true
    && providerPulse.available === false
  ) {
    routingCache = {
      ok: false,
      reason: `provider_down:${String(providerPulse.reason || "provider_unavailable").slice(0, 80)}`,
      source: "provider_recovery_pulse"
    };
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_router_cache_summary_skipped",
      mode,
      date: dateStr,
      reason: "provider_down_from_startup_pulse",
      provider: providerPulse.provider || "ollama",
      provider_reason: providerPulse.reason || null,
      flag: "SPINE_ROUTING_CACHE_SKIP_ON_PROVIDER_DOWN",
      flag_value: String(process.env.SPINE_ROUTING_CACHE_SKIP_ON_PROVIDER_DOWN || "")
    });
    console.log(
      ` routing_cache_summary skipped reason=provider_down` +
      ` provider=${String(providerPulse.provider || "ollama")}` +
      ` detail=${String(providerPulse.reason || "provider_unavailable").slice(0, 120)}`
    );
  } else {
    routingCache = routingCacheSummary();
  }

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

  const painAdaptiveRouter = runJson("node", ["systems/autonomy/pain_adaptive_router.js", "run", dateStr]);
  const painAdaptivePayload = painAdaptiveRouter.payload && typeof painAdaptiveRouter.payload === "object"
    ? painAdaptiveRouter.payload
    : null;
  const painAdaptiveRouted = painAdaptivePayload ? Number(painAdaptivePayload.routed || 0) : 0;
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_pain_adaptive_router",
    mode,
    date: dateStr,
    ok: painAdaptiveRouter.ok && !!painAdaptivePayload && painAdaptivePayload.ok === true,
    scanned: painAdaptivePayload ? Number(painAdaptivePayload.scanned || 0) : null,
    routed: painAdaptivePayload ? Number(painAdaptivePayload.routed || 0) : null,
    routed_reflex: painAdaptivePayload ? Number(painAdaptivePayload.routed_reflex || 0) : null,
    routed_habit: painAdaptivePayload ? Number(painAdaptivePayload.routed_habit || 0) : null,
    skipped: painAdaptivePayload ? Number(painAdaptivePayload.skipped || 0) : null,
    reason: (!painAdaptiveRouter.ok || !painAdaptivePayload)
      ? String(painAdaptiveRouter.stderr || painAdaptiveRouter.stdout || `pain_adaptive_router_exit_${painAdaptiveRouter.code}`).slice(0, 180)
      : null
  });
  if (painAdaptiveRouter.ok && painAdaptivePayload && painAdaptivePayload.ok === true) {
    console.log(
      ` pain_adaptive_router routed=${Number(painAdaptivePayload.routed || 0)}` +
      ` reflex=${Number(painAdaptivePayload.routed_reflex || 0)}` +
      ` habit=${Number(painAdaptivePayload.routed_habit || 0)}`
    );
  } else {
    console.log(` pain_adaptive_router unavailable reason=${String(painAdaptiveRouter.stderr || painAdaptiveRouter.stdout || "unknown").slice(0, 120)}`);
  }

  const reflexRuntimeSync = runJson("node", ["systems/adaptive/reflex/reflex_runtime_sync.js", "run"]);
  const reflexRuntimePayload = reflexRuntimeSync.payload && typeof reflexRuntimeSync.payload === "object"
    ? reflexRuntimeSync.payload
    : null;
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_reflex_runtime_sync",
    mode,
    date: dateStr,
    ok: reflexRuntimeSync.ok && !!reflexRuntimePayload && reflexRuntimePayload.ok === true,
    changed: reflexRuntimePayload ? reflexRuntimePayload.changed === true : null,
    created: reflexRuntimePayload ? Number(reflexRuntimePayload.created || 0) : null,
    updated: reflexRuntimePayload ? Number(reflexRuntimePayload.updated || 0) : null,
    disabled: reflexRuntimePayload ? Number(reflexRuntimePayload.disabled || 0) : null,
    managed_routines: reflexRuntimePayload ? Number(reflexRuntimePayload.managed_routines || 0) : null,
    reason: (!reflexRuntimeSync.ok || !reflexRuntimePayload)
      ? String(reflexRuntimeSync.stderr || reflexRuntimeSync.stdout || `reflex_runtime_sync_exit_${reflexRuntimeSync.code}`).slice(0, 180)
      : null
  });
  if (reflexRuntimeSync.ok && reflexRuntimePayload && reflexRuntimePayload.ok === true) {
    console.log(
      ` reflex_runtime_sync changed=${reflexRuntimePayload.changed === true ? 1 : 0}` +
      ` created=${Number(reflexRuntimePayload.created || 0)}` +
      ` updated=${Number(reflexRuntimePayload.updated || 0)}`
    );
  } else {
    console.log(` reflex_runtime_sync unavailable reason=${String(reflexRuntimeSync.stderr || reflexRuntimeSync.stdout || "unknown").slice(0, 120)}`);
    emitSpinePainSignal(
      mode,
      dateStr,
      "reflex_runtime_sync_failed",
      "Adaptive reflex runtime sync failed during spine run",
      String(reflexRuntimeSync.stderr || reflexRuntimeSync.stdout || "reflex_runtime_sync_failed"),
      { severity: "medium", risk: "medium" }
    );
  }

  const habitRuntimeSync = runJson("node", ["systems/adaptive/habits/habit_runtime_sync.js", "run"]);
  const habitRuntimePayload = habitRuntimeSync.payload && typeof habitRuntimeSync.payload === "object"
    ? habitRuntimeSync.payload
    : null;
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_habit_runtime_sync",
    mode,
    date: dateStr,
    ok: habitRuntimeSync.ok && !!habitRuntimePayload && habitRuntimePayload.ok === true,
    changed: habitRuntimePayload ? habitRuntimePayload.changed === true : null,
    created: habitRuntimePayload ? Number(habitRuntimePayload.created || 0) : null,
    updated: habitRuntimePayload ? Number(habitRuntimePayload.updated || 0) : null,
    disabled: habitRuntimePayload ? Number(habitRuntimePayload.disabled || 0) : null,
    managed_habits: habitRuntimePayload ? Number(habitRuntimePayload.managed_habits || 0) : null,
    reason: (!habitRuntimeSync.ok || !habitRuntimePayload)
      ? String(habitRuntimeSync.stderr || habitRuntimeSync.stdout || `habit_runtime_sync_exit_${habitRuntimeSync.code}`).slice(0, 180)
      : null
  });
  if (habitRuntimeSync.ok && habitRuntimePayload && habitRuntimePayload.ok === true) {
    console.log(
      ` habit_runtime_sync changed=${habitRuntimePayload.changed === true ? 1 : 0}` +
      ` created=${Number(habitRuntimePayload.created || 0)}` +
      ` updated=${Number(habitRuntimePayload.updated || 0)}`
    );
  } else {
    console.log(` habit_runtime_sync unavailable reason=${String(habitRuntimeSync.stderr || habitRuntimeSync.stdout || "unknown").slice(0, 120)}`);
    emitSpinePainSignal(
      mode,
      dateStr,
      "habit_runtime_sync_failed",
      "Adaptive habit runtime sync failed during spine run",
      String(habitRuntimeSync.stderr || habitRuntimeSync.stdout || "habit_runtime_sync_failed"),
      { severity: "medium", risk: "medium" }
    );
  }

  const adaptiveCrystallizer = runJson("node", ["systems/autonomy/adaptive_crystallizer.js", "run", dateStr]);
  const adaptiveCrystallizerPayload = adaptiveCrystallizer.payload && typeof adaptiveCrystallizer.payload === "object"
    ? adaptiveCrystallizer.payload
    : null;
  const adaptiveCrystallizerEmitted = adaptiveCrystallizerPayload
    ? Number(adaptiveCrystallizerPayload.emitted || 0)
    : 0;
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_adaptive_crystallizer",
    mode,
    date: dateStr,
    ok: adaptiveCrystallizer.ok && !!adaptiveCrystallizerPayload && adaptiveCrystallizerPayload.ok === true,
    considered: adaptiveCrystallizerPayload ? Number(adaptiveCrystallizerPayload.considered || 0) : null,
    emitted: adaptiveCrystallizerPayload ? Number(adaptiveCrystallizerPayload.emitted || 0) : null,
    emitted_habit: adaptiveCrystallizerPayload ? Number(adaptiveCrystallizerPayload.emitted_habit || 0) : null,
    emitted_reflex: adaptiveCrystallizerPayload ? Number(adaptiveCrystallizerPayload.emitted_reflex || 0) : null,
    skipped: adaptiveCrystallizerPayload ? Number(adaptiveCrystallizerPayload.skipped || 0) : null,
    reason: (!adaptiveCrystallizer.ok || !adaptiveCrystallizerPayload)
      ? String(adaptiveCrystallizer.stderr || adaptiveCrystallizer.stdout || `adaptive_crystallizer_exit_${adaptiveCrystallizer.code}`).slice(0, 180)
      : null
  });
  if (adaptiveCrystallizer.ok && adaptiveCrystallizerPayload && adaptiveCrystallizerPayload.ok === true) {
    console.log(
      ` adaptive_crystallizer emitted=${Number(adaptiveCrystallizerPayload.emitted || 0)}` +
      ` habit=${Number(adaptiveCrystallizerPayload.emitted_habit || 0)}` +
      ` reflex=${Number(adaptiveCrystallizerPayload.emitted_reflex || 0)}`
    );
  } else {
    console.log(` adaptive_crystallizer unavailable reason=${String(adaptiveCrystallizer.stderr || adaptiveCrystallizer.stdout || "unknown").slice(0, 120)}`);
  }

  const realItems = realExternalItemsToday(dateStr);
  signalGateOk = realItems > 0;
  const proposalPipelineAllowed = signalGateOk || painAdaptiveRouted > 0 || adaptiveCrystallizerEmitted > 0;
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_signal_gate",
    mode,
    date: dateStr,
    ok: signalGateOk,
    real_external_items: realItems,
    threshold: 1,
    pain_adaptive_routed: painAdaptiveRouted,
    adaptive_crystallizer_emitted: adaptiveCrystallizerEmitted,
    proposal_pipeline_allowed: proposalPipelineAllowed
  });
  const failureMemoryBridge = runJson("node", ["systems/memory/failure_memory_bridge.js", "run", dateStr]);
  const failureBridgePayload = failureMemoryBridge.payload && typeof failureMemoryBridge.payload === "object"
    ? failureMemoryBridge.payload
    : null;
  appendLedger(dateStr, {
    ts: nowIso(),
    type: "spine_failure_memory_bridge",
    mode,
    date: dateStr,
    ok: failureMemoryBridge.ok && !!failureBridgePayload && failureBridgePayload.ok === true,
    candidates: failureBridgePayload ? Number(failureBridgePayload.candidates || 0) : null,
    selected: failureBridgePayload ? Number(failureBridgePayload.selected || 0) : null,
    created_nodes: failureBridgePayload ? Number(failureBridgePayload.created_nodes || 0) : null,
    revisit_pointers: failureBridgePayload ? Number(failureBridgePayload.revisit_pointers || 0) : null,
    pointers_file: failureBridgePayload ? failureBridgePayload.pointers_file || null : null,
    reason: (!failureMemoryBridge.ok || !failureBridgePayload || failureBridgePayload.ok !== true)
      ? String(failureMemoryBridge.stderr || failureMemoryBridge.stdout || `failure_memory_bridge_exit_${failureMemoryBridge.code}`).slice(0, 180)
      : null
  });
  if (!failureMemoryBridge.ok || !failureBridgePayload || failureBridgePayload.ok !== true) {
    console.error(` failure_memory_bridge FAIL code=${failureMemoryBridge.code} reason=${String(failureMemoryBridge.stderr || failureMemoryBridge.stdout || "unknown").slice(0, 140)}`);
    emitSpinePainSignal(
      mode,
      dateStr,
      "failure_memory_bridge_failed",
      "Failure memory bridge failed during spine run",
      String(failureMemoryBridge.stderr || failureMemoryBridge.stdout || "failure_memory_bridge_failed"),
      { signature_extra: String(failureMemoryBridge.code || 1) }
    );
    process.exit(failureMemoryBridge.code || 1);
  }
  console.log(
    ` failure_memory_bridge selected=${Number(failureBridgePayload.selected || 0)}` +
    ` created=${Number(failureBridgePayload.created_nodes || 0)}` +
    ` revisit=${Number(failureBridgePayload.revisit_pointers || 0)}`
  );
  if (proposalPipelineAllowed) {
    if (signalGateOk) {
      run("node", ["habits/scripts/eyes_insight.js", "run", dateStr]);
    } else if (painAdaptiveRouted > 0) {
      console.log(` signal_gate SOFT_BYPASS reason=pain_adaptive_routed count=${painAdaptiveRouted}`);
    } else {
      console.log(` signal_gate SOFT_BYPASS reason=adaptive_crystallizer_emitted count=${adaptiveCrystallizerEmitted}`);
    }
    run("node", ["habits/scripts/sensory_queue.js", "ingest", dateStr]);
    run("node", ["systems/actuation/bridge_from_proposals.js", "run", dateStr]);
    const enrich = runJson("node", ["systems/autonomy/proposal_enricher.js", "run", dateStr]);
    const enrichPayload = enrich.payload && typeof enrich.payload === "object" ? enrich.payload : null;
    if (!enrich.ok || !enrichPayload || enrichPayload.ok !== true) {
      console.error(` proposal_enricher FAIL code=${enrich.code} reason=${String(enrich.stderr || enrich.stdout || "unknown").slice(0, 140)}`);
      emitSpinePainSignal(
        mode,
        dateStr,
        "proposal_enricher_failed",
        "Proposal enricher failed during spine run",
        String(enrich.stderr || enrich.stdout || "proposal_enricher_failed"),
        { signature_extra: String(enrich.code || 1) }
      );
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
      emitSpinePainSignal(
        mode,
        dateStr,
        "eyes_memory_bridge_failed",
        "Eyes memory bridge failed during spine run",
        String(eyesMemoryBridge.stderr || eyesMemoryBridge.stdout || "eyes_memory_bridge_failed"),
        { signature_extra: String(eyesMemoryBridge.code || 1) }
      );
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
    const objectiveBinding = enrichPayload.objective_binding && typeof enrichPayload.objective_binding === "object"
      ? enrichPayload.objective_binding
      : {
          total: 0,
          required: 0,
          valid_required: 0,
          missing_required: 0,
          invalid_required: 0,
          source_meta_required: 0,
          source_fallback_required: 0,
          source_counts: {}
        };
    const topBlockedReason = Object.entries(admission.blocked_by_reason || {})
      .sort((a, b) => Number(b[1] || 0) - Number(a[1] || 0))[0] || null;
    const topBindingSource = Object.entries(objectiveBinding.source_counts || {})
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
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_objective_binding",
      mode,
      date: dateStr,
      required: Number(objectiveBinding.required || 0),
      valid_required: Number(objectiveBinding.valid_required || 0),
      missing_required: Number(objectiveBinding.missing_required || 0),
      invalid_required: Number(objectiveBinding.invalid_required || 0),
      source_meta_required: Number(objectiveBinding.source_meta_required || 0),
      source_fallback_required: Number(objectiveBinding.source_fallback_required || 0),
      top_source: topBindingSource ? { source: topBindingSource[0], count: Number(topBindingSource[1] || 0) } : null,
      ok: Number(objectiveBinding.missing_required || 0) === 0 && Number(objectiveBinding.invalid_required || 0) === 0
    });
    const topBlockedMsg = topBlockedReason ? ` top_blocked=${topBlockedReason[0]}:${Number(topBlockedReason[1] || 0)}` : "";
    console.log(` proposal_admission eligible=${Number(admission.eligible || 0)}/${Number(admission.total || 0)} blocked=${Number(admission.blocked || 0)}${topBlockedMsg}`);
    const requiredBindings = Number(objectiveBinding.required || 0);
    const fallbackBindings = Number(objectiveBinding.source_fallback_required || 0);
    const topSourceMsg = topBindingSource ? ` top_source=${topBindingSource[0]}:${Number(topBindingSource[1] || 0)}` : "";
    console.log(
      ` objective_binding valid=${Number(objectiveBinding.valid_required || 0)}/${requiredBindings}` +
      ` missing=${Number(objectiveBinding.missing_required || 0)}` +
      ` invalid=${Number(objectiveBinding.invalid_required || 0)}` +
      ` fallback=${fallbackBindings}${topSourceMsg}`
    );
    if (
      String(process.env.SPINE_OBJECTIVE_BINDING_REQUIRE_META_SOURCE || "0") === "1"
      && requiredBindings > 0
      && fallbackBindings > 0
    ) {
      console.error(
        ` objective_binding FAIL reason=fallback_source_present required=${requiredBindings} fallback=${fallbackBindings}`
      );
      emitSpinePainSignal(
        mode,
        dateStr,
        "objective_binding_fallback_source_present",
        "Objective binding meta-source requirement failed",
        `required=${requiredBindings} fallback=${fallbackBindings}`,
        { severity: "medium", risk: "medium", signature_extra: `${requiredBindings}:${fallbackBindings}` }
      );
      process.exit(1);
    }
  } else {
    console.log(" signal_gate SKIP reason=no_real_external_items_and_no_pain_routes");
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
    // Sweep removes stale/filtered-noise rows so autonomy scoring stays focused.
    run("node", ["habits/scripts/sensory_queue.js", "sweep", dateStr]);
    // Compact queue log churn so repeated terminal events do not bloat queue state.
    const queueCompact = runJson("node", ["systems/ops/queue_log_compact.js", "run", "--apply=1"]);
    const compactPayload = (queueCompact.payload && typeof queueCompact.payload === "object") ? queueCompact.payload : null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_queue_compaction",
      mode,
      date: dateStr,
      ok: queueCompact.ok,
      action: compactPayload ? compactPayload.action : null,
      removed_lines: compactPayload ? Number(compactPayload.removed_lines || 0) : 0,
      skip_reason: compactPayload ? compactPayload.skip_reason || null : null,
      exit_code: Number(queueCompact.code || 0)
    });
    if (!queueCompact.ok) {
      console.log(` queue_compaction WARN exit=${Number(queueCompact.code || 1)}`);
    }

    if (String(process.env.SPINE_QUEUE_HYGIENE_SUMMARY_ENABLED || "1") !== "0") {
      const hygieneDays = Math.max(2, Number(process.env.SPINE_QUEUE_HYGIENE_SUMMARY_DAYS || 7) || 7);
      const hygieneIntervalDays = Math.max(1, Number(process.env.SPINE_QUEUE_HYGIENE_SUMMARY_INTERVAL_DAYS || 7) || 7);
      const hygieneStaleOpenHours = Math.max(1, Number(process.env.SPINE_QUEUE_HYGIENE_STALE_OPEN_HOURS || 96) || 96);
      const hygiene = runJson("node", [
        "systems/ops/queue_hygiene_summary.js",
        "run",
        dateStr,
        `--days=${hygieneDays}`,
        `--interval-days=${hygieneIntervalDays}`,
        `--stale-open-hours=${hygieneStaleOpenHours}`
      ]);
      const hygienePayload = hygiene.payload && typeof hygiene.payload === "object" ? hygiene.payload : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_queue_hygiene_summary",
        mode,
        date: dateStr,
        ok: hygiene.ok && !!hygienePayload && hygienePayload.ok === true,
        result: hygienePayload ? String(hygienePayload.result || "") : null,
        output_file: hygienePayload ? hygienePayload.output_file || null : null,
        totals: hygienePayload && hygienePayload.totals && typeof hygienePayload.totals === "object"
          ? hygienePayload.totals
          : null,
        reason: (!hygiene.ok || !hygienePayload || hygienePayload.ok !== true)
          ? String(hygiene.stderr || hygiene.stdout || `queue_hygiene_summary_exit_${hygiene.code}`).slice(0, 180)
          : null
      });
      if (hygiene.ok && hygienePayload && hygienePayload.ok === true) {
        const result = String(hygienePayload.result || "");
        if (result === "skip_recent_run") {
          console.log(` queue_hygiene_summary skipped age_hours=${Number(hygienePayload.age_hours || 0).toFixed(2)} interval_days=${Number(hygienePayload.interval_days || hygieneIntervalDays)}`);
        } else {
          console.log(` queue_hygiene_summary ok output=${String(hygienePayload.output_file || "n/a")}`);
        }
      } else {
        console.log(` queue_hygiene_summary WARN reason=${String(hygiene.stderr || hygiene.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_queue_hygiene_summary_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_QUEUE_HYGIENE_SUMMARY_ENABLED",
        flag_value: String(process.env.SPINE_QUEUE_HYGIENE_SUMMARY_ENABLED || "")
      });
      console.log(" queue_hygiene_summary skipped reason=feature_flag_disabled flag=SPINE_QUEUE_HYGIENE_SUMMARY_ENABLED");
    }
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
    if (String(process.env.SPINE_BUDGET_GUARD_ENABLED || "1") !== "0") {
      if (!budgetHealth) budgetHealth = budgetHealthSummary(dateStr);
      budgetGuard = evaluateBudgetGuard(dateStr, budgetHealth);
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_budget_guard",
        mode,
        date: dateStr,
        ok: budgetGuard.ok === true,
        action: budgetGuard.action || "allow",
        reason: budgetGuard.reason || null,
        pressure: budgetGuard.pressure || null,
        projected_pressure: budgetGuard.projected_pressure || null,
        hard_repeat_threshold: Number(budgetGuard.hard_repeat_threshold || 0),
        hard_pause_minutes: Number(budgetGuard.hard_pause_minutes || 0),
        soft_throttle_every_runs: Number(budgetGuard.soft_throttle_every_runs || 0),
        consecutive_hard: Number(budgetGuard.consecutive_hard || 0),
        soft_run_counter: Number(budgetGuard.soft_run_counter || 0),
        paused_until: budgetGuard.paused_until || null,
        suggestion_written: budgetGuard.suggestion_written === true,
        suggestion_path: budgetGuard.suggestion_path || null
      });
      console.log(
        ` budget_guard action=${budgetGuard.action || "allow"}` +
        ` reason=${budgetGuard.reason || "none"}` +
        ` pressure=${budgetGuard.pressure || "none"}` +
        ` projected=${budgetGuard.projected_pressure || "none"}`
      );
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_budget_guard_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_BUDGET_GUARD_ENABLED",
        flag_value: String(process.env.SPINE_BUDGET_GUARD_ENABLED || "")
      });
      console.log(" budget_guard skipped reason=feature_flag_disabled flag=SPINE_BUDGET_GUARD_ENABLED");
    }

    let startupAttestation = { checked: false, ok: true, required: false, reason: null };
    if (String(process.env.SPINE_STARTUP_ATTESTATION_ENABLED || "1") !== "0") {
      const verifyArgs = ["systems/security/startup_attestation.js", "verify"];
      const strictVerify = String(process.env.SPINE_STARTUP_ATTESTATION_STRICT || "0") === "1";
      const autoIssueEnabled = String(process.env.SPINE_STARTUP_ATTESTATION_AUTO_ISSUE || "1") !== "0";
      const autoIssueReasons = new Set([
        "attestation_missing_or_invalid",
        "attestation_stale",
        "critical_hash_drift"
      ]);
      if (strictVerify) verifyArgs.push("--strict");
      let att = runJson("node", verifyArgs);
      let attPayload = att.payload && typeof att.payload === "object" ? att.payload : null;
      const keyMissingReasons = new Set(["attestation_key_missing"]);
      let keyAvailable = true;
      let keyWarningReason = null;
      startupAttestation = {
        checked: true,
        ok: att.ok && !!attPayload && attPayload.ok === true,
        required: String(process.env.SPINE_STARTUP_ATTESTATION_REQUIRED || "0") === "1",
        reason: (!att.ok || !attPayload || attPayload.ok !== true)
          ? String((attPayload && attPayload.reason) || att.stderr || att.stdout || `startup_attestation_exit_${att.code}`).slice(0, 180)
          : null
      };
      if (!startupAttestation.ok) {
        const normalizedInitialReason = String(startupAttestation.reason || "").trim().toLowerCase();
        if (keyMissingReasons.has(normalizedInitialReason)) {
          keyAvailable = false;
          keyWarningReason = normalizedInitialReason;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_startup_attestation_key_warning",
            mode,
            date: dateStr,
            reason: normalizedInitialReason
          });
          console.log(` startup_attestation key_warning reason=${normalizedInitialReason}`);
        }
      }
      const reasonBeforeIssue = startupAttestation.reason;
      let autoIssueAttempted = false;
      let autoIssueOk = false;
      if (startupAttestation.ok !== true && autoIssueEnabled) {
        const normalizedReason = String(startupAttestation.reason || "").trim().toLowerCase();
        if (autoIssueReasons.has(normalizedReason)) {
          autoIssueAttempted = true;
          const issueArgs = ["systems/security/startup_attestation.js", "issue"];
          const ttlRaw = Number(process.env.SPINE_STARTUP_ATTESTATION_TTL_HOURS || "");
          if (Number.isFinite(ttlRaw) && ttlRaw > 0) issueArgs.push(`--ttl-hours=${Math.min(ttlRaw, 240)}`);
          const issue = runJson("node", issueArgs);
          const issuePayload = issue.payload && typeof issue.payload === "object" ? issue.payload : null;
          autoIssueOk = issue.ok && !!issuePayload && issuePayload.ok === true;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_startup_attestation_issue",
            mode,
            date: dateStr,
            ok: autoIssueOk,
            reason: autoIssueOk
              ? "issued"
              : String((issuePayload && issuePayload.reason) || issue.stderr || issue.stdout || `startup_attestation_issue_exit_${issue.code}`).slice(0, 180)
          });
          if (autoIssueOk) {
            att = runJson("node", verifyArgs);
            attPayload = att.payload && typeof att.payload === "object" ? att.payload : null;
            startupAttestation = {
              checked: true,
              ok: att.ok && !!attPayload && attPayload.ok === true,
              required: String(process.env.SPINE_STARTUP_ATTESTATION_REQUIRED || "0") === "1",
              reason: (!att.ok || !attPayload || attPayload.ok !== true)
                ? String((attPayload && attPayload.reason) || att.stderr || att.stdout || `startup_attestation_exit_${att.code}`).slice(0, 180)
                : null
            };
            if (startupAttestation.ok === true) {
              keyAvailable = true;
              keyWarningReason = null;
            } else {
              const normalizedRetryReason = String(startupAttestation.reason || "").trim().toLowerCase();
              if (keyMissingReasons.has(normalizedRetryReason)) {
                keyAvailable = false;
                keyWarningReason = normalizedRetryReason;
              }
            }
          }
        }
      }
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_startup_attestation",
        mode,
        date: dateStr,
        ok: startupAttestation.ok,
        required: startupAttestation.required,
        reason: startupAttestation.reason,
        key_available: keyAvailable === true,
        key_warning_reason: keyWarningReason,
        auto_issue_attempted: autoIssueAttempted,
        auto_issue_ok: autoIssueAttempted ? autoIssueOk : null,
        reason_before_issue: autoIssueAttempted ? reasonBeforeIssue : null
      });
      if (startupAttestation.ok) {
        if (autoIssueAttempted && autoIssueOk) {
          console.log(` startup_attestation ok (auto-issued from ${String(reasonBeforeIssue || "unknown").slice(0, 120)})`);
        } else {
          console.log(" startup_attestation ok");
        }
      } else {
        console.log(` startup_attestation unavailable reason=${String(startupAttestation.reason || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_startup_attestation_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_STARTUP_ATTESTATION_ENABLED",
        flag_value: String(process.env.SPINE_STARTUP_ATTESTATION_ENABLED || "")
      });
      console.log(" startup_attestation skipped reason=feature_flag_disabled flag=SPINE_STARTUP_ATTESTATION_ENABLED");
    }

    const autonomyEnabledFlag = String(process.env.AUTONOMY_ENABLED || "") === "1";
    const canaryAllowWithFlagOff = String(process.env.AUTONOMY_CANARY_ALLOW_WITH_FLAG_OFF || "1") !== "0";
    const autonomySchedulerEnabled = autonomyEnabledFlag || canaryAllowWithFlagOff;
    const budgetGuardBlocksAutonomy = !!(budgetGuard && (budgetGuard.action === "throttle" || budgetGuard.action === "pause"));
    const startupAttestationBlocksAutonomy = startupAttestation.required === true && startupAttestation.ok !== true;
    if (autonomySchedulerEnabled && startupAttestationBlocksAutonomy) {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_autonomy_skipped",
        mode,
        date: dateStr,
        reason: "startup_attestation_blocked",
        startup_attestation_reason: startupAttestation.reason || null
      });
      console.log(` autonomy_skipped reason=startup_attestation_blocked detail=${String(startupAttestation.reason || "unknown").slice(0, 120)}`);
    } else if (autonomySchedulerEnabled && budgetGuardBlocksAutonomy) {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_autonomy_skipped",
        mode,
        date: dateStr,
        reason: `budget_guard_${String(budgetGuard.action || "unknown")}`,
        budget_guard_action: budgetGuard.action || null,
        budget_guard_reason: budgetGuard.reason || null,
        budget_pressure: budgetGuard.pressure || null,
        budget_projected_pressure: budgetGuard.projected_pressure || null,
        paused_until: budgetGuard.paused_until || null
      });
      console.log(
        ` autonomy_skipped reason=budget_guard_${String(budgetGuard.action || "unknown")}` +
        ` pressure=${String(budgetGuard.pressure || "none")}` +
        ` projected=${String(budgetGuard.projected_pressure || "none")}` +
        ` until=${String(budgetGuard.paused_until || "n/a")}`
      );
    } else if (autonomySchedulerEnabled) {
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
        flag_value: String(process.env.AUTONOMY_ENABLED || ""),
        canary_allow_with_flag_off: canaryAllowWithFlagOff
      });
      console.log(" autonomy_skipped reason=feature_flag_disabled flag=AUTONOMY_ENABLED");

      // Shadow evidence loop: dry-run/preflight verification receipts only (no execution side effects).
      // Default 2 attempts/day to build readiness signal while execution is disabled.
      const evidenceRunsRaw = Number(process.env.AUTONOMY_EVIDENCE_RUNS || 2);
      const evidencePlan = computeEvidenceRunPlan(
        evidenceRunsRaw,
        budgetGuard && budgetGuard.pressure,
        budgetGuard && budgetGuard.projected_pressure
      );
      const evidenceRunsConfigured = Number(evidencePlan.configured_runs || 0);
      const budgetPressure = String(evidencePlan.budget_pressure || 'none');
      const projectedPressure = String(evidencePlan.projected_pressure || 'none');
      const pressureThrottle = evidencePlan.pressure_throttle === true;
      const evidenceRuns = Number(evidencePlan.evidence_runs || 0);
      let evidenceOkCount = 0;
      if (evidenceRuns <= 0) {
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_autonomy_evidence_skipped",
          mode,
          date: dateStr,
          reason: pressureThrottle ? "budget_pressure_throttle" : "feature_flag_disabled",
          flag: "AUTONOMY_EVIDENCE_RUNS",
          flag_value: String(process.env.AUTONOMY_EVIDENCE_RUNS || ""),
          budget_pressure: budgetPressure || null,
          projected_pressure: projectedPressure || null
        });
        if (pressureThrottle) {
          console.log(
            ` autonomy_evidence skipped reason=budget_pressure_throttle` +
            ` pressure=${budgetPressure || "none"} projected=${projectedPressure || "none"}`
          );
        } else {
          console.log(" autonomy_evidence skipped reason=feature_flag_disabled flag=AUTONOMY_EVIDENCE_RUNS");
        }
      } else {
        if (pressureThrottle && evidenceRuns < evidenceRunsConfigured) {
          console.log(
            ` autonomy_evidence throttled runs=${evidenceRuns}/${evidenceRunsConfigured}` +
            ` pressure=${budgetPressure || "none"} projected=${projectedPressure || "none"}`
          );
        }
        const evidenceTypeCapRaw = Number(process.env.SPINE_AUTONOMY_EVIDENCE_MAX_PER_TYPE || 1);
        const evidenceTypeCap = Number.isFinite(evidenceTypeCapRaw)
          ? Math.max(0, Math.min(6, Math.floor(evidenceTypeCapRaw)))
          : 1;
        const extraAttemptsRaw = Number(process.env.SPINE_AUTONOMY_EVIDENCE_EXTRA_ATTEMPTS || (evidenceRuns * 2));
        const extraAttempts = Number.isFinite(extraAttemptsRaw)
          ? Math.max(0, Math.min(18, Math.floor(extraAttemptsRaw)))
          : Math.max(0, Math.min(18, evidenceRuns * 2));
        const maxAttempts = evidenceRuns + extraAttempts;
        const typeCounts = {};
        const proposalTypeMap = proposalTypeMapForDate(dateStr);
        let acceptedAttempts = 0;
        let rawAttempts = 0;
        let typeCapSkips = 0;
        while (acceptedAttempts < evidenceRuns && rawAttempts < maxAttempts) {
          rawAttempts += 1;
          const evidence = runJson("node", ["systems/autonomy/autonomy_controller.js", "evidence", dateStr]);
          const evPayload = evidence.payload && typeof evidence.payload === "object" ? evidence.payload : null;
          const proposalId = evPayload ? String(evPayload.proposal_id || "") : "";
          const payloadType = evPayload ? String(evPayload.proposal_type || "").trim().toLowerCase() : "";
          const proposalType = payloadType || (proposalId ? String(proposalTypeMap[proposalId] || "") : "");
          const typeCount = proposalType ? Number(typeCounts[proposalType] || 0) : 0;
          const overTypeCap = evidenceTypeCap > 0 && proposalType && typeCount >= evidenceTypeCap;
          if (overTypeCap) {
            typeCapSkips += 1;
            appendLedger(dateStr, {
              ts: nowIso(),
              type: "spine_autonomy_evidence_skipped_type_cap",
              mode,
              date: dateStr,
              raw_attempt_index: rawAttempts,
              attempts_total: maxAttempts,
              accepted_attempts: acceptedAttempts,
              evidence_runs_target: evidenceRuns,
              proposal_id: proposalId || null,
              proposal_type: proposalType,
              type_count: typeCount,
              type_cap: evidenceTypeCap,
              result: evPayload ? evPayload.result || null : null
            });
            console.log(
              ` autonomy_evidence attempt=${rawAttempts}/${maxAttempts}` +
              ` skipped=type_cap type=${proposalType}` +
              ` count=${typeCount}` +
              ` cap=${evidenceTypeCap}`
            );
            continue;
          }
          acceptedAttempts += 1;
          const ok = evidence.ok && !!evPayload;
          if (ok) evidenceOkCount++;
          if (proposalType) typeCounts[proposalType] = typeCount + 1;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_autonomy_evidence",
            mode,
            date: dateStr,
            attempt_index: acceptedAttempts,
            attempts_total: evidenceRuns,
            raw_attempt_index: rawAttempts,
            raw_attempts_total: maxAttempts,
            ok,
            result: evPayload ? evPayload.result || null : null,
            proposal_id: evPayload ? evPayload.proposal_id || null : null,
            proposal_type: proposalType || null,
            preview_receipt_id: evPayload ? evPayload.preview_receipt_id || null : null,
            reason: !evidence.ok
              ? String(evidence.stderr || evidence.stdout || `autonomy_evidence_exit_${evidence.code}`).slice(0, 180)
              : null
          });
          if (ok) {
            console.log(
              ` autonomy_evidence attempt=${acceptedAttempts}/${evidenceRuns}` +
              ` raw=${rawAttempts}/${maxAttempts}` +
              ` type=${proposalType || "unknown"}` +
              ` result=${evPayload.result || "unknown"}` +
              ` receipt=${evPayload.preview_receipt_id || "none"}`
            );
          } else {
            console.log(` autonomy_evidence attempt=${acceptedAttempts}/${evidenceRuns} raw=${rawAttempts}/${maxAttempts} unavailable reason=${String(evidence.stderr || evidence.stdout || "unknown").slice(0, 120)}`);
          }
        }
        console.log(
          ` autonomy_evidence summary ok=${evidenceOkCount}/${evidenceRuns}` +
          ` raw_attempts=${rawAttempts}/${maxAttempts}` +
          ` type_cap_skips=${typeCapSkips}`
        );
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
      autonomySchedulerEnabled
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
        if (strict) {
          emitSpinePainSignal(
            mode,
            dateStr,
            "outcome_fitness_failed",
            "Outcome fitness loop failed in strict mode",
            reason,
            { severity: "medium", risk: "medium", signature_extra: String(fitness.code || 1) }
          );
          process.exit(fitness.code || 1);
        }
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

    // 0b) weekly strategy synthesis from executed outcomes (rolling window).
    if (String(process.env.SPINE_WEEKLY_STRATEGY_SYNTHESIS_ENABLED || "1") !== "0") {
      const synthesisDays = Math.max(2, Number(process.env.SPINE_WEEKLY_STRATEGY_SYNTHESIS_DAYS || 7) || 7);
      const synthesis = runJson("node", [
        "systems/strategy/weekly_strategy_synthesis.js",
        "run",
        dateStr,
        `--days=${synthesisDays}`,
        "--write=1"
      ]);
      const synthesisPayload = synthesis.payload && typeof synthesis.payload === "object"
        ? synthesis.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_weekly_strategy_synthesis",
        mode,
        date: dateStr,
        ok: synthesis.ok && !!synthesisPayload && synthesisPayload.ok === true,
        days: synthesisPayload ? Number(synthesisPayload.days || 0) : synthesisDays,
        outcomes: synthesisPayload && synthesisPayload.summary && synthesisPayload.summary.totals
          ? Number(synthesisPayload.summary.totals.outcomes || 0)
          : null,
        proposal_types: synthesisPayload && synthesisPayload.summary && synthesisPayload.summary.totals
          ? Number(synthesisPayload.summary.totals.proposal_types || 0)
          : null,
        winners: synthesisPayload && synthesisPayload.summary && Array.isArray(synthesisPayload.summary.winners)
          ? Number(synthesisPayload.summary.winners.length || 0)
          : null,
        losers: synthesisPayload && synthesisPayload.summary && Array.isArray(synthesisPayload.summary.losers)
          ? Number(synthesisPayload.summary.losers.length || 0)
          : null,
        output_file: synthesisPayload ? synthesisPayload.output_file || null : null,
        reason: (!synthesis.ok || !synthesisPayload || synthesisPayload.ok !== true)
          ? String(synthesis.stderr || synthesis.stdout || `weekly_strategy_synthesis_exit_${synthesis.code}`).slice(0, 180)
          : null
      });
      if (synthesis.ok && synthesisPayload && synthesisPayload.ok === true) {
        const totals = synthesisPayload.summary && synthesisPayload.summary.totals ? synthesisPayload.summary.totals : {};
        console.log(
          ` weekly_strategy_synthesis outcomes=${Number(totals.outcomes || 0)}` +
          ` types=${Number(totals.proposal_types || 0)}` +
          ` winners=${Number(synthesisPayload.summary && synthesisPayload.summary.winners ? synthesisPayload.summary.winners.length || 0 : 0)}` +
          ` losers=${Number(synthesisPayload.summary && synthesisPayload.summary.losers ? synthesisPayload.summary.losers.length || 0 : 0)}`
        );
      } else {
        console.log(` weekly_strategy_synthesis unavailable reason=${String(synthesis.stderr || synthesis.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_weekly_strategy_synthesis_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_WEEKLY_STRATEGY_SYNTHESIS_ENABLED",
        flag_value: String(process.env.SPINE_WEEKLY_STRATEGY_SYNTHESIS_ENABLED || "")
      });
      console.log(" weekly_strategy_synthesis skipped reason=feature_flag_disabled flag=SPINE_WEEKLY_STRATEGY_SYNTHESIS_ENABLED");
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
      const idleDreamCycleTimeoutMs = Math.max(5000, Math.min(
        15 * 60 * 1000,
        Number(process.env.SPINE_IDLE_DREAM_CYCLE_TIMEOUT_MS || 180000) || 180000
      ));
      const idleCycle = runJson("node", ["systems/memory/idle_dream_cycle.js", "run", dateStr], {
        timeout: idleDreamCycleTimeoutMs
      });
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
        timeout_ms: idleDreamCycleTimeoutMs,
        timed_out: idleCycle.timed_out === true,
        reason: (!idleCycle.ok || !idlePayload || idlePayload.ok !== true)
          ? String(
            idleCycle.stderr
            || idleCycle.stdout
            || (idleCycle.timed_out === true ? `idle_dream_cycle_timeout_${idleDreamCycleTimeoutMs}ms` : `idle_dream_cycle_exit_${idleCycle.code}`)
          ).slice(0, 180)
          : null
      });
      if (idleCycle.ok && idlePayload && idlePayload.ok === true) {
        console.log(
          ` idle_dream_cycle idle=${idlePayload.idle && idlePayload.idle.skipped ? "skip" : "run"}` +
          ` rem=${idlePayload.rem && idlePayload.rem.skipped ? "skip" : "run"}`
        );
      } else {
        const why = idleCycle.timed_out === true
          ? `timeout_${idleDreamCycleTimeoutMs}ms`
          : String(idleCycle.stderr || idleCycle.stdout || "unknown").slice(0, 120);
        console.log(` idle_dream_cycle unavailable reason=${why}`);
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
        if (strict) {
          emitSpinePainSignal(
            mode,
            dateStr,
            "router_budget_calibration_failed",
            "Router budget calibration failed in strict mode",
            reason,
            { severity: "medium", risk: "medium", signature_extra: String(calibration.code || 1) }
          );
          process.exit(calibration.code || 1);
        }
      } else if (applyResult && applyResult.ok === false) {
        const reason = String(applyResult.error || "apply_failed").slice(0, 120);
        console.log(` router_budget_calibration apply_fail reason=${reason}`);
        if (strict) {
          emitSpinePainSignal(
            mode,
            dateStr,
            "router_budget_calibration_apply_failed",
            "Router budget calibration apply step failed in strict mode",
            reason,
            { severity: "medium", risk: "medium", signature_extra: String(applyResult.code || 1) }
          );
          process.exit(applyResult.code || 1);
        }
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

    // 4b) system budget health summary (burn + pressure transition + top module spend).
    if (String(process.env.SPINE_BUDGET_HEALTH_ENABLED || "1") !== "0") {
      if (!budgetHealth) budgetHealth = budgetHealthSummary(dateStr);
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_budget_health",
        mode,
        date: dateStr,
        ok: budgetHealth.ok === true,
        token_cap: budgetHealth.token_cap,
        used_est: budgetHealth.used_est,
        ratio: budgetHealth.ratio,
        burn_pct: budgetHealth.burn_pct,
        pressure: budgetHealth.pressure || null,
        projected_pressure: budgetHealth.projected_pressure || null,
        previous_pressure: budgetHealth.previous_pressure || null,
        pressure_transition: budgetHealth.pressure_transition || null,
        strategy_id: budgetHealth.strategy_id || null,
        top_module: budgetHealth.top_module || null,
        top_module_used_est: budgetHealth.top_module_used_est,
        top_module_source: budgetHealth.top_module_source || null,
        reason: budgetHealth.ok === true ? null : String(budgetHealth.reason || "budget_health_unavailable").slice(0, 180)
      });
      if (budgetHealth.ok === true) {
        console.log(
          ` budget_health used=${Number(budgetHealth.used_est || 0)}/${Number(budgetHealth.token_cap || 0)}` +
          ` burn=${budgetHealth.burn_pct == null ? "n/a" : `${budgetHealth.burn_pct}%`}` +
          ` pressure=${budgetHealth.pressure || "none"}` +
          ` transition=${budgetHealth.pressure_transition || "n/a"}` +
          ` top_module=${budgetHealth.top_module || "none"}:${Number(budgetHealth.top_module_used_est || 0)}`
        );
      } else {
        console.log(` budget_health unavailable reason=${String(budgetHealth.reason || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_budget_health_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_BUDGET_HEALTH_ENABLED",
        flag_value: String(process.env.SPINE_BUDGET_HEALTH_ENABLED || "")
      });
      console.log(" budget_health skipped reason=feature_flag_disabled flag=SPINE_BUDGET_HEALTH_ENABLED");
    }

    // 4c) autonomy ops health SLO report + thresholded alerts (daily + rolling weekly).
    if (String(process.env.SPINE_AUTONOMY_HEALTH_ENABLED || "1") !== "0") {
      const strict = String(process.env.SPINE_AUTONOMY_HEALTH_STRICT || "0") === "1";
      const weeklyDays = Math.max(2, Number(process.env.SPINE_AUTONOMY_HEALTH_WEEKLY_DAYS || 7) || 7);
      const healthRuns = [
        { label: "daily", args: ["--window=daily", "--days=1"] },
        { label: "weekly", args: ["--window=weekly", `--days=${weeklyDays}`] }
      ];
      for (const runCfg of healthRuns) {
        const health = runJson("node", ["systems/autonomy/health_status.js", dateStr, ...runCfg.args]);
        const payload = health.payload && typeof health.payload === "object" ? health.payload : null;
        const slo = payload && payload.slo && typeof payload.slo === "object" ? payload.slo : {};
        const critical = Number(slo.critical_count || 0);
        const warns = Number(slo.warn_count || 0);
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_autonomy_health",
          mode,
          date: dateStr,
          window: runCfg.label,
          ok: health.ok && !!payload,
          slo_ok: payload ? slo.ok === true : null,
          slo_level: payload ? String(slo.level || "unknown") : null,
          warn_count: warns,
          critical_count: critical,
          failed_checks: payload && Array.isArray(slo.failed_checks) ? slo.failed_checks : [],
          alerts_generated: payload && payload.alerts ? Number(payload.alerts.generated || 0) : null,
          alerts_written: payload && payload.alerts ? Number(payload.alerts.written || 0) : null,
          alert_path: payload && payload.alerts ? payload.alerts.path || null : null,
          report_path: payload && payload.report ? payload.report.path || null : null,
          reason: (!health.ok || !payload)
            ? String(health.stderr || health.stdout || `autonomy_health_exit_${health.code}`).slice(0, 180)
            : null
        });
        if (!health.ok || !payload) {
          const reason = String(health.stderr || health.stdout || "unknown").slice(0, 120);
          console.log(` autonomy_health ${runCfg.label} unavailable reason=${reason}`);
          if (strict) {
            emitSpinePainSignal(
              mode,
              dateStr,
              `autonomy_health_${runCfg.label}_failed`,
              `Autonomy health check (${runCfg.label}) failed in strict mode`,
              reason,
              { severity: "medium", risk: "medium", signature_extra: String(health.code || 1) }
            );
            process.exit(health.code || 1);
          }
          continue;
        }
        console.log(
          ` autonomy_health ${runCfg.label}` +
          ` level=${String(slo.level || "ok")}` +
          ` warn=${warns}` +
          ` critical=${critical}` +
          ` alerts_written=${Number(payload.alerts && payload.alerts.written || 0)}`
        );
        if (strict && critical > 0) {
          console.error(` autonomy_health ${runCfg.label} FAIL critical=${critical}`);
          emitSpinePainSignal(
            mode,
            dateStr,
            `autonomy_health_${runCfg.label}_critical`,
            `Autonomy health check (${runCfg.label}) reported critical issues`,
            `critical=${critical} warns=${warns}`,
            { severity: "high", risk: "high", signature_extra: `${runCfg.label}:${critical}` }
          );
          process.exit(1);
        }
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_autonomy_health_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_AUTONOMY_HEALTH_ENABLED",
        flag_value: String(process.env.SPINE_AUTONOMY_HEALTH_ENABLED || "")
      });
      console.log(" autonomy_health skipped reason=feature_flag_disabled flag=SPINE_AUTONOMY_HEALTH_ENABLED");
    }

    // 4d) weekly strategic alignment oracle + escalation artifacting.
    if (String(process.env.SPINE_ALIGNMENT_ORACLE_ENABLED || "1") !== "0") {
      const strict = String(process.env.SPINE_ALIGNMENT_ORACLE_STRICT || "0") === "1";
      const threshold = Math.max(10, Math.min(95, Number(process.env.SPINE_ALIGNMENT_ORACLE_THRESHOLD || 60) || 60));
      const minWeekSamples = Math.max(1, Number(process.env.SPINE_ALIGNMENT_ORACLE_MIN_WEEK_SAMPLES || 3) || 3);
      const escalationEnabled = String(process.env.SPINE_ALIGNMENT_ORACLE_ESCALATE || "1") !== "0";
      const oracle = runJson("node", [
        "systems/autonomy/alignment_oracle.js",
        "run",
        dateStr,
        `--threshold=${threshold}`,
        `--min-week-samples=${minWeekSamples}`,
        `--escalate=${escalationEnabled ? 1 : 0}`
      ]);
      const payload = oracle.payload && typeof oracle.payload === "object" ? oracle.payload : null;
      const escalation = payload && payload.escalation && typeof payload.escalation === "object"
        ? payload.escalation
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_alignment_oracle",
        mode,
        date: dateStr,
        ok: oracle.ok && !!payload,
        alignment_score: payload ? Number(payload.alignment_score || 0) : null,
        escalate: payload && payload.alignment ? payload.alignment.escalate === true : null,
        threshold: payload && payload.alignment ? Number(payload.alignment.threshold || threshold) : threshold,
        min_week_samples: payload && payload.alignment ? Number(payload.alignment.min_week_samples || minWeekSamples) : minWeekSamples,
        escalation_emitted: escalation ? escalation.emitted === true : null,
        escalation_reason: escalation ? String(escalation.reason || "") : null,
        report_path: payload ? payload.report_path || null : null,
        reason: (!oracle.ok || !payload)
          ? String(oracle.stderr || oracle.stdout || `alignment_oracle_exit_${oracle.code}`).slice(0, 180)
          : null
      });
      if (!oracle.ok || !payload) {
        const reason = String(oracle.stderr || oracle.stdout || "unknown").slice(0, 120);
        console.log(` alignment_oracle unavailable reason=${reason}`);
        if (strict) {
          emitSpinePainSignal(
            mode,
            dateStr,
            "alignment_oracle_failed",
            "Alignment oracle failed in strict mode",
            reason,
            { severity: "medium", risk: "medium", signature_extra: String(oracle.code || 1) }
          );
          process.exit(oracle.code || 1);
        }
      } else {
        console.log(
          ` alignment_oracle score=${Number(payload.alignment_score || 0)}` +
          ` escalate=${payload.alignment && payload.alignment.escalate === true ? "yes" : "no"}` +
          ` escalation_emitted=${escalation && escalation.emitted === true ? "yes" : "no"}`
        );
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_alignment_oracle_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_ALIGNMENT_ORACLE_ENABLED",
        flag_value: String(process.env.SPINE_ALIGNMENT_ORACLE_ENABLED || "")
      });
      console.log(" alignment_oracle skipped reason=feature_flag_disabled flag=SPINE_ALIGNMENT_ORACLE_ENABLED");
    }

    // 4d) ops dashboard summary over recent daily+weekly health reports.
    if (String(process.env.SPINE_OPS_DASHBOARD_ENABLED || "1") !== "0") {
      const dashboardDays = Math.max(2, Number(process.env.SPINE_OPS_DASHBOARD_DAYS || 7) || 7);
      const dashboard = runJson("node", ["systems/autonomy/ops_dashboard.js", "run", dateStr, `--days=${dashboardDays}`]);
      const payload = dashboard.payload && typeof dashboard.payload === "object" ? dashboard.payload : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_ops_dashboard",
        mode,
        date: dateStr,
        ok: dashboard.ok && !!payload && payload.ok === true,
        reports: payload ? Number(payload.reports || 0) : null,
        failed_checks: payload && payload.summary && payload.summary.totals
          ? Number(payload.summary.totals.failed_checks || 0)
          : null,
        critical: payload && payload.summary && payload.summary.totals
          ? Number(payload.summary.totals.critical || 0)
          : null,
        warnings: payload && payload.summary && payload.summary.totals
          ? Number(payload.summary.totals.warnings || 0)
          : null,
        reason: (!dashboard.ok || !payload || payload.ok !== true)
          ? String(dashboard.stderr || dashboard.stdout || `ops_dashboard_exit_${dashboard.code}`).slice(0, 180)
          : null
      });
      if (dashboard.ok && payload && payload.ok === true) {
        const totals = payload.summary && payload.summary.totals ? payload.summary.totals : {};
        console.log(
          ` ops_dashboard reports=${Number(payload.reports || 0)}` +
          ` failed_checks=${Number(totals.failed_checks || 0)}` +
          ` critical=${Number(totals.critical || 0)}` +
          ` warnings=${Number(totals.warnings || 0)}`
        );
      } else {
        console.log(` ops_dashboard unavailable reason=${String(dashboard.stderr || dashboard.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_ops_dashboard_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_OPS_DASHBOARD_ENABLED",
        flag_value: String(process.env.SPINE_OPS_DASHBOARD_ENABLED || "")
      });
      console.log(" ops_dashboard skipped reason=feature_flag_disabled flag=SPINE_OPS_DASHBOARD_ENABLED");
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

    // 5b) backup integrity verification (state backups + blank-slate archives).
    if (String(process.env.STATE_BACKUP_INTEGRITY_ENABLED || "1") !== "0") {
      const integrityArgs = ["systems/ops/backup_integrity_check.js", "run"];
      const strict = String(process.env.STATE_BACKUP_INTEGRITY_STRICT || "0") === "1";
      if (strict) integrityArgs.push("--strict");
      const backupIntegrity = runJson("node", integrityArgs);
      const integrityPayload = backupIntegrity.payload && typeof backupIntegrity.payload === "object"
        ? backupIntegrity.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_backup_integrity",
        mode,
        date: dateStr,
        ok: backupIntegrity.ok && !!integrityPayload && integrityPayload.ok === true,
        strict,
        checked_channels: integrityPayload ? Number(integrityPayload.checked_channels || 0) : null,
        failed_channels: integrityPayload ? Number(integrityPayload.failed_channels || 0) : null,
        failed_required_channels: integrityPayload ? Number(integrityPayload.failed_required_channels || 0) : null,
        reason: (!backupIntegrity.ok || !integrityPayload || integrityPayload.ok !== true)
          ? String(backupIntegrity.stderr || backupIntegrity.stdout || `backup_integrity_exit_${backupIntegrity.code}`).slice(0, 180)
          : null
      });
      if (backupIntegrity.ok && integrityPayload && integrityPayload.ok === true) {
        console.log(
          ` backup_integrity ok channels=${Number(integrityPayload.checked_channels || 0)}` +
          ` failed=${Number(integrityPayload.failed_channels || 0)}`
        );
      } else {
        console.log(` backup_integrity unavailable reason=${String(backupIntegrity.stderr || backupIntegrity.stdout || "unknown").slice(0, 120)}`);
        if (strict) {
          emitSpinePainSignal(
            mode,
            dateStr,
            "backup_integrity_failed",
            "Backup integrity check failed in strict mode",
            String(backupIntegrity.stderr || backupIntegrity.stdout || "backup_integrity_failed").slice(0, 180),
            { severity: "high", risk: "high", signature_extra: String(backupIntegrity.code || 1) }
          );
          process.exit(backupIntegrity.code || 1);
        }
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_backup_integrity_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "STATE_BACKUP_INTEGRITY_ENABLED",
        flag_value: String(process.env.STATE_BACKUP_INTEGRITY_ENABLED || "")
      });
      console.log(" backup_integrity skipped reason=feature_flag_disabled flag=STATE_BACKUP_INTEGRITY_ENABLED");
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
