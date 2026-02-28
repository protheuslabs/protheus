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
const { isEmergencyStopEngaged } = require("../../lib/emergency_stop");
const { stampGuardEnv } = require("../../lib/request_envelope");
const { compactCommandOutput } = require("../../lib/command_output_compactor");
const {
  setSystemBudgetAutopause,
  clearSystemBudgetAutopause,
  loadSystemBudgetAutopauseState
} = require("../budget/system_budget");
const { loadTritShadowPolicy, applyInfluenceGuardFromShadowReport } = require("../../lib/trit_shadow_control");
const { computeEvidenceRunPlan } = require("./evidence_run_plan");
const { evaluateTernaryBelief, serializeBeliefResult } = require("../../lib/ternary_belief_engine");
let stateKernelDualWriteMod: AnyObj = null;
try {
  stateKernelDualWriteMod = require('../ops/state_kernel_dual_write.js');
} catch {
  stateKernelDualWriteMod = null;
}

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
    const latestPath = path.join(root, "state", "spine", "runs", "latest.json");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(evt) + "\n");
    if (stateKernelDualWriteMod && typeof stateKernelDualWriteMod.writeMirror === 'function') {
      try {
        stateKernelDualWriteMod.writeMirror({
          'organ-id': 'spine_runs',
          'fs-path': latestPath,
          'payload-json': JSON.stringify({
            date: String(dateStr || '').slice(0, 10),
            event: evt
          })
        });
      } catch {
        // Dual-write should never block spine run ledger writes.
      }
    }
  } catch {
    // ledger must never block spine execution
  }
}

const SYSTEM_HEALTH_EVENTS_PATH = process.env.SYSTEM_HEALTH_EVENTS_PATH
  ? path.resolve(process.env.SYSTEM_HEALTH_EVENTS_PATH)
  : path.join(repoRoot(), "state", "ops", "system_health", "events.jsonl");

function appendSystemHealthEvent(evt) {
  try {
    const row = evt && typeof evt === "object" ? evt : {};
    const payload = {
      ts: nowIso(),
      type: "system_health_event",
      source: "spine",
      subsystem: "spine",
      severity: "medium",
      risk: "medium",
      code: "spine_event",
      summary: "spine event",
      ...row
    };
    fs.mkdirSync(path.dirname(SYSTEM_HEALTH_EVENTS_PATH), { recursive: true });
    fs.appendFileSync(SYSTEM_HEALTH_EVENTS_PATH, JSON.stringify(payload) + "\n");
  } catch {
    // System-health telemetry must never block spine execution.
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

function spineRunsLedgerPath(dateStr) {
  return path.join(repoRoot(), "state", "spine", "runs", `${String(dateStr || "").slice(0, 10)}.jsonl`);
}

function spineTernaryBeliefSnapshotPath(dateStr, mode) {
  const dir = path.join(repoRoot(), "state", "spine", "ternary_belief");
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${String(dateStr || "").slice(0, 10)}_${String(mode || "unknown")}.json`);
}

function writeJsonAtomic(filePath, value) {
  const tmpPath = `${filePath}.tmp`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`);
  fs.renameSync(tmpPath, filePath);
}

function latestSpineRunRows(rows, mode) {
  const scoped = (Array.isArray(rows) ? rows : []).filter((row) => {
    if (!row || typeof row !== "object") return false;
    if (!mode) return true;
    return String(row.mode || "") === String(mode);
  });
  if (!scoped.length) return [];
  let startIndex = 0;
  for (let i = scoped.length - 1; i >= 0; i -= 1) {
    const row = scoped[i];
    if (String(row.type || "") !== "spine_run_started") continue;
    startIndex = i;
    break;
  }
  return scoped.slice(startIndex);
}

function spineTritWeightForType(type) {
  const t = String(type || "");
  if (!t) return 1;
  if (/signal_gate|signal_slo|integrity|security|emergency|critical/i.test(t)) return 3;
  if (/budget_guard|autonomy_health|strategy|router_alert|startup_attestation|secret_rotation|offsite_backup|restore_drill/i.test(t)) return 2;
  if (/_skipped$/i.test(t)) return 0.5;
  return 1;
}

const SPINE_TRIT_OK_RE = /\b(ok|pass|allow|approved|healthy|ready|triggered|applied|success|complete)\b/i;
const SPINE_TRIT_PAIN_RE = /\b(fail|error|deny|blocked|violation|critical|halt|stop|degraded|unhealthy|missing|regression)\b/i;
const SPINE_TRIT_UNKNOWN_RE = /\b(skip|skipped|unknown|unavailable|none|n\/a|noop|disabled|pending|neutral)\b/i;
const SPINE_TRIT_ANOMALY_ENABLED = String(process.env.SPINE_TRIT_ANOMALY_ENABLED || "1") !== "0";
const SPINE_TRIT_ANOMALY_NEGATIVE_STREAK = Math.max(1, Number(process.env.SPINE_TRIT_ANOMALY_NEGATIVE_STREAK || 2));
const SPINE_TRIT_ANOMALY_MIN_CONFIDENCE = Math.max(0, Math.min(1, Number(process.env.SPINE_TRIT_ANOMALY_MIN_CONFIDENCE || 0.65)));
const SPINE_TRIT_ANOMALY_MAX_SCORE = Math.max(-1, Math.min(0, Number(process.env.SPINE_TRIT_ANOMALY_MAX_SCORE || -0.2)));

function spineTritSignalFromEvent(evt) {
  if (!evt || typeof evt !== "object") return null;
  const type = String(evt.type || "").trim();
  if (!type || /^spine_ternary_belief/.test(type)) return null;
  const weight = spineTritWeightForType(type);

  if (/_skipped$/i.test(type)) {
    return { source: type, trit: 0, weight, confidence: 0.35, tags: ["skipped"] };
  }
  if (evt.ok === true) {
    return { source: type, trit: 1, weight, confidence: 1, tags: ["ok_flag"] };
  }
  if (evt.ok === false) {
    return { source: type, trit: -1, weight, confidence: 1, tags: ["ok_flag"] };
  }

  const blob = [
    evt.result,
    evt.reason,
    evt.alert,
    evt.status,
    evt.action
  ].map((part) => String(part || "").trim()).filter(Boolean).join(" ").toLowerCase();

  if (!blob) {
    return { source: type, trit: 0, weight, confidence: 0.25, tags: ["missing_text_signal"] };
  }

  const hasPain = SPINE_TRIT_PAIN_RE.test(blob);
  const hasOk = SPINE_TRIT_OK_RE.test(blob);
  const hasUnknown = SPINE_TRIT_UNKNOWN_RE.test(blob);

  if (hasPain && !hasOk) return { source: type, trit: -1, weight, confidence: 0.7, tags: ["text_signal"] };
  if (hasOk && !hasPain) return { source: type, trit: 1, weight, confidence: 0.7, tags: ["text_signal"] };
  if (hasUnknown || (hasPain && hasOk)) return { source: type, trit: 0, weight, confidence: 0.5, tags: ["text_signal"] };

  return { source: type, trit: 0, weight, confidence: 0.3, tags: ["fallback_unknown"] };
}

function buildSpineTernaryBeliefSnapshot(
  dateStr,
  mode,
  runtimeSignals: { signal_gate_ok?: unknown; signal_slo_ok?: unknown } = {}
) {
  const rows = readJsonl(spineRunsLedgerPath(dateStr))
    .filter((row) => row && typeof row === "object");
  const runRows = latestSpineRunRows(rows, mode);
  const signals = [];
  for (const row of runRows) {
    const signal = spineTritSignalFromEvent(row);
    if (!signal) continue;
    signals.push(signal);
  }
  if (runtimeSignals && runtimeSignals.signal_gate_ok != null) {
    signals.push({
      source: "runtime_signal_gate",
      trit: runtimeSignals.signal_gate_ok ? 1 : -1,
      weight: 3,
      confidence: 1,
      tags: ["runtime_override"]
    });
  }
  if (runtimeSignals && runtimeSignals.signal_slo_ok != null) {
    signals.push({
      source: "runtime_signal_slo",
      trit: runtimeSignals.signal_slo_ok ? 1 : -1,
      weight: 3,
      confidence: 1,
      tags: ["runtime_override"]
    });
  }
  if (!signals.length) return null;

  const belief = evaluateTernaryBelief(signals, {
    label: "spine_run_health",
    positive_threshold: 0.2,
    negative_threshold: -0.2,
    evidence_saturation_count: 12
  });
  const topPainSources = (Array.isArray(belief.signals) ? belief.signals : [])
    .filter((row) => Number(row.trit || 0) === -1)
    .sort((a, b) => Number(b.weighted || 0) - Number(a.weighted || 0))
    .slice(0, 5)
    .map((row) => ({
      source: row.source,
      weighted: Number(Number(row.weighted || 0).toFixed(4))
    }));
  const summary = {
    trit: Number(belief.trit || 0),
    label: String(belief.trit_label || "unknown"),
    score: Number(Number(belief.score || 0).toFixed(4)),
    confidence: Number(Number(belief.confidence || 0).toFixed(4)),
    evidence_count: Number(belief.evidence_count || 0),
    pain_signals: (Array.isArray(belief.signals) ? belief.signals : []).filter((row) => Number(row.trit || 0) === -1).length,
    unknown_signals: (Array.isArray(belief.signals) ? belief.signals : []).filter((row) => Number(row.trit || 0) === 0).length,
    ok_signals: (Array.isArray(belief.signals) ? belief.signals : []).filter((row) => Number(row.trit || 0) === 1).length,
    top_pain_sources: topPainSources
  };
  const snapshot = {
    schema_id: "spine_ternary_belief_snapshot",
    schema_version: "1.0.0",
    ts: nowIso(),
    date: String(dateStr || "").slice(0, 10),
    mode: String(mode || ""),
    run_row_count: runRows.length,
    signal_count: signals.length,
    belief: serializeBeliefResult(belief),
    summary,
    signals: belief.signals
  };
  const snapshotPath = spineTernaryBeliefSnapshotPath(dateStr, mode);
  writeJsonAtomic(snapshotPath, snapshot);
  return {
    ...summary,
    snapshot_path: snapshotPath,
    signal_count: signals.length
  };
}

function emitSpineTernaryBelief(
  dateStr,
  mode,
  runtimeSignals: { signal_gate_ok?: unknown; signal_slo_ok?: unknown } = {}
) {
  try {
    const out = buildSpineTernaryBeliefSnapshot(dateStr, mode, runtimeSignals);
    if (!out) return null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_ternary_belief",
      mode,
      date: dateStr,
      trit: out.trit,
      label: out.label,
      score: out.score,
      confidence: out.confidence,
      evidence_count: out.evidence_count,
      signal_count: out.signal_count,
      pain_signals: out.pain_signals,
      unknown_signals: out.unknown_signals,
      ok_signals: out.ok_signals,
      top_pain_sources: out.top_pain_sources,
      snapshot_path: out.snapshot_path
    });
    console.log(` spine_ternary_belief label=${out.label} score=${out.score} confidence=${out.confidence}`);
    return out;
  } catch (err) {
    const reason = String(err && err.message ? err.message : err || "ternary_belief_unavailable").slice(0, 180);
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_ternary_belief_unavailable",
      mode,
      date: dateStr,
      reason
    });
    console.log(` spine_ternary_belief unavailable reason=${reason}`);
    return null;
  }
}

function maybeEmitSpineTritAnomaly(
  dateStr,
  mode,
  latestBelief
) {
  if (!SPINE_TRIT_ANOMALY_ENABLED) return null;
  const belief = latestBelief && typeof latestBelief === "object" ? latestBelief : null;
  if (!belief) return null;
  if (Number(belief.trit || 0) >= 0) return null;
  if (Number(belief.confidence || 0) < SPINE_TRIT_ANOMALY_MIN_CONFIDENCE) return null;
  if (Number(belief.score || 0) > SPINE_TRIT_ANOMALY_MAX_SCORE) return null;

  const rows = readJsonl(spineRunsLedgerPath(dateStr))
    .filter((row) => row && typeof row === "object" && String(row.type || "") === "spine_ternary_belief")
    .filter((row) => !mode || String(row.mode || "") === String(mode))
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));
  let streak = 0;
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const row = rows[i];
    if (Number(row.trit || 0) < 0) {
      streak += 1;
      continue;
    }
    break;
  }
  if (streak < SPINE_TRIT_ANOMALY_NEGATIVE_STREAK) return null;
  const topPain = Array.isArray(belief.top_pain_sources) ? belief.top_pain_sources.slice(0, 5) : [];
  const alert = {
    ts: nowIso(),
    type: "spine_ternary_anomaly_alert",
    mode,
    date: dateStr,
    severity: streak >= (SPINE_TRIT_ANOMALY_NEGATIVE_STREAK + 1) ? "critical" : "warn",
    negative_streak: streak,
    threshold_streak: SPINE_TRIT_ANOMALY_NEGATIVE_STREAK,
    trit: Number(belief.trit || 0),
    score: Number(belief.score || 0),
    confidence: Number(belief.confidence || 0),
    top_pain_sources: topPain,
    reason: "ternary_negative_streak"
  };
  appendLedger(dateStr, alert);
  console.log(
    ` spine_ternary_anomaly severity=${alert.severity}` +
    ` streak=${streak}` +
    ` score=${Number(alert.score).toFixed(4)}` +
    ` confidence=${Number(alert.confidence).toFixed(4)}`
  );
  return alert;
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
    const entAny = ent as { used_est?: unknown } | null;
    const usedEst = Number((entAny && entAny.used_est) || 0);
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
  const spineRunStartMs = Date.now();
  const mode = process.argv[2];
  const dateStr = todayOr(process.argv[3]);
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
    "systems/security/secret_broker.js",
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
    "systems/autonomy/health_status.js",
    "systems/observability/metrics_exporter.js",
    "systems/observability/trace_bridge.js",
    "systems/observability/slo_alert_router.js",
    "systems/actuation/actuation_executor.js",
    "systems/actuation/bridge_from_proposals.js",
    "systems/ops/state_backup.js",
    "systems/ops/offsite_backup.js",
    "systems/ops/backup_integrity_check.js",
    "systems/ops/openclaw_backup_retention.js",
    "systems/memory/eyes_memory_bridge.js",
    "systems/memory/failure_memory_bridge.js",
    "systems/memory/memory_dream.js",
    "systems/memory/uid_connections.js",
    "systems/memory/creative_links.js",
    "systems/sensory/cross_signal_engine.js",
    "systems/strategy/weekly_strategy_synthesis.js",
    "systems/autonomy/ops_dashboard.js",
    "systems/autonomy/red_team_harness.js",
    "systems/autonomy/collective_shadow.js",
    "systems/autonomy/observer_mirror.js",
    "systems/autonomy/mirror_organ.js",
    "systems/autonomy/inversion_controller.js",
    "systems/continuum/continuum_core.js",
    "systems/strategy/strategy_principles.js",
    "systems/workflow/workflow_generator.js",
    "systems/workflow/orchestron_controller.js",
    "systems/workflow/workflow_controller.js",
    "systems/fractal/regime_organ.js",
    "systems/identity/identity_anchor.js",
    "systems/nursery/nursery_bootstrap.js",
    "systems/actuation/claw_registry.js",
    "systems/ops/public_benchmark_pack.js",
    "systems/ops/deployment_packaging.js",
    "systems/ops/compliance_posture.js",
    "systems/ops/personal_protheus_installer.js",
    "config/actuation_adapters.json",
    "config/actuation_claws_policy.json",
    "config/red_team_policy.json",
    "config/collective_shadow_policy.json",
    "config/continuum_policy.json",
    "config/mirror_organ_policy.json",
    "config/inversion_policy.json",
    "config/nursery_policy.json",
    "config/workflow_executor_policy.json",
    "config/workflow_policy.json",
    "config/regime_organ_policy.json",
    "config/identity_anchor_policy.json",
    "config/deployment_packaging_policy.json",
    "config/compliance_posture_policy.json",
    "config/state_backup_policy.json",
    "config/offsite_backup_policy.json",
    "config/secret_broker_policy.json",
    "config/observability_policy.json",
    "skills/moltbook/actuation_adapter.js",
    "skills/moltbook/moltbook_publish_guard.js",
    "systems/routing/route_execute.js",
    "systems/routing/route_task.js",
    "systems/routing/model_router.js",
    "systems/routing/router_budget_calibration.js",
    "systems/budget/system_budget.js",
    "habits/scripts/queue_gc.js",
    "habits/scripts/proposal_queue.js",
    "config/security_integrity_policy.json"
  ];

  // Clearance gate
  guard(invoked);

  if (String(process.env.SPINE_NURSERY_BOOTSTRAP_ENABLED || "1") !== "0") {
    const nursery = runJson("node", ["systems/nursery/nursery_bootstrap.js", "run"]);
    const nurseryPayload = nursery.payload && typeof nursery.payload === "object"
      ? nursery.payload
      : null;
    const nurseryOk = nursery.ok && !!nurseryPayload && nurseryPayload.ok === true;
    const nurseryStrict = String(process.env.SPINE_NURSERY_BOOTSTRAP_STRICT || "0") === "1";
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_nursery_bootstrap",
      mode,
      date: dateStr,
      ok: nurseryOk,
      strict: nurseryStrict,
      nursery_root: nurseryPayload ? nurseryPayload.nursery_root || null : null,
      policy_path: nurseryPayload ? nurseryPayload.policy_path || null : null,
      artifacts_total: nurseryPayload ? Number(nurseryPayload.artifacts_total || 0) : null,
      artifacts_ready: nurseryPayload ? Number(nurseryPayload.artifacts_ready || 0) : null,
      required_missing_count: nurseryPayload && Array.isArray(nurseryPayload.required_missing)
        ? Number(nurseryPayload.required_missing.length || 0)
        : null,
      reason: !nurseryOk
        ? String(nursery.stderr || nursery.stdout || `nursery_bootstrap_exit_${nursery.code}`).slice(0, 180)
        : null
    });
    if (nurseryOk) {
      console.log(
        ` nursery_bootstrap ok ready=${Number(nurseryPayload.artifacts_ready || 0)}` +
        `/${Number(nurseryPayload.artifacts_total || 0)}`
      );
    } else {
      console.log(` nursery_bootstrap unavailable reason=${String(nursery.stderr || nursery.stdout || "unknown").slice(0, 120)}`);
      if (nurseryStrict) process.exit(nursery.code || 1);
    }
  } else {
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_nursery_bootstrap_skipped",
      mode,
      date: dateStr,
      reason: "feature_flag_disabled",
      flag: "SPINE_NURSERY_BOOTSTRAP_ENABLED",
      flag_value: String(process.env.SPINE_NURSERY_BOOTSTRAP_ENABLED || "")
    });
    console.log(" nursery_bootstrap skipped reason=feature_flag_disabled flag=SPINE_NURSERY_BOOTSTRAP_ENABLED");
  }

  if (String(process.env.SPINE_RED_TEAM_BOOTSTRAP_ENABLED || "1") !== "0") {
    const redBootstrap = runJson("node", ["systems/autonomy/red_team_harness.js", "bootstrap"]);
    const redBootstrapPayload = redBootstrap.payload && typeof redBootstrap.payload === "object"
      ? redBootstrap.payload
      : null;
    const redBootstrapOk = redBootstrap.ok && !!redBootstrapPayload && redBootstrapPayload.ok === true;
    const redBootstrapStrict = String(process.env.SPINE_RED_TEAM_BOOTSTRAP_STRICT || "0") === "1";
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_red_team_bootstrap",
      mode,
      date: dateStr,
      ok: redBootstrapOk,
      strict: redBootstrapStrict,
      state_root: redBootstrapPayload ? redBootstrapPayload.state_root || null : null,
      corpus_cases: redBootstrapPayload ? Number(redBootstrapPayload.corpus_cases || 0) : null,
      model_available: redBootstrapPayload && redBootstrapPayload.model
        ? redBootstrapPayload.model.available === true
        : null,
      model_reason: redBootstrapPayload && redBootstrapPayload.model
        ? redBootstrapPayload.model.reason || null
        : null,
      reason: !redBootstrapOk
        ? String(redBootstrap.stderr || redBootstrap.stdout || `red_team_bootstrap_exit_${redBootstrap.code}`).slice(0, 180)
        : null
    });
    if (redBootstrapOk) {
      console.log(
        ` red_team_bootstrap ok corpus=${Number(redBootstrapPayload.corpus_cases || 0)}` +
        ` model=${redBootstrapPayload && redBootstrapPayload.model && redBootstrapPayload.model.available === true ? "available" : "unavailable"}`
      );
    } else {
      console.log(` red_team_bootstrap unavailable reason=${String(redBootstrap.stderr || redBootstrap.stdout || "unknown").slice(0, 120)}`);
      if (redBootstrapStrict) process.exit(redBootstrap.code || 1);
    }
  } else {
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_red_team_bootstrap_skipped",
      mode,
      date: dateStr,
      reason: "feature_flag_disabled",
      flag: "SPINE_RED_TEAM_BOOTSTRAP_ENABLED",
      flag_value: String(process.env.SPINE_RED_TEAM_BOOTSTRAP_ENABLED || "")
    });
    console.log(" red_team_bootstrap skipped reason=feature_flag_disabled flag=SPINE_RED_TEAM_BOOTSTRAP_ENABLED");
  }

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
    process.exit(failureMemoryBridge.code || 1);
  }
  console.log(
    ` failure_memory_bridge selected=${Number(failureBridgePayload.selected || 0)}` +
    ` created=${Number(failureBridgePayload.created_nodes || 0)}` +
    ` revisit=${Number(failureBridgePayload.revisit_pointers || 0)}`
  );
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
      process.exit(1);
    }
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
      appendSystemHealthEvent({
        severity: "high",
        risk: "high",
        code: "signal_slo_fail",
        summary: `spine signal_slo failed (${String(failed || "unknown").slice(0, 120)})`,
        date: dateStr,
        mode,
        failed_checks: payload && Array.isArray(payload.failed_checks) ? payload.failed_checks.slice(0, 12) : []
      });
    }

    if (String(process.env.SPINE_SIGNAL_SLO_DEADLOCK_BREAKER_ENABLED || "1") !== "0") {
      const deadlock = runJson("node", [
        "systems/ops/signal_slo_deadlock_breaker.js",
        "run",
        dateStr
      ]);
      const deadlockPayload = deadlock.payload && typeof deadlock.payload === "object"
        ? deadlock.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_signal_slo_deadlock_breaker",
        mode,
        date: dateStr,
        ok: deadlock.ok && !!deadlockPayload && deadlockPayload.ok === true,
        streak: deadlockPayload ? Number(deadlockPayload.streak || 0) : null,
        threshold: deadlockPayload ? Number(deadlockPayload.streak_threshold || 0) : null,
        signal_slo_ok: deadlockPayload ? deadlockPayload.signal_slo_ok === true : null,
        escalation_proposal_id: deadlockPayload && deadlockPayload.escalation
          ? deadlockPayload.escalation.proposal_id || null
          : null,
        closure_receipt: deadlockPayload ? deadlockPayload.closure_receipt || null : null,
        reason: (!deadlock.ok || !deadlockPayload || deadlockPayload.ok !== true)
          ? String(deadlock.stderr || deadlock.stdout || `signal_slo_deadlock_breaker_exit_${deadlock.code}`).slice(0, 180)
          : null
      });
      if (deadlock.ok && deadlockPayload && deadlockPayload.ok === true) {
        const streak = Number(deadlockPayload.streak || 0);
        const threshold = Number(deadlockPayload.streak_threshold || 0);
        const escalated = deadlockPayload.escalation && deadlockPayload.escalation.created === true;
        console.log(` signal_slo_deadlock streak=${streak}/${threshold} escalated=${escalated ? "yes" : "no"}`);
      } else {
        console.log(` signal_slo_deadlock WARN reason=${String(deadlock.stderr || deadlock.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_signal_slo_deadlock_breaker_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_SIGNAL_SLO_DEADLOCK_BREAKER_ENABLED",
        flag_value: String(process.env.SPINE_SIGNAL_SLO_DEADLOCK_BREAKER_ENABLED || "")
      });
      console.log(" signal_slo_deadlock skipped reason=feature_flag_disabled flag=SPINE_SIGNAL_SLO_DEADLOCK_BREAKER_ENABLED");
    }

    if (String(process.env.SPINE_MODEL_HEALTH_AUTORECOVERY_ENABLED || "1") !== "0") {
      const recovery = runJson("node", [
        "systems/ops/model_health_auto_recovery.js",
        "run",
        dateStr
      ]);
      const recoveryPayload = recovery.payload && typeof recovery.payload === "object"
        ? recovery.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_model_health_auto_recovery",
        mode,
        date: dateStr,
        ok: recovery.ok && !!recoveryPayload && recoveryPayload.ok === true,
        providers_total: recoveryPayload ? Number(recoveryPayload.providers_total || 0) : null,
        providers_healthy: recoveryPayload ? Number(recoveryPayload.providers_healthy || 0) : null,
        provider_health_pass_rate: recoveryPayload ? Number(recoveryPayload.provider_health_pass_rate || 0) : null,
        failovers_applied: recoveryPayload && Array.isArray(recoveryPayload.providers)
          ? recoveryPayload.providers.filter((row: any) => row && row.failover && row.failover.applied === true).length
          : null,
        reason: (!recovery.ok || !recoveryPayload || recoveryPayload.ok !== true)
          ? String(recovery.stderr || recovery.stdout || `model_health_auto_recovery_exit_${recovery.code}`).slice(0, 180)
          : null
      });
      if (recovery.ok && recoveryPayload && recoveryPayload.ok === true) {
        console.log(
          ` model_health_auto_recovery pass_rate=${Number(recoveryPayload.provider_health_pass_rate || 0)}` +
          ` healthy=${Number(recoveryPayload.providers_healthy || 0)}/${Number(recoveryPayload.providers_total || 0)}`
        );
      } else {
        console.log(` model_health_auto_recovery WARN reason=${String(recovery.stderr || recovery.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_model_health_auto_recovery_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_MODEL_HEALTH_AUTORECOVERY_ENABLED",
        flag_value: String(process.env.SPINE_MODEL_HEALTH_AUTORECOVERY_ENABLED || "")
      });
      console.log(" model_health_auto_recovery skipped reason=feature_flag_disabled flag=SPINE_MODEL_HEALTH_AUTORECOVERY_ENABLED");
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
    const ternary = emitSpineTernaryBelief(dateStr, mode, {
      signal_gate_ok: signalGateOk,
      signal_slo_ok: signalSloOk
    });
    maybeEmitSpineTritAnomaly(dateStr, mode, ternary);
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

    let startupAttestation = { checked: false, ok: true, required: false, reason: null as string | null };
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
      let keyWarningReason: string | null = null;
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

    if (String(process.env.SPINE_SECRET_ROTATION_CHECK_ENABLED || "1") !== "0") {
      const secretRotationStrict = String(process.env.SPINE_SECRET_ROTATION_CHECK_STRICT || "0") === "1";
      const secretRotationPolicyPath = String(
        process.env.SPINE_SECRET_BROKER_POLICY_PATH || "config/secret_broker_policy.json"
      ).trim();
      const secretRotationSecretIds = String(process.env.SPINE_SECRET_ROTATION_SECRET_IDS || "")
        .split(",")
        .map((x) => String(x || "").trim())
        .filter(Boolean)
        .join(",");
      const secretRotationTimeoutMs = Math.max(
        5000,
        Math.min(5 * 60 * 1000, Number(process.env.SPINE_SECRET_ROTATION_CHECK_TIMEOUT_MS || 45000) || 45000)
      );
      const secretRotationArgs = ["systems/security/secret_broker.js", "rotation-check"];
      if (secretRotationPolicyPath) secretRotationArgs.push(`--policy=${secretRotationPolicyPath}`);
      if (secretRotationSecretIds) secretRotationArgs.push(`--secret-ids=${secretRotationSecretIds}`);
      if (secretRotationStrict) secretRotationArgs.push("--strict=1");
      const secretRotation = runJson("node", secretRotationArgs, { timeout: secretRotationTimeoutMs });
      const secretRotationPayload = secretRotation.payload && typeof secretRotation.payload === "object"
        ? secretRotation.payload
        : null;
      const secretRotationCounts = secretRotationPayload && secretRotationPayload.counts && typeof secretRotationPayload.counts === "object"
        ? secretRotationPayload.counts
        : null;
      const secretRotationOk = secretRotation.ok && !!secretRotationPayload && secretRotationPayload.ok === true;
      const secretRotationReason = !secretRotationOk
        ? String(
            (secretRotationPayload && secretRotationPayload.reason)
            || secretRotation.stderr
            || secretRotation.stdout
            || `secret_rotation_check_exit_${secretRotation.code}`
          ).slice(0, 180)
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_secret_rotation_check",
        mode,
        date: dateStr,
        ok: secretRotationOk,
        strict: secretRotationStrict,
        policy_path: secretRotationPolicyPath || null,
        level: secretRotationPayload ? secretRotationPayload.level || null : null,
        checked: secretRotationPayload ? Number(secretRotationPayload.checked || 0) : null,
        count_ok: secretRotationCounts ? Number(secretRotationCounts.ok || 0) : null,
        count_warn: secretRotationCounts ? Number(secretRotationCounts.warn || 0) : null,
        count_critical: secretRotationCounts ? Number(secretRotationCounts.critical || 0) : null,
        count_unknown: secretRotationCounts ? Number(secretRotationCounts.unknown || 0) : null,
        reason: secretRotationReason
      });
      if (secretRotationOk) {
        console.log(
          ` secret_rotation_check ok checked=${Number(secretRotationPayload && secretRotationPayload.checked || 0)}` +
          ` warn=${Number(secretRotationCounts && secretRotationCounts.warn || 0)}` +
          ` critical=${Number(secretRotationCounts && secretRotationCounts.critical || 0)}`
        );
      } else {
        console.log(` secret_rotation_check unavailable reason=${String(secretRotationReason || "unknown").slice(0, 120)}`);
        if (secretRotationStrict) process.exit(secretRotation.code || 1);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_secret_rotation_check_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_SECRET_ROTATION_CHECK_ENABLED",
        flag_value: String(process.env.SPINE_SECRET_ROTATION_CHECK_ENABLED || "")
      });
      console.log(" secret_rotation_check skipped reason=feature_flag_disabled flag=SPINE_SECRET_ROTATION_CHECK_ENABLED");
    }

    if (String(process.env.SPINE_RED_TEAM_RUN_ENABLED || "1") !== "0") {
      const redTeamArgs = ["systems/autonomy/red_team_harness.js", "run", dateStr];
      const redMaxCasesRaw = Number(process.env.SPINE_RED_TEAM_MAX_CASES || "");
      if (Number.isFinite(redMaxCasesRaw) && redMaxCasesRaw > 0) {
        redTeamArgs.push(`--max-cases=${Math.max(1, Math.min(64, Math.floor(redMaxCasesRaw)))}`);
      }
      const redRunStrict = String(process.env.SPINE_RED_TEAM_RUN_STRICT || "0") === "1";
      if (redRunStrict) redTeamArgs.push("--strict");
      const redRunTimeoutMs = Math.max(
        5000,
        Math.min(10 * 60 * 1000, Number(process.env.SPINE_RED_TEAM_RUN_TIMEOUT_MS || 180000) || 180000)
      );
      const redTeamRun = runJson("node", redTeamArgs, { timeout: redRunTimeoutMs });
      const redTeamPayload = redTeamRun.payload && typeof redTeamRun.payload === "object"
        ? redTeamRun.payload
        : null;
      const redTeamOk = redTeamRun.ok && !!redTeamPayload && redTeamPayload.ok === true;
      const redSummary = redTeamPayload && redTeamPayload.summary && typeof redTeamPayload.summary === "object"
        ? redTeamPayload.summary
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_red_team_run",
        mode,
        date: dateStr,
        ok: redTeamOk,
        strict: redRunStrict,
        selected_cases: redSummary ? Number(redSummary.selected_cases || 0) : null,
        executed_cases: redSummary ? Number(redSummary.executed_cases || 0) : null,
        skipped_cases: redSummary ? Number(redSummary.skipped_cases || 0) : null,
        pass_cases: redSummary ? Number(redSummary.pass_cases || 0) : null,
        fail_cases: redSummary ? Number(redSummary.fail_cases || 0) : null,
        critical_fail_cases: redSummary ? Number(redSummary.critical_fail_cases || 0) : null,
        model_available: redTeamPayload && redTeamPayload.model
          ? redTeamPayload.model.available === true
          : null,
        model_reason: redTeamPayload && redTeamPayload.model
          ? redTeamPayload.model.reason || null
          : null,
        run_path: redTeamPayload ? redTeamPayload.run_path || null : null,
        reason: !redTeamOk
          ? String(redTeamRun.stderr || redTeamRun.stdout || `red_team_run_exit_${redTeamRun.code}`).slice(0, 180)
          : null
      });
      if (redTeamOk) {
        console.log(
          ` red_team_run ok executed=${Number(redSummary && redSummary.executed_cases || 0)}` +
          ` pass=${Number(redSummary && redSummary.pass_cases || 0)}` +
          ` fail=${Number(redSummary && redSummary.fail_cases || 0)}` +
          ` critical_fail=${Number(redSummary && redSummary.critical_fail_cases || 0)}`
        );
      } else {
        console.log(` red_team_run unavailable reason=${String(redTeamRun.stderr || redTeamRun.stdout || "unknown").slice(0, 120)}`);
        if (redRunStrict) process.exit(redTeamRun.code || 1);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_red_team_run_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_RED_TEAM_RUN_ENABLED",
        flag_value: String(process.env.SPINE_RED_TEAM_RUN_ENABLED || "")
      });
      console.log(" red_team_run skipped reason=feature_flag_disabled flag=SPINE_RED_TEAM_RUN_ENABLED");
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

    // 0c) inversion controller (shadow-first) for impossible-task paradigm pivots.
    if (String(process.env.SPINE_INVERSION_ENABLED || "1") !== "0") {
      const inversionObjective = String(
        process.env.SPINE_INVERSION_OBJECTIVE
        || "impossible_task_probe"
      ).trim() || "impossible_task_probe";
      const inversionImpact = String(process.env.SPINE_INVERSION_IMPACT || "medium").trim().toLowerCase() || "medium";
      const inversionTarget = String(process.env.SPINE_INVERSION_TARGET || "belief").trim().toLowerCase() || "belief";
      const inversionCertainty = Math.max(
        0,
        Math.min(1, Number(process.env.SPINE_INVERSION_CERTAINTY || 0.7) || 0.7)
      );
      const inversionMode = String(process.env.SPINE_INVERSION_MODE || "live").trim().toLowerCase() === "test"
        ? "test"
        : "live";
      const inversionApply = String(process.env.SPINE_INVERSION_APPLY || "0") !== "0" ? "1" : "0";
      const inversionArgs = [
        "systems/autonomy/inversion_controller.js",
        "run",
        `--objective=${inversionObjective}`,
        `--impact=${inversionImpact}`,
        `--target=${inversionTarget}`,
        `--certainty=${Number(inversionCertainty.toFixed(6))}`,
        `--mode=${inversionMode}`,
        `--apply=${inversionApply}`
      ];
      const inversionPolicyPath = String(process.env.SPINE_INVERSION_POLICY_PATH || "").trim();
      if (inversionPolicyPath) inversionArgs.push(`--policy=${inversionPolicyPath}`);
      if (String(process.env.SPINE_INVERSION_ALLOW_CONSTITUTION_TEST || "0") === "1") {
        inversionArgs.push("--allow-constitution-test=1");
      }
      const inversion = runJson("node", inversionArgs);
      const payload = inversion.payload && typeof inversion.payload === "object"
        ? inversion.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_inversion_controller",
        mode,
        date: dateStr,
        ok: inversion.ok && !!payload && payload.ok === true,
        allowed: payload ? payload.allowed === true : null,
        run_mode: payload ? payload.mode || inversionMode : inversionMode,
        target: payload && payload.input ? payload.input.target || inversionTarget : inversionTarget,
        impact: payload && payload.input ? payload.input.impact || inversionImpact : inversionImpact,
        certainty_effective: payload && payload.input
          ? Number(payload.input.effective_certainty || 0)
          : null,
        maturity_band: payload && payload.maturity
          ? payload.maturity.band || null
          : null,
        reasons: payload && Array.isArray(payload.reasons)
          ? payload.reasons.slice(0, 8)
          : [],
        session_id: payload && payload.session
          ? payload.session.session_id || null
          : null,
        reason: (!inversion.ok || !payload || payload.ok !== true)
          ? String(inversion.stderr || inversion.stdout || `inversion_controller_exit_${inversion.code}`).slice(0, 180)
          : null
      });
      if (inversion.ok && payload && payload.ok === true) {
        console.log(
          ` inversion_controller allowed=${payload.allowed === true ? "yes" : "no"}` +
          ` target=${String(payload.input && payload.input.target || inversionTarget)}` +
          ` maturity=${String(payload.maturity && payload.maturity.band || "unknown")}`
        );
      } else {
        console.log(` inversion_controller unavailable reason=${String(inversion.stderr || inversion.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_inversion_controller_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_INVERSION_ENABLED",
        flag_value: String(process.env.SPINE_INVERSION_ENABLED || "")
      });
      console.log(" inversion_controller skipped reason=feature_flag_disabled flag=SPINE_INVERSION_ENABLED");
    }

    // 0d) strategy principle extraction for downstream workflow generation quality.
    if (String(process.env.SPINE_STRATEGY_PRINCIPLES_ENABLED || "1") !== "0") {
      const principles = runJson("node", [
        "systems/strategy/strategy_principles.js",
        "run",
        dateStr
      ]);
      const payload = principles.payload && typeof principles.payload === "object"
        ? principles.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_strategy_principles",
        mode,
        date: dateStr,
        ok: principles.ok && !!payload && payload.ok === true,
        strategy_id: payload ? payload.strategy_id || null : null,
        score: payload ? Number(payload.score || 0) : null,
        band: payload ? payload.band || null : null,
        checks_failed: payload ? Number(payload.checks_failed || 0) : null,
        output_path: payload ? payload.output_path || null : null,
        reason: (!principles.ok || !payload || payload.ok !== true)
          ? String(principles.stderr || principles.stdout || `strategy_principles_exit_${principles.code}`).slice(0, 180)
          : null
      });
      if (principles.ok && payload && payload.ok === true) {
        console.log(
          ` strategy_principles score=${Number(payload.score || 0)}` +
          ` band=${String(payload.band || "unknown")}`
        );
      } else {
        console.log(` strategy_principles unavailable reason=${String(principles.stderr || principles.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_strategy_principles_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_STRATEGY_PRINCIPLES_ENABLED",
        flag_value: String(process.env.SPINE_STRATEGY_PRINCIPLES_ENABLED || "")
      });
      console.log(" strategy_principles skipped reason=feature_flag_disabled flag=SPINE_STRATEGY_PRINCIPLES_ENABLED");
    }

    // 0d) adaptive workflow layer run (draft generation + optional registry apply).
    if (String(process.env.SPINE_WORKFLOW_LAYER_ENABLED || "1") !== "0") {
      const workflowDays = Math.max(1, Number(process.env.SPINE_WORKFLOW_LAYER_DAYS || 14) || 14);
      const workflowMax = Math.max(1, Number(process.env.SPINE_WORKFLOW_LAYER_MAX || 8) || 8);
      const workflowApply = String(process.env.SPINE_WORKFLOW_LAYER_APPLY || "1") !== "0" ? "1" : "0";
      const workflowOrchestronEnabled = String(process.env.SPINE_WORKFLOW_ORCHESTRON_ENABLED || "1") !== "0" ? "1" : "0";
      const workflowOrchestronApply = String(process.env.SPINE_WORKFLOW_ORCHESTRON_APPLY || "1") !== "0" ? "1" : "0";
      const workflowOrchestronAuto = String(process.env.SPINE_WORKFLOW_ORCHESTRON_AUTO || "1") !== "0" ? "1" : "0";
      const workflow = runJson("node", [
        "systems/workflow/orchestron_controller.js",
        "run",
        dateStr,
        `--days=${workflowDays}`,
        `--max=${workflowMax}`,
        `--apply=${workflowApply}`,
        `--orchestron=${workflowOrchestronEnabled}`,
        `--orchestron-apply=${workflowOrchestronApply}`,
        `--orchestron-auto=${workflowOrchestronAuto}`
      ]);
      const payload = workflow.payload && typeof workflow.payload === "object"
        ? workflow.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_workflow_layer",
        mode,
        date: dateStr,
        ok: workflow.ok && !!payload && payload.ok === true,
        apply: payload ? payload.apply === true : null,
        drafts: payload ? Number(payload.drafts || 0) : null,
        baseline_drafts: payload ? Number(payload.baseline_drafts || 0) : null,
        orchestron_drafts: payload ? Number(payload.orchestron_drafts || 0) : null,
        orchestron_promotable_drafts: payload ? Number(payload.orchestron_promotable_drafts || 0) : null,
        orchestron_auto_enabled: payload ? payload.orchestron_auto_enabled === true : null,
        orchestron_auto_pass: payload ? payload.orchestron_auto_pass === true : null,
        orchestron_auto_reasons: payload ? payload.orchestron_auto_reasons || [] : [],
        orchestron_apply_effective: payload ? payload.orchestron_apply_effective === true : null,
        applied: payload ? Number(payload.applied || 0) : null,
        updated: payload ? Number(payload.updated || 0) : null,
        registry_total: payload ? Number(payload.registry_total || 0) : null,
        registry_path: payload ? payload.registry_path || null : null,
        reason: (!workflow.ok || !payload || payload.ok !== true)
          ? String(workflow.stderr || workflow.stdout || `workflow_layer_exit_${workflow.code}`).slice(0, 180)
          : null
      });
      if (workflow.ok && payload && payload.ok === true) {
        console.log(
          ` workflow_layer drafts=${Number(payload.drafts || 0)}` +
          ` auto=${payload.orchestron_auto_pass === true ? "pass" : "block"}` +
          ` applied=${Number(payload.applied || 0)}` +
          ` registry=${Number(payload.registry_total || 0)}`
        );
      } else {
        const reason = String(workflow.stderr || workflow.stdout || "unknown").slice(0, 180);
        console.log(` workflow_layer unavailable reason=${String(reason).slice(0, 120)}`);
        appendSystemHealthEvent({
          severity: "high",
          risk: "high",
          code: "workflow_layer_unavailable",
          summary: `spine workflow layer unavailable (${reason.slice(0, 120)})`,
          details: reason,
          date: dateStr,
          mode
        });
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_workflow_layer_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_WORKFLOW_LAYER_ENABLED",
        flag_value: String(process.env.SPINE_WORKFLOW_LAYER_ENABLED || "")
      });
      console.log(" workflow_layer skipped reason=feature_flag_disabled flag=SPINE_WORKFLOW_LAYER_ENABLED");
      appendSystemHealthEvent({
        severity: "low",
        risk: "low",
        code: "workflow_layer_disabled",
        summary: "spine workflow layer disabled by feature flag",
        date: dateStr,
        mode,
        flag: "SPINE_WORKFLOW_LAYER_ENABLED",
        flag_value: String(process.env.SPINE_WORKFLOW_LAYER_ENABLED || "")
      });
    }

    // 0d2) optional workflow executor runtime (runs active workflow steps).
    if (String(process.env.SPINE_WORKFLOW_EXECUTOR_ENABLED || "1") !== "0") {
      const workflowExecMax = Math.max(1, Number(process.env.SPINE_WORKFLOW_EXECUTOR_MAX || 6) || 6);
      const workflowExecDryRun = String(process.env.SPINE_WORKFLOW_EXECUTOR_DRY_RUN || "0") !== "0" ? "1" : "0";
      const workflowExecContinue = String(process.env.SPINE_WORKFLOW_EXECUTOR_CONTINUE_ON_ERROR || "0") !== "0" ? "1" : "0";
      const workflowExecReceiptStrict = String(process.env.SPINE_WORKFLOW_EXECUTOR_RECEIPT_STRICT || "1") !== "0" ? "1" : "0";
      const workflowExecEligibility = String(process.env.SPINE_WORKFLOW_EXECUTOR_ENFORCE_ELIGIBILITY || "1") !== "0" ? "1" : "0";
      const workflowExec = runJson("node", [
        "systems/workflow/workflow_executor.js",
        "run",
        dateStr,
        `--max=${workflowExecMax}`,
        `--dry-run=${workflowExecDryRun}`,
        `--continue-on-error=${workflowExecContinue}`,
        `--receipt-strict=${workflowExecReceiptStrict}`,
        `--enforce-eligibility=${workflowExecEligibility}`
      ]);
      const payload = workflowExec.payload && typeof workflowExec.payload === "object"
        ? workflowExec.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_workflow_executor",
        mode,
        date: dateStr,
        ok: workflowExec.ok && !!payload && payload.ok === true,
        dry_run: payload ? payload.dry_run === true : null,
        workflows_selected: payload ? Number(payload.workflows_selected || 0) : null,
        workflows_executed: payload ? Number(payload.workflows_executed || 0) : null,
        workflows_succeeded: payload ? Number(payload.workflows_succeeded || 0) : null,
        workflows_failed: payload ? Number(payload.workflows_failed || 0) : null,
        workflows_blocked: payload ? Number(payload.workflows_blocked || 0) : null,
        workflows_excluded: payload ? Number(payload.workflows_excluded || 0) : null,
        rollout_stage: payload ? payload.rollout_stage || null : null,
        rollout_canary_fraction: payload ? Number(payload.rollout_canary_fraction || 0) : null,
        rollout_last_scale_action: payload && payload.rollout_state_after
          ? payload.rollout_state_after.last_scale_action || null
          : null,
        execution_success_rate: payload && payload.slo && payload.slo.measured
          ? Number(payload.slo.measured.execution_success_rate || 0)
          : null,
        queue_drain_rate: payload && payload.slo && payload.slo.measured
          ? Number(payload.slo.measured.queue_drain_rate || 0)
          : null,
        time_to_first_execution_ms: payload && payload.slo && payload.slo.measured
          ? payload.slo.measured.time_to_first_execution_ms
          : null,
        slo_pass: payload && payload.slo ? payload.slo.pass === true : null,
        slo_window_pass: payload && payload.slo_window ? payload.slo_window.pass === true : null,
        slo_window_sufficient_data: payload && payload.slo_window ? payload.slo_window.sufficient_data === true : null,
        run_path: payload ? payload.run_path || null : null,
        reason: (!workflowExec.ok || !payload || payload.ok !== true)
          ? String(workflowExec.stderr || workflowExec.stdout || `workflow_executor_exit_${workflowExec.code}`).slice(0, 180)
          : null
      });
      if (workflowExec.ok && payload && payload.ok === true) {
        console.log(
          ` workflow_executor selected=${Number(payload.workflows_selected || 0)}` +
          ` executed=${Number(payload.workflows_executed || 0)}` +
          ` failed=${Number(payload.workflows_failed || 0)}` +
          ` stage=${String(payload.rollout_stage || "unknown")}` +
          ` slo=${payload.slo && payload.slo.pass === true ? "green" : "red"}`
        );
        const execFailed = Number(payload.workflows_failed || 0);
        const execBlocked = Number(payload.workflows_blocked || 0);
        const sloPass = !!(payload.slo && payload.slo.pass === true);
        if (execFailed > 0 || execBlocked > 0 || !sloPass) {
          appendSystemHealthEvent({
            severity: execFailed > 0 ? "high" : "medium",
            risk: execFailed > 0 ? "high" : "medium",
            code: execBlocked > 0 ? "workflow_executor_blocked" : "workflow_executor_degraded",
            summary: `spine workflow executor degraded fail=${execFailed} blocked=${execBlocked} slo=${sloPass ? "pass" : "fail"}`,
            date: dateStr,
            mode,
            workflows_selected: Number(payload.workflows_selected || 0),
            workflows_executed: Number(payload.workflows_executed || 0),
            workflows_succeeded: Number(payload.workflows_succeeded || 0),
            workflows_failed: execFailed,
            workflows_blocked: execBlocked,
            failure_reasons: payload.failure_reasons || {}
          });
        }
      } else {
        const reason = String(workflowExec.stderr || workflowExec.stdout || "unknown").slice(0, 180);
        console.log(` workflow_executor unavailable reason=${String(reason).slice(0, 120)}`);
        appendSystemHealthEvent({
          severity: "high",
          risk: "high",
          code: "workflow_executor_unavailable",
          summary: `spine workflow executor unavailable (${reason.slice(0, 120)})`,
          details: reason,
          date: dateStr,
          mode
        });
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_workflow_executor_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_WORKFLOW_EXECUTOR_ENABLED",
        flag_value: String(process.env.SPINE_WORKFLOW_EXECUTOR_ENABLED || "")
      });
      console.log(" workflow_executor skipped reason=feature_flag_disabled flag=SPINE_WORKFLOW_EXECUTOR_ENABLED");
      appendSystemHealthEvent({
        severity: "medium",
        risk: "medium",
        code: "workflow_executor_disabled",
        summary: "spine workflow executor disabled by feature flag",
        date: dateStr,
        mode,
        flag: "SPINE_WORKFLOW_EXECUTOR_ENABLED",
        flag_value: String(process.env.SPINE_WORKFLOW_EXECUTOR_ENABLED || "")
      });
    }

    if (String(process.env.SPINE_WORKFLOW_EXECUTION_CLOSURE_ENABLED || "1") !== "0") {
      const closureLookbackDays = Math.max(
        7,
        Number(process.env.SPINE_WORKFLOW_EXECUTION_CLOSURE_LOOKBACK_DAYS || 21) || 21
      );
      const closureTargetDays = Math.max(
        1,
        Number(process.env.SPINE_WORKFLOW_EXECUTION_CLOSURE_TARGET_DAYS || 7) || 7
      );
      const closureMinAccepted = Math.max(
        0,
        Number(process.env.SPINE_WORKFLOW_EXECUTION_CLOSURE_MIN_ACCEPTED || 1) || 1
      );
      const closureMinExecuted = Math.max(
        0,
        Number(process.env.SPINE_WORKFLOW_EXECUTION_CLOSURE_MIN_EXECUTED || 1) || 1
      );
      const closureMinSucceeded = Math.max(
        0,
        Number(process.env.SPINE_WORKFLOW_EXECUTION_CLOSURE_MIN_SUCCEEDED || 1) || 1
      );
      const closureMinSuccessRatio = Math.max(
        0,
        Math.min(
          1,
          Number(process.env.SPINE_WORKFLOW_EXECUTION_CLOSURE_MIN_SUCCESS_RATIO || 0.5) || 0.5
        )
      );
      const closure = runJson("node", [
        "systems/ops/workflow_execution_closure.js",
        "run",
        dateStr,
        `--days=${closureLookbackDays}`,
        `--target-days=${closureTargetDays}`,
        `--min-accepted=${closureMinAccepted}`,
        `--min-workflows=${closureMinExecuted}`,
        `--min-succeeded=${closureMinSucceeded}`,
        `--min-success-ratio=${closureMinSuccessRatio}`
      ]);
      const payload = closure.payload && typeof closure.payload === "object"
        ? closure.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_workflow_execution_closure",
        mode,
        date: dateStr,
        ok: closure.ok && !!payload && payload.ok === true,
        closure_pass: payload ? payload.closure_pass === true : null,
        result: payload ? payload.result || null : null,
        consecutive_days_passed: payload ? Number(payload.consecutive_days_passed || 0) : null,
        target_streak_days: payload ? Number(payload.target_streak_days || 0) : null,
        remaining_days: payload ? Number(payload.remaining_days || 0) : null,
        latest_day_pass: payload && payload.latest_day ? payload.latest_day.pass === true : null,
        latest_day_accepted_items: payload && payload.latest_day ? Number(payload.latest_day.accepted_items || 0) : null,
        latest_day_workflows_executed: payload && payload.latest_day ? Number(payload.latest_day.workflows_executed || 0) : null,
        min_workflows_succeeded: payload ? Number(payload.min_workflows_succeeded || 0) : null,
        min_success_ratio: payload ? Number(payload.min_success_ratio || 0) : null,
        reason: (!closure.ok || !payload || payload.ok !== true)
          ? String(closure.stderr || closure.stdout || `workflow_execution_closure_exit_${closure.code}`).slice(0, 180)
          : null
      });
      if (closure.ok && payload && payload.ok === true) {
        console.log(
          ` workflow_execution_closure streak=${Number(payload.consecutive_days_passed || 0)}` +
          `/${Number(payload.target_streak_days || 0)}` +
          ` latest=${payload.latest_day && payload.latest_day.pass === true ? "pass" : "fail"}`
        );
      } else {
        console.log(` workflow_execution_closure WARN reason=${String(closure.stderr || closure.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_workflow_execution_closure_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_WORKFLOW_EXECUTION_CLOSURE_ENABLED",
        flag_value: String(process.env.SPINE_WORKFLOW_EXECUTION_CLOSURE_ENABLED || "")
      });
      console.log(" workflow_execution_closure skipped reason=feature_flag_disabled flag=SPINE_WORKFLOW_EXECUTION_CLOSURE_ENABLED");
    }

    if (String(process.env.SPINE_EXECUTION_RELIABILITY_SLO_ENABLED || "1") !== "0") {
      const reliabilityWindowDays = Math.max(
        7,
        Number(process.env.SPINE_EXECUTION_RELIABILITY_WINDOW_DAYS || 30) || 30
      );
      const reliability = runJson("node", [
        "systems/ops/execution_reliability_slo.js",
        "run",
        dateStr,
        `--window-days=${reliabilityWindowDays}`
      ]);
      const payload = reliability.payload && typeof reliability.payload === "object"
        ? reliability.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_execution_reliability_slo",
        mode,
        date: dateStr,
        ok: reliability.ok && !!payload && payload.ok === true,
        pass: payload ? payload.pass === true : null,
        result: payload ? payload.result || null : null,
        window_days: payload ? Number(payload.window_days || 0) : null,
        live_runs: payload ? Number(payload.live_runs || 0) : null,
        execution_success_rate: payload && payload.measured
          ? Number(payload.measured.execution_success_rate || 0)
          : null,
        queue_drain_rate: payload && payload.measured
          ? Number(payload.measured.queue_drain_rate || 0)
          : null,
        time_to_first_execution_p95_ms: payload && payload.measured
          ? payload.measured.time_to_first_execution_p95_ms
          : null,
        zero_shipped_streak_days: payload && payload.measured
          ? Number(payload.measured.zero_shipped_streak_days || 0)
          : null,
        reason: (!reliability.ok || !payload || payload.ok !== true)
          ? String(reliability.stderr || reliability.stdout || `execution_reliability_slo_exit_${reliability.code}`).slice(0, 180)
          : null
      });
      if (reliability.ok && payload && payload.ok === true) {
        console.log(
          ` execution_reliability pass=${payload.pass === true ? "yes" : "no"}` +
          ` success=${Number(payload.measured && payload.measured.execution_success_rate || 0).toFixed(3)}` +
          ` drain=${Number(payload.measured && payload.measured.queue_drain_rate || 0).toFixed(3)}` +
          ` ttf_p95=${Number(payload.measured && payload.measured.time_to_first_execution_p95_ms || 0)}` +
          ` zero_ship=${Number(payload.measured && payload.measured.zero_shipped_streak_days || 0)}`
        );
        if (payload.pass !== true) {
          appendSystemHealthEvent({
            severity: "high",
            risk: "high",
            code: "execution_reliability_slo_fail",
            summary: `execution reliability slo fail (${String(payload.result || "fail")})`,
            date: dateStr,
            mode,
            window_days: Number(payload.window_days || 0),
            live_runs: Number(payload.live_runs || 0),
            measured: payload.measured || {},
            checks: payload.checks || {}
          });
        }
      } else {
        console.log(` execution_reliability WARN reason=${String(reliability.stderr || reliability.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_execution_reliability_slo_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_EXECUTION_RELIABILITY_SLO_ENABLED",
        flag_value: String(process.env.SPINE_EXECUTION_RELIABILITY_SLO_ENABLED || "")
      });
      console.log(" execution_reliability skipped reason=feature_flag_disabled flag=SPINE_EXECUTION_RELIABILITY_SLO_ENABLED");
    }

    if (String(process.env.SPINE_CI_BASELINE_GUARD_ENABLED || "1") !== "0") {
      const ciTargetDays = Math.max(1, Number(process.env.SPINE_CI_BASELINE_TARGET_DAYS || 7) || 7);
      const ciGuard = runJson("node", [
        "systems/ops/ci_baseline_guard.js",
        "run",
        dateStr,
        `--target-days=${ciTargetDays}`
      ]);
      const payload = ciGuard.payload && typeof ciGuard.payload === "object"
        ? ciGuard.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_ci_baseline_guard",
        mode,
        date: dateStr,
        ok: ciGuard.ok && !!payload && payload.ok === true,
        pass: payload ? payload.pass === true : null,
        result: payload ? payload.result || null : null,
        streak: payload ? Number(payload.streak || 0) : null,
        target_days: payload ? Number(payload.target_days || 0) : null,
        latest_run_date: payload ? payload.latest_run_date || null : null,
        latest_run_ok: payload ? payload.latest_run_ok === true : null,
        latest_run_lag_days: payload ? payload.latest_run_lag_days : null,
        reason: (!ciGuard.ok || !payload || payload.ok !== true)
          ? String(ciGuard.stderr || ciGuard.stdout || `ci_baseline_guard_exit_${ciGuard.code}`).slice(0, 180)
          : null
      });
      if (ciGuard.ok && payload && payload.ok === true) {
        console.log(
          ` ci_baseline_guard pass=${payload.pass === true ? "yes" : "no"}` +
          ` streak=${Number(payload.streak || 0)}/${Number(payload.target_days || 0)}` +
          ` latest_ok=${payload.latest_run_ok === true ? "yes" : "no"}`
        );
        const stale = !!(payload.checks && payload.checks.latest_run_fresh === false);
        const latestRunFailed = !!(payload.checks && payload.checks.latest_run_green === false);
        if (stale || latestRunFailed) {
          appendSystemHealthEvent({
            severity: stale ? "high" : "medium",
            risk: stale ? "high" : "medium",
            code: stale ? "ci_baseline_stale" : "ci_baseline_latest_run_fail",
            summary: stale
              ? "ci baseline streak is stale"
              : "ci baseline latest run is not green",
            date: dateStr,
            mode,
            streak: Number(payload.streak || 0),
            target_days: Number(payload.target_days || 0),
            latest_run_date: payload.latest_run_date || null,
            latest_run_lag_days: payload.latest_run_lag_days
          });
        }
      } else {
        console.log(` ci_baseline_guard WARN reason=${String(ciGuard.stderr || ciGuard.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_ci_baseline_guard_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_CI_BASELINE_GUARD_ENABLED",
        flag_value: String(process.env.SPINE_CI_BASELINE_GUARD_ENABLED || "")
      });
      console.log(" ci_baseline_guard skipped reason=feature_flag_disabled flag=SPINE_CI_BASELINE_GUARD_ENABLED");
    }

    if (String(process.env.SPINE_ALERT_TRANSPORT_HEALTH_ENABLED || "1") !== "0") {
      const probeId = `${String(dateStr || "").slice(0, 10)}T00`;
      const probe = runJson("node", [
        "systems/ops/alert_transport_health.js",
        "run",
        `--probe-id=${probeId}`
      ]);
      const payload = probe.payload && typeof probe.payload === "object"
        ? probe.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_alert_transport_health",
        mode,
        date: dateStr,
        ok: probe.ok && !!payload && payload.ok === true,
        pass: payload ? payload.pass === true : null,
        deduped: payload ? payload.deduped === true : null,
        delivered: payload ? payload.delivered === true : null,
        delivered_via: payload ? payload.delivered_via || null : null,
        success_rate: payload && payload.rolling
          ? Number(payload.rolling.success_rate || 0)
          : null,
        target_success_rate: payload ? Number(payload.target_success_rate || 0) : null,
        reason: (!probe.ok || !payload || payload.ok !== true)
          ? String(probe.stderr || probe.stdout || `alert_transport_health_exit_${probe.code}`).slice(0, 180)
          : null
      });
      if (probe.ok && payload && payload.ok === true) {
        console.log(
          ` alert_transport_health pass=${payload.pass === true ? "yes" : "no"}` +
          ` delivered=${payload.delivered === true ? "yes" : "no"}` +
          ` rate=${Number(payload.rolling && payload.rolling.success_rate || 0).toFixed(3)}` +
          ` via=${String(payload.delivered_via || "none")}`
        );
      } else {
        console.log(` alert_transport_health WARN reason=${String(probe.stderr || probe.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_alert_transport_health_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_ALERT_TRANSPORT_HEALTH_ENABLED",
        flag_value: String(process.env.SPINE_ALERT_TRANSPORT_HEALTH_ENABLED || "")
      });
      console.log(" alert_transport_health skipped reason=feature_flag_disabled flag=SPINE_ALERT_TRANSPORT_HEALTH_ENABLED");
    }

    if (String(process.env.SPINE_COMPLIANCE_RETENTION_UPLIFT_ENABLED || "1") !== "0") {
      const retentionArgs = ["systems/ops/compliance_retention_uplift.js", "run"];
      if (String(process.env.SPINE_COMPLIANCE_RETENTION_UPLIFT_APPLY || "1").trim() === "0") {
        retentionArgs.push("--apply=0");
      }
      retentionArgs.push("--strict=1");
      const retention = runJson("node", retentionArgs);
      const payload = retention.payload && typeof retention.payload === "object"
        ? retention.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_compliance_retention_uplift",
        mode,
        date: dateStr,
        ok: retention.ok && !!payload && payload.ok === true,
        pass: payload ? payload.pass === true : null,
        apply: payload ? payload.apply === true : null,
        scanned_files: payload ? Number(payload.scanned_files || 0) : null,
        hot_count: payload && payload.tiers ? Number(payload.tiers.hot || 0) : null,
        warm_count: payload && payload.tiers ? Number(payload.tiers.warm || 0) : null,
        cold_count: payload && payload.tiers ? Number(payload.tiers.cold || 0) : null,
        archive_count: payload && payload.tiers ? Number(payload.tiers.archive || 0) : null,
        moved_count: payload && payload.moved
          ? Number(payload.moved.warm || 0) + Number(payload.moved.cold || 0) + Number(payload.moved.archive || 0)
          : null,
        reason: (!retention.ok || !payload || payload.ok !== true)
          ? String(retention.stderr || retention.stdout || `compliance_retention_uplift_exit_${retention.code}`).slice(0, 180)
          : null
      });
      if (retention.ok && payload && payload.ok === true) {
        console.log(
          ` compliance_retention_uplift scanned=${Number(payload.scanned_files || 0)}` +
          ` moved=${Number((payload.moved && payload.moved.warm) || 0) + Number((payload.moved && payload.moved.cold) || 0) + Number((payload.moved && payload.moved.archive) || 0)}` +
          ` apply=${payload.apply === true ? "yes" : "no"}`
        );
      } else {
        console.log(` compliance_retention_uplift WARN reason=${String(retention.stderr || retention.stdout || "unknown").slice(0, 120)}`);
      }

      const shouldAttest = String(dateStr || "").slice(8, 10) === "01";
      if (shouldAttest && String(process.env.SPINE_COMPLIANCE_RETENTION_ATTEST_ENABLED || "1") !== "0") {
        const attest = runJson("node", [
          "systems/ops/compliance_retention_uplift.js",
          "attest",
          `--date=${dateStr}`
        ]);
        const attestPayload = attest.payload && typeof attest.payload === "object"
          ? attest.payload
          : null;
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_compliance_retention_attestation",
          mode,
          date: dateStr,
          ok: attest.ok && !!attestPayload && attestPayload.ok === true,
          month: attestPayload ? attestPayload.month || null : null,
          path: attestPayload ? attestPayload.path || null : null,
          digest_sha256: attestPayload ? attestPayload.digest_sha256 || null : null,
          reason: (!attest.ok || !attestPayload || attestPayload.ok !== true)
            ? String(attest.stderr || attest.stdout || `compliance_retention_attestation_exit_${attest.code}`).slice(0, 180)
            : null
        });
        if (attest.ok && attestPayload && attestPayload.ok === true) {
          console.log(
            ` compliance_retention_attestation ok` +
            ` month=${String(attestPayload.month || "unknown")}` +
            ` path=${String(attestPayload.path || "unknown")}`
          );
        } else {
          console.log(` compliance_retention_attestation WARN reason=${String(attest.stderr || attest.stdout || "unknown").slice(0, 120)}`);
        }
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_compliance_retention_uplift_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_COMPLIANCE_RETENTION_UPLIFT_ENABLED",
        flag_value: String(process.env.SPINE_COMPLIANCE_RETENTION_UPLIFT_ENABLED || "")
      });
      console.log(" compliance_retention_uplift skipped reason=feature_flag_disabled flag=SPINE_COMPLIANCE_RETENTION_UPLIFT_ENABLED");
    }

    if (String(process.env.SPINE_RM_PROGRESS_DASHBOARD_ENABLED || "1") !== "0") {
      const dashboard = runJson("node", [
        "systems/ops/rm_progress_dashboard.js",
        "run",
        dateStr
      ]);
      const payload = dashboard.payload && typeof dashboard.payload === "object"
        ? dashboard.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_rm_progress_dashboard",
        mode,
        date: dateStr,
        ok: dashboard.ok && !!payload && payload.ok === true,
        all_pass: payload && payload.status ? payload.status.all_pass === true : null,
        pass_ratio: payload && payload.status
          ? Number(payload.status.pass_ratio || 0)
          : null,
        blocked_count: payload && Array.isArray(payload.blocked_by)
          ? payload.blocked_by.length
          : null,
        blocked_by: payload && Array.isArray(payload.blocked_by)
          ? payload.blocked_by.slice(0, 12)
          : [],
        reason: (!dashboard.ok || !payload || payload.ok !== true)
          ? String(dashboard.stderr || dashboard.stdout || `rm_progress_dashboard_exit_${dashboard.code}`).slice(0, 180)
          : null
      });
      if (dashboard.ok && payload && payload.ok === true) {
        console.log(
          ` rm_progress_dashboard pass=${payload.status && payload.status.all_pass === true ? "yes" : "no"}` +
          ` ratio=${Number(payload.status && payload.status.pass_ratio || 0).toFixed(3)}` +
          ` blocked=${Array.isArray(payload.blocked_by) ? payload.blocked_by.length : 0}`
        );
      } else {
        console.log(` rm_progress_dashboard WARN reason=${String(dashboard.stderr || dashboard.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_rm_progress_dashboard_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_RM_PROGRESS_DASHBOARD_ENABLED",
        flag_value: String(process.env.SPINE_RM_PROGRESS_DASHBOARD_ENABLED || "")
      });
      console.log(" rm_progress_dashboard skipped reason=feature_flag_disabled flag=SPINE_RM_PROGRESS_DASHBOARD_ENABLED");
    }

    // 0e) claw registry status snapshot (actuation lane readiness visibility).
    if (String(process.env.SPINE_CLAW_REGISTRY_STATUS_ENABLED || "1") !== "0") {
      const claws = runJson("node", [
        "systems/actuation/claw_registry.js",
        "status"
      ]);
      const payload = claws.payload && typeof claws.payload === "object"
        ? claws.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_claw_registry_status",
        mode,
        date: dateStr,
        ok: claws.ok && !!payload && payload.ok === true,
        enabled: payload ? payload.enabled === true : null,
        default_lane: payload ? payload.default_lane || null : null,
        lane_count: payload ? Number(payload.lane_count || 0) : null,
        reason: (!claws.ok || !payload || payload.ok !== true)
          ? String(claws.stderr || claws.stdout || `claw_registry_status_exit_${claws.code}`).slice(0, 180)
          : null
      });
      if (claws.ok && payload && payload.ok === true) {
        console.log(
          ` claw_registry lanes=${Number(payload.lane_count || 0)}` +
          ` default=${String(payload.default_lane || "unknown")}`
        );
      } else {
        console.log(` claw_registry unavailable reason=${String(claws.stderr || claws.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_claw_registry_status_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_CLAW_REGISTRY_STATUS_ENABLED",
        flag_value: String(process.env.SPINE_CLAW_REGISTRY_STATUS_ENABLED || "")
      });
      console.log(" claw_registry skipped reason=feature_flag_disabled flag=SPINE_CLAW_REGISTRY_STATUS_ENABLED");
    }

    // 0f) optional public benchmark snapshot for reproducible external reporting.
    if (String(process.env.SPINE_PUBLIC_BENCHMARK_ENABLED || "0") !== "0") {
      const benchmarkDays = Math.max(7, Number(process.env.SPINE_PUBLIC_BENCHMARK_DAYS || 180) || 180);
      const benchmark = runJson("node", [
        "systems/ops/public_benchmark_pack.js",
        "run",
        dateStr,
        `--days=${benchmarkDays}`
      ], {
        RED_TEAM_DISABLE_MODEL_EXEC: process.env.RED_TEAM_DISABLE_MODEL_EXEC || "1"
      });
      const payload = benchmark.payload && typeof benchmark.payload === "object"
        ? benchmark.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_public_benchmark",
        mode,
        date: dateStr,
        ok: benchmark.ok && !!payload && payload.ok === true,
        days: benchmarkDays,
        verdict: payload ? payload.verdict || null : null,
        drift_rate: payload ? Number(payload.drift_rate || 0) : null,
        yield_rate: payload ? Number(payload.yield_rate || 0) : null,
        red_team_critical_fail_cases: payload ? Number(payload.red_team_critical_fail_cases || 0) : null,
        output_path: payload ? payload.output_path || null : null,
        reason: (!benchmark.ok || !payload || payload.ok !== true)
          ? String(benchmark.stderr || benchmark.stdout || `public_benchmark_exit_${benchmark.code}`).slice(0, 180)
          : null
      });
      if (benchmark.ok && payload && payload.ok === true) {
        console.log(
          ` public_benchmark verdict=${String(payload.verdict || "unknown")}` +
          ` drift=${Number(payload.drift_rate || 0)}` +
          ` yield=${Number(payload.yield_rate || 0)}`
        );
      } else {
        console.log(` public_benchmark unavailable reason=${String(benchmark.stderr || benchmark.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_public_benchmark_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_PUBLIC_BENCHMARK_ENABLED",
        flag_value: String(process.env.SPINE_PUBLIC_BENCHMARK_ENABLED || "")
      });
      console.log(" public_benchmark skipped reason=feature_flag_disabled flag=SPINE_PUBLIC_BENCHMARK_ENABLED");
    }

    // 0g) optional compliance posture aggregation (SOC2 + integrity + packaging).
    if (String(process.env.SPINE_COMPLIANCE_POSTURE_ENABLED || "0") !== "0") {
      const postureDays = Math.max(1, Number(process.env.SPINE_COMPLIANCE_POSTURE_DAYS || 30) || 30);
      const postureProfile = String(process.env.SPINE_COMPLIANCE_POSTURE_PROFILE || "prod").trim() || "prod";
      const posture = runJson("node", [
        "systems/ops/compliance_posture.js",
        "run",
        `--days=${postureDays}`,
        `--profile=${postureProfile}`,
        "--strict=0"
      ]);
      const payload = posture.payload && typeof posture.payload === "object"
        ? posture.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_compliance_posture",
        mode,
        date: dateStr,
        ok: posture.ok && !!payload && payload.ok === true,
        days: postureDays,
        profile: postureProfile,
        verdict: payload ? payload.verdict || null : null,
        posture_score: payload ? Number(payload.posture_score || 0) : null,
        output_path: payload ? payload.output_path || null : null,
        reason: (!posture.ok || !payload || payload.ok !== true)
          ? String(posture.stderr || posture.stdout || `compliance_posture_exit_${posture.code}`).slice(0, 180)
          : null
      });
      if (posture.ok && payload && payload.ok === true) {
        console.log(
          ` compliance_posture verdict=${String(payload.verdict || "unknown")}` +
          ` score=${Number(payload.posture_score || 0)}`
        );
      } else {
        console.log(` compliance_posture unavailable reason=${String(posture.stderr || posture.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_compliance_posture_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_COMPLIANCE_POSTURE_ENABLED",
        flag_value: String(process.env.SPINE_COMPLIANCE_POSTURE_ENABLED || "")
      });
      console.log(" compliance_posture skipped reason=feature_flag_disabled flag=SPINE_COMPLIANCE_POSTURE_ENABLED");
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
      const observabilityEnabled = String(process.env.SPINE_OBSERVABILITY_ENABLED || "1") !== "0";
      const observabilityTraceEnabled = observabilityEnabled && String(process.env.SPINE_OBSERVABILITY_TRACE_ENABLED || "1") !== "0";
      const observabilityStrict = observabilityEnabled && String(process.env.SPINE_OBSERVABILITY_STRICT || "0") === "1";
      const observabilityAlertMinLevelRaw = String(process.env.SPINE_OBSERVABILITY_ALERT_MIN_LEVEL || "warn").trim().toLowerCase();
      const observabilityAlertMinLevel = ["ok", "warn", "critical"].includes(observabilityAlertMinLevelRaw)
        ? observabilityAlertMinLevelRaw
        : "warn";
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
          if (strict) process.exit(health.code || 1);
          continue;
        }
        console.log(
          ` autonomy_health ${runCfg.label}` +
          ` level=${String(slo.level || "ok")}` +
          ` warn=${warns}` +
          ` critical=${critical}` +
          ` alerts_written=${Number(payload.alerts && payload.alerts.written || 0)}`
        );
        if (observabilityEnabled) {
          const alertPath = payload && payload.alerts ? String(payload.alerts.path || "").trim() : "";
          const routerArgs = [
            "systems/observability/slo_alert_router.js",
            "route",
            dateStr,
            `--window=${runCfg.label}`,
            `--min-level=${observabilityAlertMinLevel}`
          ];
          if (alertPath) routerArgs.push(`--source=${alertPath}`);
          const routed = runJson("node", routerArgs);
          const routedPayload = routed.payload && typeof routed.payload === "object" ? routed.payload : null;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_observability_alert_routing",
            mode,
            date: dateStr,
            window: runCfg.label,
            ok: routed.ok && !!routedPayload && routedPayload.ok === true,
            min_level: observabilityAlertMinLevel,
            source_total: routedPayload ? Number(routedPayload.source_total || 0) : null,
            inspected: routedPayload ? Number(routedPayload.inspected || 0) : null,
            filtered_out: routedPayload ? Number(routedPayload.filtered_out || 0) : null,
            already_routed: routedPayload ? Number(routedPayload.already_routed || 0) : null,
            routed: routedPayload ? Number(routedPayload.routed || 0) : null,
            webhook_delivered: routedPayload ? Number(routedPayload.webhook_delivered || 0) : null,
            webhook_failed: routedPayload ? Number(routedPayload.webhook_failed || 0) : null,
            route_path: routedPayload ? routedPayload.routed_path || null : null,
            reason: (!routed.ok || !routedPayload || routedPayload.ok !== true)
              ? String(routed.stderr || routed.stdout || `observability_alert_router_exit_${routed.code}`).slice(0, 180)
              : null
          });
          if (routed.ok && routedPayload && routedPayload.ok === true) {
            console.log(
              ` observability_alert_route ${runCfg.label}` +
              ` routed=${Number(routedPayload.routed || 0)}` +
              ` deduped=${Number(routedPayload.already_routed || 0)}` +
              ` filtered=${Number(routedPayload.filtered_out || 0)}` +
              ` min_level=${observabilityAlertMinLevel}`
            );
          } else {
            console.log(` observability_alert_route ${runCfg.label} unavailable reason=${String(routed.stderr || routed.stdout || "unknown").slice(0, 120)}`);
            if (observabilityStrict) process.exit(routed.code || 1);
          }
        }
        if (observabilityTraceEnabled) {
          const traceAttrs = JSON.stringify({
            lane: "autonomy_health",
            window: runCfg.label,
            date: dateStr,
            level: String(slo.level || "unknown"),
            warn_count: warns,
            critical_count: critical
          });
          const traceStatus = critical > 0 ? "error" : (warns > 0 ? "warn" : "ok");
          const trace = runJson("node", [
            "systems/observability/trace_bridge.js",
            "span",
            `--name=spine.autonomy_health.${runCfg.label}`,
            `--status=${traceStatus}`,
            `--duration-ms=${Math.max(0, Number((health as any).duration_ms || 0))}`,
            "--component=spine",
            `--attrs-json=${traceAttrs}`
          ]);
          const tracePayload = trace.payload && typeof trace.payload === "object" ? trace.payload : null;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_observability_trace",
            mode,
            date: dateStr,
            window: runCfg.label,
            ok: trace.ok && !!tracePayload && tracePayload.ok === true,
            trace_name: tracePayload && tracePayload.span ? tracePayload.span.name || null : null,
            trace_status: tracePayload && tracePayload.span ? tracePayload.span.status || null : null,
            trace_duration_ms: tracePayload && tracePayload.span ? Number(tracePayload.span.duration_ms || 0) : null,
            reason: (!trace.ok || !tracePayload || tracePayload.ok !== true)
              ? String(trace.stderr || trace.stdout || `observability_trace_exit_${trace.code}`).slice(0, 180)
              : null
          });
          if ((!trace.ok || !tracePayload || tracePayload.ok !== true) && observabilityStrict) {
            process.exit(trace.code || 1);
          }
        }
        if (strict && critical > 0) {
          console.error(` autonomy_health ${runCfg.label} FAIL critical=${critical}`);
          process.exit(1);
        }
      }
      if (observabilityEnabled) {
        const metricsWindowRaw = String(process.env.SPINE_OBSERVABILITY_METRICS_WINDOW || "daily").trim().toLowerCase();
        const metricsWindow = metricsWindowRaw === "weekly" ? "weekly" : "daily";
        const metrics = runJson("node", [
          "systems/observability/metrics_exporter.js",
          "run",
          dateStr,
          `--window=${metricsWindow}`
        ]);
        const metricsPayload = metrics.payload && typeof metrics.payload === "object" ? metrics.payload : null;
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_observability_metrics",
          mode,
          date: dateStr,
          window: metricsWindow,
          ok: metrics.ok && !!metricsPayload && metricsPayload.ok === true,
          metrics_count: metricsPayload ? Number(metricsPayload.metrics_count || 0) : null,
          health_report_found: metricsPayload ? metricsPayload.health_report_found === true : null,
          output_prometheus_path: metricsPayload && metricsPayload.output ? metricsPayload.output.prometheus_path || null : null,
          output_snapshot_path: metricsPayload && metricsPayload.output ? metricsPayload.output.snapshot_path || null : null,
          reason: (!metrics.ok || !metricsPayload || metricsPayload.ok !== true)
            ? String(metrics.stderr || metrics.stdout || `observability_metrics_exit_${metrics.code}`).slice(0, 180)
            : null
        });
        if (metrics.ok && metricsPayload && metricsPayload.ok === true) {
          console.log(
            ` observability_metrics window=${metricsWindow}` +
            ` count=${Number(metricsPayload.metrics_count || 0)}` +
            ` health_report_found=${metricsPayload.health_report_found === true ? "1" : "0"}`
          );
        } else {
          console.log(` observability_metrics unavailable reason=${String(metrics.stderr || metrics.stdout || "unknown").slice(0, 120)}`);
          if (observabilityStrict) process.exit(metrics.code || 1);
        }
        if (observabilityTraceEnabled) {
          const metricsTrace = runJson("node", [
            "systems/observability/trace_bridge.js",
            "span",
            "--name=spine.observability.metrics_snapshot",
            `--status=${metrics.ok && metricsPayload && metricsPayload.ok === true ? "ok" : "error"}`,
            `--duration-ms=${Math.max(0, Number((metrics as any).duration_ms || 0))}`,
            "--component=spine",
            `--attrs-json=${JSON.stringify({ window: metricsWindow, date: dateStr })}`
          ]);
          const metricsTracePayload = metricsTrace.payload && typeof metricsTrace.payload === "object" ? metricsTrace.payload : null;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_observability_trace",
            mode,
            date: dateStr,
            window: metricsWindow,
            ok: metricsTrace.ok && !!metricsTracePayload && metricsTracePayload.ok === true,
            trace_name: metricsTracePayload && metricsTracePayload.span ? metricsTracePayload.span.name || null : null,
            trace_status: metricsTracePayload && metricsTracePayload.span ? metricsTracePayload.span.status || null : null,
            trace_duration_ms: metricsTracePayload && metricsTracePayload.span ? Number(metricsTracePayload.span.duration_ms || 0) : null,
            reason: (!metricsTrace.ok || !metricsTracePayload || metricsTracePayload.ok !== true)
              ? String(metricsTrace.stderr || metricsTrace.stdout || `observability_trace_exit_${metricsTrace.code}`).slice(0, 180)
              : null
          });
          if ((!metricsTrace.ok || !metricsTracePayload || metricsTracePayload.ok !== true) && observabilityStrict) {
            process.exit(metricsTrace.code || 1);
          }
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
        if (strict) process.exit(oracle.code || 1);
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
        kpi_execution_success_rate: payload && payload.kpi && payload.kpi.execution
          ? Number(payload.kpi.execution.success_rate || 0)
          : null,
        kpi_queue_open_count: payload && payload.kpi && payload.kpi.queue_health
          ? Number(payload.kpi.queue_health.open_count || 0)
          : null,
        kpi_health_level: payload && payload.kpi && payload.kpi.safety
          ? String(payload.kpi.safety.health_level || "")
          : null,
        reason: (!dashboard.ok || !payload || payload.ok !== true)
          ? String(dashboard.stderr || dashboard.stdout || `ops_dashboard_exit_${dashboard.code}`).slice(0, 180)
          : null
      });
      if (dashboard.ok && payload && payload.ok === true) {
        const totals = payload.summary && payload.summary.totals ? payload.summary.totals : {};
        const kpi = payload.kpi && typeof payload.kpi === "object" ? payload.kpi : {};
        const kpiExec = kpi.execution && typeof kpi.execution === "object" ? kpi.execution : {};
        const kpiQueue = kpi.queue_health && typeof kpi.queue_health === "object" ? kpi.queue_health : {};
        const kpiSafety = kpi.safety && typeof kpi.safety === "object" ? kpi.safety : {};
        console.log(
          ` ops_dashboard reports=${Number(payload.reports || 0)}` +
          ` failed_checks=${Number(totals.failed_checks || 0)}` +
          ` critical=${Number(totals.critical || 0)}` +
          ` warnings=${Number(totals.warnings || 0)}` +
          ` kpi_exec_success=${Number(kpiExec.success_rate || 0)}` +
          ` kpi_queue_open=${Number(kpiQueue.open_count || 0)}` +
          ` kpi_health=${String(kpiSafety.health_level || "unknown")}`
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

    if (String(process.env.SPINE_CONFIG_REGISTRY_ENABLED || "1") !== "0") {
      const applyAliases = String(process.env.SPINE_CONFIG_REGISTRY_APPLY_ALIASES || "1") === "1";
      const registry = runJson("node", [
        "systems/ops/config_registry.js",
        "run",
        `--apply-aliases=${applyAliases ? "1" : "0"}`
      ]);
      const payload = registry.payload && typeof registry.payload === "object" ? registry.payload : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_config_registry",
        mode,
        date: dateStr,
        ok: registry.ok && !!payload && payload.ok === true,
        apply_aliases: applyAliases,
        files_scanned: payload && payload.metrics ? Number(payload.metrics.files_scanned || 0) : null,
        invalid_json_files: payload && payload.metrics ? Number(payload.metrics.invalid_json_files || 0) : null,
        consolidation_candidate_groups: payload && payload.metrics
          ? Number(payload.metrics.consolidation_candidate_groups || 0)
          : null,
        aliases_total: payload ? Number(payload.aliases_total || 0) : null,
        aliases_synced: payload && payload.alias_sync ? Number(payload.alias_sync.synced || 0) : null,
        reason: (!registry.ok || !payload || payload.ok !== true)
          ? String(registry.stderr || registry.stdout || `config_registry_exit_${registry.code}`).slice(0, 180)
          : null
      });
      if (registry.ok && payload && payload.ok === true) {
        console.log(
          ` config_registry files=${Number(payload.metrics && payload.metrics.files_scanned || 0)}` +
          ` invalid=${Number(payload.metrics && payload.metrics.invalid_json_files || 0)}` +
          ` aliases_synced=${Number(payload.alias_sync && payload.alias_sync.synced || 0)}`
        );
      } else {
        console.log(` config_registry unavailable reason=${String(registry.stderr || registry.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_config_registry_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_CONFIG_REGISTRY_ENABLED",
        flag_value: String(process.env.SPINE_CONFIG_REGISTRY_ENABLED || "")
      });
      console.log(" config_registry skipped reason=feature_flag_disabled flag=SPINE_CONFIG_REGISTRY_ENABLED");
    }

    // 4e) Trit shadow divergence stability report (strategy/drift governors) + optional strict gate.
    if (String(process.env.SPINE_TRIT_SHADOW_REPORT_ENABLED || "1") !== "0") {
      const reportDays = Math.max(1, Number(process.env.SPINE_TRIT_SHADOW_REPORT_DAYS || 14) || 14);
      const strict = String(process.env.SPINE_TRIT_SHADOW_REPORT_STRICT || "0") === "1";
      const maxDivergenceRaw = String(process.env.SPINE_TRIT_SHADOW_MAX_DIVERGENCE_RATE || "").trim();
      const shadowArgs = ["systems/autonomy/trit_shadow_report.js", "run", dateStr, `--days=${reportDays}`];
      if (maxDivergenceRaw) shadowArgs.push(`--max-divergence-rate=${maxDivergenceRaw}`);
      const shadow = runJson("node", shadowArgs);
      const payload = shadow.payload && typeof shadow.payload === "object" ? shadow.payload : null;
      const summary = payload && payload.summary && typeof payload.summary === "object" ? payload.summary : {};
      const gate = summary && summary.gate && typeof summary.gate === "object" ? summary.gate : {};

      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_trit_shadow_report",
        mode,
        date: dateStr,
        ok: shadow.ok && !!payload && payload.ok === true,
        strict,
        status: payload ? String(summary.status || "unknown") : null,
        total_decisions: payload ? Number(summary.total_decisions || 0) : null,
        divergence_count: payload ? Number(summary.divergence_count || 0) : null,
        divergence_rate: payload ? Number(summary.divergence_rate || 0) : null,
        gate_enabled: payload ? gate.enabled === true : null,
        gate_pass: payload ? gate.pass !== false : null,
        gate_reason: payload ? String(gate.reason || "") : null,
        report_path: payload ? payload.report_path || null : null,
        reason: (!shadow.ok || !payload || payload.ok !== true)
          ? String(shadow.stderr || shadow.stdout || `trit_shadow_report_exit_${shadow.code}`).slice(0, 180)
          : null
      });

      if (shadow.ok && payload && payload.ok === true) {
        console.log(
          ` trit_shadow_report status=${String(summary.status || "unknown")}` +
          ` decisions=${Number(summary.total_decisions || 0)}` +
          ` divergence=${Number(summary.divergence_rate || 0)}` +
          ` gate=${gate.enabled === true ? (gate.pass === false ? "fail" : "pass") : "disabled"}`
        );
        try {
          const tritPolicy = loadTritShadowPolicy();
          const guardState = applyInfluenceGuardFromShadowReport(payload, tritPolicy);
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_trit_shadow_influence_guard",
            mode,
            date: dateStr,
            disabled: guardState && guardState.disabled === true,
            reason: guardState ? guardState.reason || null : null,
            disabled_until: guardState ? guardState.disabled_until || null : null
          });
          console.log(
            ` trit_shadow_guard disabled=${guardState && guardState.disabled === true ? "yes" : "no"}` +
            ` reason=${String(guardState && guardState.reason || "none")}`
          );
        } catch (guardErr) {
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_trit_shadow_influence_guard_unavailable",
            mode,
            date: dateStr,
            reason: String(guardErr && guardErr.message ? guardErr.message : guardErr || "unknown").slice(0, 180)
          });
          console.log(` trit_shadow_guard unavailable reason=${String(guardErr && guardErr.message ? guardErr.message : guardErr || "unknown").slice(0, 120)}`);
        }
      } else {
        console.log(` trit_shadow_report unavailable reason=${String(shadow.stderr || shadow.stdout || "unknown").slice(0, 120)}`);
      }

      if (String(process.env.SPINE_TRIT_SHADOW_CALIBRATION_ENABLED || "1") !== "0") {
        const calibrationDays = Math.max(7, Number(process.env.SPINE_TRIT_SHADOW_CALIBRATION_DAYS || 42) || 42);
        const lookaheadHours = Math.max(1, Number(process.env.SPINE_TRIT_SHADOW_CALIBRATION_LOOKAHEAD_HOURS || 24) || 24);
        const calibration = runJson("node", [
          "systems/autonomy/trit_shadow_replay_calibration.js",
          "run",
          dateStr,
          `--days=${calibrationDays}`,
          `--lookahead-hours=${lookaheadHours}`
        ]);
        const calibrationPayload = calibration.payload && typeof calibration.payload === "object"
          ? calibration.payload
          : null;
        const calibrationSummary = calibrationPayload && calibrationPayload.summary && typeof calibrationPayload.summary === "object"
          ? calibrationPayload.summary
          : {};
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_trit_shadow_calibration",
          mode,
          date: dateStr,
          ok: calibration.ok && !!calibrationPayload && calibrationPayload.ok === true,
          total_events: calibrationPayload ? Number(calibrationSummary.total_events || 0) : null,
          accuracy: calibrationPayload ? Number(calibrationSummary.accuracy || 0) : null,
          ece: calibrationPayload ? Number(calibrationSummary.expected_calibration_error || 0) : null,
          brier_score: calibrationPayload ? Number(calibrationSummary.brier_score || 0) : null,
          report_path: calibrationPayload ? calibrationPayload.report_path || null : null,
          reason: (!calibration.ok || !calibrationPayload || calibrationPayload.ok !== true)
            ? String(calibration.stderr || calibration.stdout || `trit_shadow_calibration_exit_${calibration.code}`).slice(0, 180)
            : null
        });
        if (calibration.ok && calibrationPayload && calibrationPayload.ok === true) {
          console.log(
            ` trit_shadow_calibration events=${Number(calibrationSummary.total_events || 0)}` +
            ` accuracy=${Number(calibrationSummary.accuracy || 0)}` +
            ` ece=${Number(calibrationSummary.expected_calibration_error || 0)}`
          );
        } else {
          console.log(` trit_shadow_calibration unavailable reason=${String(calibration.stderr || calibration.stdout || "unknown").slice(0, 120)}`);
        }
      } else {
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_trit_shadow_calibration_skipped",
          mode,
          date: dateStr,
          reason: "feature_flag_disabled",
          flag: "SPINE_TRIT_SHADOW_CALIBRATION_ENABLED",
          flag_value: String(process.env.SPINE_TRIT_SHADOW_CALIBRATION_ENABLED || "")
        });
        console.log(" trit_shadow_calibration skipped reason=feature_flag_disabled flag=SPINE_TRIT_SHADOW_CALIBRATION_ENABLED");
      }

      if (String(process.env.SPINE_TRIT_SHADOW_ADAPTATION_ENABLED || "1") !== "0") {
        const weekday = new Date(`${dateStr}T00:00:00.000Z`).getUTCDay();
        const runWeekday = Math.max(0, Math.min(6, Number(process.env.SPINE_TRIT_SHADOW_ADAPTATION_WEEKDAY || 0) || 0));
        const forced = String(process.env.SPINE_TRIT_SHADOW_ADAPTATION_FORCE || "0") === "1";
        if (forced || weekday === runWeekday) {
          const adaptation = runJson("node", [
            "systems/autonomy/trit_shadow_weekly_adaptation.js",
            "run",
            dateStr
          ]);
          const adaptationPayload = adaptation.payload && typeof adaptation.payload === "object"
            ? adaptation.payload
            : null;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_trit_shadow_weekly_adaptation",
            mode,
            date: dateStr,
            ok: adaptation.ok && !!adaptationPayload && adaptationPayload.ok === true,
            forced,
            suggestions_count: adaptationPayload ? Number(adaptationPayload.suggestions && adaptationPayload.suggestions.length || 0) : null,
            proposal_id: adaptationPayload && adaptationPayload.review ? adaptationPayload.review.proposal_id || null : null,
            report_path: adaptationPayload ? adaptationPayload.report_path || null : null,
            reason: (!adaptation.ok || !adaptationPayload || adaptationPayload.ok !== true)
              ? String(adaptation.stderr || adaptation.stdout || `trit_shadow_weekly_adaptation_exit_${adaptation.code}`).slice(0, 180)
              : null
          });
          if (adaptation.ok && adaptationPayload && adaptationPayload.ok === true) {
            console.log(
              ` trit_shadow_weekly_adaptation suggestions=${Number(adaptationPayload.suggestions && adaptationPayload.suggestions.length || 0)}` +
              ` proposal=${String(adaptationPayload.review && adaptationPayload.review.proposal_id || "none")}`
            );
          } else {
            console.log(` trit_shadow_weekly_adaptation unavailable reason=${String(adaptation.stderr || adaptation.stdout || "unknown").slice(0, 120)}`);
          }
        } else {
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_trit_shadow_weekly_adaptation_skipped",
            mode,
            date: dateStr,
            reason: "weekday_not_scheduled",
            run_weekday: runWeekday,
            weekday
          });
          console.log(` trit_shadow_weekly_adaptation skipped reason=weekday_not_scheduled weekday=${weekday} run_weekday=${runWeekday}`);
        }
      } else {
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_trit_shadow_weekly_adaptation_skipped",
          mode,
          date: dateStr,
          reason: "feature_flag_disabled",
          flag: "SPINE_TRIT_SHADOW_ADAPTATION_ENABLED",
          flag_value: String(process.env.SPINE_TRIT_SHADOW_ADAPTATION_ENABLED || "")
        });
        console.log(" trit_shadow_weekly_adaptation skipped reason=feature_flag_disabled flag=SPINE_TRIT_SHADOW_ADAPTATION_ENABLED");
      }

      if (strict) {
        let strictFailReason = null;
        if (!shadow.ok || !payload || payload.ok !== true) {
          strictFailReason = String(shadow.stderr || shadow.stdout || `trit_shadow_report_exit_${shadow.code}`).slice(0, 160);
        } else if (gate.enabled === true && gate.pass === false) {
          strictFailReason = `gate_failed:${String(gate.reason || "divergence_rate_exceeds_limit")}`;
        } else if (gate.enabled !== true && String(summary.status || "") === "critical") {
          strictFailReason = "status_critical_without_gate_limit";
        }
        if (strictFailReason) {
          console.error(` trit_shadow_report strict_fail reason=${strictFailReason}`);
          process.exit(1);
        }
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_trit_shadow_report_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_TRIT_SHADOW_REPORT_ENABLED",
        flag_value: String(process.env.SPINE_TRIT_SHADOW_REPORT_ENABLED || "")
      });
      console.log(" trit_shadow_report skipped reason=feature_flag_disabled flag=SPINE_TRIT_SHADOW_REPORT_ENABLED");
    }

    // 4e) unify pulsed suggestion sources into a single capped suggestion lane.
    if (String(process.env.SPINE_SUGGESTION_LANE_ENABLED || "1") !== "0") {
      const laneCap = Math.max(1, Number(process.env.SPINE_SUGGESTION_LANE_CAP || 24) || 24);
      const lane = runJson("node", [
        "systems/autonomy/suggestion_lane.js",
        "run",
        dateStr,
        `--cap=${laneCap}`
      ]);
      const lanePayload = lane.payload && typeof lane.payload === "object"
        ? lane.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_suggestion_lane",
        mode,
        date: dateStr,
        ok: lane.ok && !!lanePayload && lanePayload.ok === true,
        cap: lanePayload ? Number(lanePayload.cap || laneCap) : laneCap,
        merged_count: lanePayload ? Number(lanePayload.merged_count || 0) : null,
        total_candidates: lanePayload ? Number(lanePayload.total_candidates || 0) : null,
        capped: lanePayload ? lanePayload.capped === true : null,
        sources: lanePayload && lanePayload.sources && typeof lanePayload.sources === "object"
          ? lanePayload.sources
          : null,
        lane_path: lanePayload ? lanePayload.lane_path || null : null,
        reason: (!lane.ok || !lanePayload || lanePayload.ok !== true)
          ? String(lane.stderr || lane.stdout || `suggestion_lane_exit_${lane.code}`).slice(0, 180)
          : null
      });
      if (lane.ok && lanePayload && lanePayload.ok === true) {
        console.log(
          ` suggestion_lane merged=${Number(lanePayload.merged_count || 0)}` +
          ` candidates=${Number(lanePayload.total_candidates || 0)}` +
          ` cap=${Number(lanePayload.cap || laneCap)}`
        );
      } else {
        console.log(` suggestion_lane unavailable reason=${String(lane.stderr || lane.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_suggestion_lane_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_SUGGESTION_LANE_ENABLED",
        flag_value: String(process.env.SPINE_SUGGESTION_LANE_ENABLED || "")
      });
      console.log(" suggestion_lane skipped reason=feature_flag_disabled flag=SPINE_SUGGESTION_LANE_ENABLED");
    }

    // 4f) recursive organism introspection snapshot (branch health + restructure candidates).
    if (String(process.env.SPINE_FRACTAL_INTROSPECTION_ENABLED || "1") !== "0") {
      const introspection = runJson("node", [
        "systems/fractal/introspection_map.js",
        "run",
        dateStr
      ]);
      const payload = introspection.payload && typeof introspection.payload === "object"
        ? introspection.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_introspection",
        mode,
        date: dateStr,
        ok: introspection.ok && !!payload && payload.ok === true,
        nodes: payload ? Number(payload.nodes || 0) : null,
        edges: payload ? Number(payload.edges || 0) : null,
        restructure_candidates: payload ? Number(payload.restructure_candidates || 0) : null,
        output_path: payload ? payload.output_path || null : null,
        reason: (!introspection.ok || !payload || payload.ok !== true)
          ? String(introspection.stderr || introspection.stdout || `fractal_introspection_exit_${introspection.code}`).slice(0, 180)
          : null
      });
      if (introspection.ok && payload && payload.ok === true) {
        console.log(
          ` fractal_introspection nodes=${Number(payload.nodes || 0)}` +
          ` candidates=${Number(payload.restructure_candidates || 0)}`
        );
      } else {
        console.log(` fractal_introspection unavailable reason=${String(introspection.stderr || introspection.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_introspection_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_FRACTAL_INTROSPECTION_ENABLED",
        flag_value: String(process.env.SPINE_FRACTAL_INTROSPECTION_ENABLED || "")
      });
      console.log(" fractal_introspection skipped reason=feature_flag_disabled flag=SPINE_FRACTAL_INTROSPECTION_ENABLED");
    }

    // 4g) directive-conditioned morph planner (proposal-only).
    if (String(process.env.SPINE_FRACTAL_MORPH_ENABLED || "1") !== "0") {
      const morphMaxActions = Math.max(1, Number(process.env.SPINE_FRACTAL_MORPH_MAX_ACTIONS || 6) || 6);
      const morph = runJson("node", [
        "systems/fractal/morph_planner.js",
        "run",
        dateStr,
        `--max-actions=${morphMaxActions}`
      ]);
      const payload = morph.payload && typeof morph.payload === "object"
        ? morph.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_morph_plan",
        mode,
        date: dateStr,
        ok: morph.ok && !!payload && payload.ok === true,
        plan_id: payload ? payload.plan_id || null : null,
        objective_id: payload ? payload.objective_id || null : null,
        action_count: payload ? Number(payload.action_count || 0) : null,
        output_path: payload ? payload.output_path || null : null,
        reason: (!morph.ok || !payload || payload.ok !== true)
          ? String(morph.stderr || morph.stdout || `fractal_morph_exit_${morph.code}`).slice(0, 180)
          : null
      });
      if (morph.ok && payload && payload.ok === true) {
        console.log(
          ` fractal_morph plan=${String(payload.plan_id || "none")}` +
          ` actions=${Number(payload.action_count || 0)}`
        );
      } else {
        console.log(` fractal_morph unavailable reason=${String(morph.stderr || morph.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_morph_plan_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_FRACTAL_MORPH_ENABLED",
        flag_value: String(process.env.SPINE_FRACTAL_MORPH_ENABLED || "")
      });
      console.log(" fractal_morph skipped reason=feature_flag_disabled flag=SPINE_FRACTAL_MORPH_ENABLED");
    }

    // 4g1) regime organ (task/environment sensing + bounded morph trigger).
    if (String(process.env.SPINE_FRACTAL_REGIME_ORGAN_ENABLED || "1") !== "0") {
      const regimeMaxActions = Math.max(1, Number(process.env.SPINE_FRACTAL_REGIME_MAX_ACTIONS || 4) || 4);
      const regime = runJson("node", [
        "systems/fractal/regime_organ.js",
        "run",
        dateStr,
        `--max-actions=${regimeMaxActions}`
      ]);
      const payload = regime.payload && typeof regime.payload === "object"
        ? regime.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_regime_organ",
        mode,
        date: dateStr,
        ok: regime.ok && !!payload && payload.ok === true,
        selected_regime: payload ? payload.selected_regime || null : null,
        candidate_regime: payload ? payload.candidate_regime || null : null,
        switched: payload ? payload.switched === true : null,
        switch_reason: payload ? payload.switch_reason || null : null,
        confidence: payload ? Number(payload.confidence || 0) : null,
        action_count: payload ? Number(payload.action_count || 0) : null,
        promotion_ready: payload ? payload.promotion_ready === true : null,
        non_regression_pass: payload ? payload.non_regression_pass === true : null,
        output_path: payload ? payload.output_path || null : null,
        receipt_path: payload ? payload.receipt_path || null : null,
        reason: (!regime.ok || !payload || payload.ok !== true)
          ? String(regime.stderr || regime.stdout || `fractal_regime_exit_${regime.code}`).slice(0, 180)
          : null
      });
      if (regime.ok && payload && payload.ok === true) {
        console.log(
          ` fractal_regime selected=${String(payload.selected_regime || "none")}` +
          ` switched=${payload.switched === true ? "1" : "0"}` +
          ` actions=${Number(payload.action_count || 0)}` +
          ` promotion_ready=${payload.promotion_ready === true ? "1" : "0"}`
        );
      } else {
        console.log(` fractal_regime unavailable reason=${String(regime.stderr || regime.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_regime_organ_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_FRACTAL_REGIME_ORGAN_ENABLED",
        flag_value: String(process.env.SPINE_FRACTAL_REGIME_ORGAN_ENABLED || "")
      });
      console.log(" fractal_regime skipped reason=feature_flag_disabled flag=SPINE_FRACTAL_REGIME_ORGAN_ENABLED");
    }

    // 4g2) identity anchor over workflow graft + morph outputs.
    if (String(process.env.SPINE_IDENTITY_ANCHOR_ENABLED || "1") !== "0") {
      const identityScopeRaw = String(process.env.SPINE_IDENTITY_ANCHOR_SCOPE || "all").trim().toLowerCase();
      const identityScope = identityScopeRaw === "workflows" || identityScopeRaw === "morph"
        ? identityScopeRaw
        : "all";
      const identityStrict = String(process.env.SPINE_IDENTITY_ANCHOR_STRICT || "0") === "1";
      const identity = runJson("node", [
        "systems/identity/identity_anchor.js",
        "run",
        dateStr,
        `--scope=${identityScope}`,
        `--strict=${identityStrict ? "1" : "0"}`
      ]);
      const payload = identity.payload && typeof identity.payload === "object"
        ? identity.payload
        : null;
      const identityOk = identity.ok && !!payload && payload.ok === true;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_identity_anchor",
        mode,
        date: dateStr,
        ok: identityOk,
        scope: payload ? payload.scope || identityScope : identityScope,
        strict: identityStrict,
        checked: payload ? Number(payload.checked || 0) : null,
        blocked: payload ? Number(payload.blocked || 0) : null,
        identity_drift_score: payload ? Number(payload.identity_drift_score || 0) : null,
        max_identity_drift_score: payload ? Number(payload.max_identity_drift_score || 0) : null,
        receipt_path: payload ? payload.receipt_path || null : null,
        reason: (!identityOk)
          ? String(identity.stderr || identity.stdout || `identity_anchor_exit_${identity.code}`).slice(0, 180)
          : null
      });
      if (identityOk) {
        console.log(
          ` identity_anchor checked=${Number(payload.checked || 0)}` +
          ` blocked=${Number(payload.blocked || 0)}` +
          ` drift=${Number(payload.identity_drift_score || 0).toFixed(4)}`
        );
      } else {
        console.log(` identity_anchor unavailable reason=${String(identity.stderr || identity.stdout || "unknown").slice(0, 120)}`);
      }
      if (identityStrict && !identityOk) process.exit(identity.code || 1);
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_identity_anchor_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_IDENTITY_ANCHOR_ENABLED",
        flag_value: String(process.env.SPINE_IDENTITY_ANCHOR_ENABLED || "")
      });
      console.log(" identity_anchor skipped reason=feature_flag_disabled flag=SPINE_IDENTITY_ANCHOR_ENABLED");
    }

    // 4h) genome topology snapshot + mutation journal append.
    if (String(process.env.SPINE_FRACTAL_GENOME_LEDGER_ENABLED || "1") !== "0") {
      const genome = runJson("node", [
        "systems/fractal/genome_ledger.js",
        "snapshot",
        dateStr
      ]);
      const payload = genome.payload && typeof genome.payload === "object"
        ? genome.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_genome_snapshot",
        mode,
        date: dateStr,
        ok: genome.ok && !!payload && payload.ok === true,
        modules_total: payload ? Number(payload.modules_total || 0) : null,
        plan_id: payload ? payload.plan_id || null : null,
        action_count: payload ? Number(payload.action_count || 0) : null,
        snapshot_path: payload ? payload.snapshot_path || null : null,
        ledger_path: payload ? payload.ledger_path || null : null,
        hash: payload ? payload.hash || null : null,
        reason: (!genome.ok || !payload || payload.ok !== true)
          ? String(genome.stderr || genome.stdout || `fractal_genome_exit_${genome.code}`).slice(0, 180)
          : null
      });
      if (genome.ok && payload && payload.ok === true) {
        console.log(
          ` fractal_genome modules=${Number(payload.modules_total || 0)}` +
          ` hash=${String(payload.hash || "").slice(0, 12)}`
        );
      } else {
        console.log(` fractal_genome unavailable reason=${String(genome.stderr || genome.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_genome_snapshot_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_FRACTAL_GENOME_LEDGER_ENABLED",
        flag_value: String(process.env.SPINE_FRACTAL_GENOME_LEDGER_ENABLED || "")
      });
      console.log(" fractal_genome skipped reason=feature_flag_disabled flag=SPINE_FRACTAL_GENOME_LEDGER_ENABLED");
    }

    // 4i) bounded organism cycle (dream/symbiosis/predator/epigenetic/pheromone/resonance/archetypes).
    if (String(process.env.SPINE_FRACTAL_ORGANISM_CYCLE_ENABLED || "1") !== "0") {
      const cycle = runJson("node", [
        "systems/fractal/organism_cycle.js",
        "run",
        dateStr
      ]);
      const payload = cycle.payload && typeof cycle.payload === "object"
        ? cycle.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_organism_cycle",
        mode,
        date: dateStr,
        ok: cycle.ok && !!payload && payload.ok === true,
        symbiosis_plans: payload ? Number(payload.symbiosis_plans || 0) : null,
        predator_candidates: payload ? Number(payload.predator_candidates || 0) : null,
        pheromones: payload ? Number(payload.pheromones || 0) : null,
        harmony_score: payload ? Number(payload.harmony_score || 0) : null,
        archetypes: payload ? Number(payload.archetypes || 0) : null,
        archetype_novelty_alert: payload ? payload.archetype_novelty_alert === true : null,
        archetype_new: payload ? Number(payload.archetype_new || 0) : null,
        archetype_confidence_shifts: payload ? Number(payload.archetype_confidence_shifts || 0) : null,
        output_path: payload ? payload.output_path || null : null,
        reason: (!cycle.ok || !payload || payload.ok !== true)
          ? String(cycle.stderr || cycle.stdout || `fractal_organism_cycle_exit_${cycle.code}`).slice(0, 180)
          : null
      });
      if (cycle.ok && payload && payload.ok === true) {
        console.log(
          ` fractal_organism cycle_harmony=${Number(payload.harmony_score || 0)}` +
          ` archetypes=${Number(payload.archetypes || 0)}` +
          ` novelty=${payload.archetype_novelty_alert === true ? "1" : "0"}` +
          ` new=${Number(payload.archetype_new || 0)}`
        );
      } else {
        console.log(` fractal_organism unavailable reason=${String(cycle.stderr || cycle.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_fractal_organism_cycle_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_FRACTAL_ORGANISM_CYCLE_ENABLED",
        flag_value: String(process.env.SPINE_FRACTAL_ORGANISM_CYCLE_ENABLED || "")
      });
      console.log(" fractal_organism skipped reason=feature_flag_disabled flag=SPINE_FRACTAL_ORGANISM_CYCLE_ENABLED");
    }

    // 4j) collective shadow distillation (read-only failure-memory lane).
    if (String(process.env.SPINE_COLLECTIVE_SHADOW_ENABLED || "1") !== "0") {
      const shadowDays = Math.max(1, Number(process.env.SPINE_COLLECTIVE_SHADOW_DAYS || 14) || 14);
      const collectiveShadow = runJson("node", [
        "systems/autonomy/collective_shadow.js",
        "run",
        dateStr,
        `--days=${shadowDays}`
      ]);
      const payload = collectiveShadow.payload && typeof collectiveShadow.payload === "object"
        ? collectiveShadow.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_collective_shadow",
        mode,
        date: dateStr,
        ok: collectiveShadow.ok && !!payload && payload.ok === true,
        window_days: payload ? Number(payload.window_days || shadowDays) : shadowDays,
        run_rows: payload ? Number(payload.run_rows || 0) : null,
        archetypes_total: payload ? Number(payload.archetypes_total || 0) : null,
        avoid: payload ? Number(payload.avoid || 0) : null,
        reinforce: payload ? Number(payload.reinforce || 0) : null,
        red_team_fail_rate: payload ? Number(payload.red_team_fail_rate || 0) : null,
        output_path: payload ? payload.output_path || null : null,
        reason: (!collectiveShadow.ok || !payload || payload.ok !== true)
          ? String(collectiveShadow.stderr || collectiveShadow.stdout || `collective_shadow_exit_${collectiveShadow.code}`).slice(0, 180)
          : null
      });
      if (collectiveShadow.ok && payload && payload.ok === true) {
        console.log(
          ` collective_shadow archetypes=${Number(payload.archetypes_total || 0)}` +
          ` avoid=${Number(payload.avoid || 0)}` +
          ` reinforce=${Number(payload.reinforce || 0)}`
        );
      } else {
        console.log(` collective_shadow unavailable reason=${String(collectiveShadow.stderr || collectiveShadow.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_collective_shadow_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_COLLECTIVE_SHADOW_ENABLED",
        flag_value: String(process.env.SPINE_COLLECTIVE_SHADOW_ENABLED || "")
      });
      console.log(" collective_shadow skipped reason=feature_flag_disabled flag=SPINE_COLLECTIVE_SHADOW_ENABLED");
    }

    // 4k) observer mirror snapshot (read-only narrative + machine summary).
    if (String(process.env.SPINE_OBSERVER_MIRROR_ENABLED || "1") !== "0") {
      const mirrorDays = Math.max(1, Number(process.env.SPINE_OBSERVER_MIRROR_DAYS || 1) || 1);
      const observerMirror = runJson("node", [
        "systems/autonomy/observer_mirror.js",
        "run",
        dateStr,
        `--days=${mirrorDays}`
      ]);
      const payload = observerMirror.payload && typeof observerMirror.payload === "object"
        ? observerMirror.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_observer_mirror",
        mode,
        date: dateStr,
        ok: observerMirror.ok && !!payload && payload.ok === true,
        mood: payload ? payload.mood || null : null,
        drift_rate: payload ? Number(payload.drift_rate || 0) : null,
        yield_rate: payload ? Number(payload.yield_rate || 0) : null,
        ship_rate: payload ? Number(payload.ship_rate || 0) : null,
        hold_rate: payload ? Number(payload.hold_rate || 0) : null,
        queue_pressure: payload ? payload.queue_pressure || null : null,
        output_path: payload ? payload.output_path || null : null,
        reason: (!observerMirror.ok || !payload || payload.ok !== true)
          ? String(observerMirror.stderr || observerMirror.stdout || `observer_mirror_exit_${observerMirror.code}`).slice(0, 180)
          : null
      });
      if (observerMirror.ok && payload && payload.ok === true) {
        console.log(
          ` observer_mirror mood=${String(payload.mood || "unknown")}` +
          ` drift=${payload.drift_rate == null ? "n/a" : Number(payload.drift_rate || 0)}`
        );
      } else {
        console.log(` observer_mirror unavailable reason=${String(observerMirror.stderr || observerMirror.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_observer_mirror_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_OBSERVER_MIRROR_ENABLED",
        flag_value: String(process.env.SPINE_OBSERVER_MIRROR_ENABLED || "")
      });
      console.log(" observer_mirror skipped reason=feature_flag_disabled flag=SPINE_OBSERVER_MIRROR_ENABLED");
    }

    // 4l) mirror organ (proposal-only self-critique from introspection signals).
    if (String(process.env.SPINE_MIRROR_ORGAN_ENABLED || "1") !== "0") {
      const mirrorWindowDays = Math.max(1, Number(process.env.SPINE_MIRROR_ORGAN_WINDOW_DAYS || 3) || 3);
      const mirrorMaxProposals = Math.max(1, Number(process.env.SPINE_MIRROR_ORGAN_MAX_PROPOSALS || 6) || 6);
      const mirrorArgs = [
        "systems/autonomy/mirror_organ.js",
        "run",
        dateStr,
        `--days=${mirrorWindowDays}`,
        `--max-proposals=${mirrorMaxProposals}`
      ];
      const mirrorPolicyPath = String(process.env.SPINE_MIRROR_ORGAN_POLICY_PATH || "").trim();
      if (mirrorPolicyPath) mirrorArgs.push(`--policy=${mirrorPolicyPath}`);
      if (String(process.env.SPINE_MIRROR_ORGAN_DRY_RUN || "0") === "1") mirrorArgs.push("--dry-run=1");

      const mirror = runJson("node", mirrorArgs);
      const payload = mirror.payload && typeof mirror.payload === "object"
        ? mirror.payload
        : null;
      const mirrorOk = mirror.ok && !!payload && payload.ok === true;
      const mirrorStrict = String(process.env.SPINE_MIRROR_ORGAN_STRICT || "0") === "1";
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_mirror_organ",
        mode,
        date: dateStr,
        ok: mirrorOk,
        strict: mirrorStrict,
        window_days: payload ? Number(payload.window_days || mirrorWindowDays) : mirrorWindowDays,
        pressure_score: payload ? Number(payload.pressure_score || 0) : null,
        confidence: payload ? Number(payload.confidence || 0) : null,
        proposal_count: payload ? Number(payload.proposal_count || 0) : null,
        execution_mode: payload ? payload.execution_mode || "proposal_only" : "proposal_only",
        run_path: payload ? payload.run_path || null : null,
        latest_path: payload ? payload.latest_path || null : null,
        suggestions_path: payload ? payload.suggestions_path || null : null,
        reason: (!mirrorOk)
          ? String(mirror.stderr || mirror.stdout || `mirror_organ_exit_${mirror.code}`).slice(0, 180)
          : null
      });
      if (mirrorOk) {
        console.log(
          ` mirror_organ proposals=${Number(payload.proposal_count || 0)}` +
          ` pressure=${Number(payload.pressure_score || 0).toFixed(4)}` +
          ` confidence=${Number(payload.confidence || 0).toFixed(4)}`
        );
      } else {
        console.log(` mirror_organ unavailable reason=${String(mirror.stderr || mirror.stdout || "unknown").slice(0, 120)}`);
      }
      if (mirrorStrict && !mirrorOk) process.exit(mirror.code || 1);
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_mirror_organ_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_MIRROR_ORGAN_ENABLED",
        flag_value: String(process.env.SPINE_MIRROR_ORGAN_ENABLED || "")
      });
      console.log(" mirror_organ skipped reason=feature_flag_disabled flag=SPINE_MIRROR_ORGAN_ENABLED");
    }

    // 4l1) optional post-mirror suggestion lane refresh so same-run mirror proposals are surfaced immediately.
    if (
      String(process.env.SPINE_SUGGESTION_LANE_ENABLED || "1") !== "0"
      && String(process.env.SPINE_SUGGESTION_LANE_REFRESH_AFTER_MIRROR || "1") !== "0"
    ) {
      const laneCap = Math.max(1, Number(process.env.SPINE_SUGGESTION_LANE_CAP || 24) || 24);
      const lane = runJson("node", [
        "systems/autonomy/suggestion_lane.js",
        "run",
        dateStr,
        `--cap=${laneCap}`
      ]);
      const lanePayload = lane.payload && typeof lane.payload === "object"
        ? lane.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_suggestion_lane_refresh",
        mode,
        date: dateStr,
        ok: lane.ok && !!lanePayload && lanePayload.ok === true,
        cap: lanePayload ? Number(lanePayload.cap || laneCap) : laneCap,
        merged_count: lanePayload ? Number(lanePayload.merged_count || 0) : null,
        total_candidates: lanePayload ? Number(lanePayload.total_candidates || 0) : null,
        capped: lanePayload ? lanePayload.capped === true : null,
        sources: lanePayload && lanePayload.sources && typeof lanePayload.sources === "object"
          ? lanePayload.sources
          : null,
        lane_path: lanePayload ? lanePayload.lane_path || null : null,
        reason: (!lane.ok || !lanePayload || lanePayload.ok !== true)
          ? String(lane.stderr || lane.stdout || `suggestion_lane_refresh_exit_${lane.code}`).slice(0, 180)
          : null
      });
      if (lane.ok && lanePayload && lanePayload.ok === true) {
        console.log(
          ` suggestion_lane_refresh merged=${Number(lanePayload.merged_count || 0)}` +
          ` candidates=${Number(lanePayload.total_candidates || 0)}` +
          ` cap=${Number(lanePayload.cap || laneCap)}`
        );
      } else {
        console.log(` suggestion_lane_refresh unavailable reason=${String(lane.stderr || lane.stdout || "unknown").slice(0, 120)}`);
      }
    }

    // 4m) continuum organ pulse (background consolidation + anticipation, low-priority and bounded).
    if (String(process.env.SPINE_CONTINUUM_ENABLED || "1") !== "0") {
      const continuumTimeoutMs = Math.max(2000, Number(process.env.SPINE_CONTINUUM_TIMEOUT_MS || 22000) || 22000);
      const continuumProfile = String(process.env.SPINE_CONTINUUM_PROFILE || "spine").trim().toLowerCase() || "spine";
      const continuumArgs = [
        "systems/continuum/continuum_core.js",
        "pulse",
        dateStr,
        `--profile=${continuumProfile}`,
        "--reason=spine_daily"
      ];
      const continuumPolicyPath = String(process.env.SPINE_CONTINUUM_POLICY_PATH || "").trim();
      if (continuumPolicyPath) continuumArgs.push(`--policy=${continuumPolicyPath}`);
      if (String(process.env.SPINE_CONTINUUM_DRY_RUN || "0") === "1") continuumArgs.push("--dry-run=1");
      if (String(process.env.SPINE_CONTINUUM_FORCE || "0") === "1") continuumArgs.push("--force=1");
      const continuum = runJson("node", continuumArgs, { timeout: continuumTimeoutMs });
      const payload = continuum.payload && typeof continuum.payload === "object"
        ? continuum.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_continuum_pulse",
        mode,
        date: dateStr,
        ok: continuum.ok && !!payload && payload.ok === true,
        profile: payload ? payload.profile || continuumProfile : continuumProfile,
        skipped: payload ? payload.skipped === true : null,
        skip_reasons: payload && Array.isArray(payload.skip_reasons) ? payload.skip_reasons.slice(0, 8) : null,
        trit: payload && payload.trit ? Number(payload.trit.value || 0) : null,
        trit_label: payload && payload.trit ? payload.trit.label || null : null,
        tasks_executed: payload ? Number(payload.tasks_executed || 0) : null,
        training_queue_rows: payload && payload.training_queue
          ? Number(payload.training_queue.appended || 0)
          : null,
        run_path: payload ? payload.run_path || null : null,
        reason: (!continuum.ok || !payload || payload.ok !== true)
          ? String(continuum.stderr || continuum.stdout || `continuum_pulse_exit_${continuum.code}`).slice(0, 180)
          : null
      });
      if (continuum.ok && payload && payload.ok === true) {
        console.log(
          ` continuum_pulse trit=${String(payload.trit && payload.trit.label || "unknown")}` +
          ` tasks=${Number(payload.tasks_executed || 0)}` +
          ` skipped=${payload.skipped === true ? "yes" : "no"}`
        );
      } else {
        console.log(` continuum_pulse unavailable reason=${String(continuum.stderr || continuum.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_continuum_pulse_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_CONTINUUM_ENABLED",
        flag_value: String(process.env.SPINE_CONTINUUM_ENABLED || "")
      });
      console.log(" continuum_pulse skipped reason=feature_flag_disabled flag=SPINE_CONTINUUM_ENABLED");
    }

    // 4m) self-documentation closeout (daily MEMORY.md session summary with significance gating).
    if (String(process.env.SPINE_SELF_DOCUMENTATION_ENABLED || "1") !== "0") {
      const selfDocArgs = [
        "systems/autonomy/self_documentation_closeout.js",
        "run",
        dateStr
      ];
      const requireApprovalRaw = String(process.env.SPINE_SELF_DOCUMENTATION_REQUIRE_APPROVAL || "").trim();
      if (requireApprovalRaw) {
        selfDocArgs.push(`--require-approval=${requireApprovalRaw}`);
      }
      const thresholdRaw = String(process.env.SPINE_SELF_DOCUMENTATION_SIGNIFICANT_THRESHOLD || "").trim();
      if (thresholdRaw) {
        selfDocArgs.push(`--significant-threshold=${thresholdRaw}`);
      }
      const selfDoc = runJson("node", selfDocArgs);
      const selfDocPayload = selfDoc.payload && typeof selfDoc.payload === "object"
        ? selfDoc.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_self_documentation",
        mode,
        date: dateStr,
        ok: selfDoc.ok && !!selfDocPayload && selfDocPayload.ok === true,
        applied: selfDocPayload ? selfDocPayload.applied === true : null,
        requires_review: selfDocPayload ? selfDocPayload.requires_review === true : null,
        significant: selfDocPayload ? selfDocPayload.significant === true : null,
        significance_score: selfDocPayload ? Number(selfDocPayload.significance_score || 0) : null,
        significance_reasons: selfDocPayload && Array.isArray(selfDocPayload.significance_reasons)
          ? selfDocPayload.significance_reasons.slice(0, 8)
          : null,
        output_path: selfDocPayload ? selfDocPayload.output_path || null : null,
        reason: (!selfDoc.ok || !selfDocPayload || selfDocPayload.ok !== true)
          ? String(selfDoc.stderr || selfDoc.stdout || `self_documentation_closeout_exit_${selfDoc.code}`).slice(0, 180)
          : null
      });
      if (selfDoc.ok && selfDocPayload && selfDocPayload.ok === true) {
        console.log(
          ` self_documentation applied=${selfDocPayload.applied === true ? "yes" : "no"}` +
          ` review=${selfDocPayload.requires_review === true ? "required" : "none"}` +
          ` significant=${selfDocPayload.significant === true ? "yes" : "no"}`
        );
      } else {
        console.log(` self_documentation unavailable reason=${String(selfDoc.stderr || selfDoc.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_self_documentation_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_SELF_DOCUMENTATION_ENABLED",
        flag_value: String(process.env.SPINE_SELF_DOCUMENTATION_ENABLED || "")
      });
      console.log(" self_documentation skipped reason=feature_flag_disabled flag=SPINE_SELF_DOCUMENTATION_ENABLED");
    }

    // 4k) black-box hash ledger rollup for tamper-evident decision traceability.
    if (String(process.env.SPINE_BLACK_BOX_LEDGER_ENABLED || "1") !== "0") {
      const blackBox = runJson("node", [
        "systems/security/black_box_ledger.js",
        "rollup",
        dateStr,
        `--mode=${String(mode || "daily")}`
      ]);
      const blackBoxPayload = blackBox.payload && typeof blackBox.payload === "object"
        ? blackBox.payload
        : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_black_box_ledger",
        mode,
        date: dateStr,
        ok: blackBox.ok && !!blackBoxPayload && blackBoxPayload.ok === true,
        total_events: blackBoxPayload ? Number(blackBoxPayload.total_events || 0) : null,
        spine_events: blackBoxPayload ? Number(blackBoxPayload.spine_events || 0) : null,
        autonomy_events: blackBoxPayload ? Number(blackBoxPayload.autonomy_events || 0) : null,
        chain_hash: blackBoxPayload ? blackBoxPayload.chain_hash || null : null,
        chain_path: blackBoxPayload ? blackBoxPayload.chain_path || null : null,
        reason: (!blackBox.ok || !blackBoxPayload || blackBoxPayload.ok !== true)
          ? String(blackBox.stderr || blackBox.stdout || `black_box_ledger_exit_${blackBox.code}`).slice(0, 180)
          : null
      });
      if (blackBox.ok && blackBoxPayload && blackBoxPayload.ok === true) {
        console.log(
          ` black_box_ledger events=${Number(blackBoxPayload.total_events || 0)}` +
          ` hash=${String(blackBoxPayload.chain_hash || "").slice(0, 12)}`
        );
      } else {
        console.log(` black_box_ledger unavailable reason=${String(blackBox.stderr || blackBox.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_black_box_ledger_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_BLACK_BOX_LEDGER_ENABLED",
        flag_value: String(process.env.SPINE_BLACK_BOX_LEDGER_ENABLED || "")
      });
      console.log(" black_box_ledger skipped reason=feature_flag_disabled flag=SPINE_BLACK_BOX_LEDGER_ENABLED");
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

    // 5a) optional encrypted offsite backup sync + cadence-based restore drills.
    if (String(process.env.STATE_BACKUP_OFFSITE_ENABLED || "1") !== "0") {
      const offsitePolicyPath = String(process.env.SPINE_OFFSITE_BACKUP_POLICY_PATH || "config/offsite_backup_policy.json").trim();
      const offsiteProfile = String(process.env.SPINE_OFFSITE_BACKUP_PROFILE || process.env.STATE_BACKUP_PROFILE || "").trim();
      const offsiteDest = String(process.env.STATE_BACKUP_OFFSITE_DEST || "").trim();
      const offsiteSourceDest = String(process.env.STATE_BACKUP_DEST || "").trim();
      const offsiteStrict = String(process.env.SPINE_OFFSITE_BACKUP_STRICT || "0") === "1";
      const offsiteSyncArgs = ["systems/ops/offsite_backup.js", "sync"];
      if (offsitePolicyPath) offsiteSyncArgs.push(`--policy=${offsitePolicyPath}`);
      if (offsiteProfile) offsiteSyncArgs.push(`--profile=${offsiteProfile}`);
      if (offsiteDest) offsiteSyncArgs.push(`--offsite-dest=${offsiteDest}`);
      if (offsiteSourceDest) offsiteSyncArgs.push(`--source-dest=${offsiteSourceDest}`);
      if (offsiteStrict) offsiteSyncArgs.push("--strict=1");
      const offsiteSync = runJson("node", offsiteSyncArgs);
      const offsiteSyncPayload = offsiteSync.payload && typeof offsiteSync.payload === "object"
        ? offsiteSync.payload
        : null;
      const offsiteSyncOk = offsiteSync.ok && !!offsiteSyncPayload && offsiteSyncPayload.ok === true;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_offsite_backup_sync",
        mode,
        date: dateStr,
        ok: offsiteSyncOk,
        strict: offsiteStrict,
        profile: offsiteSyncPayload ? offsiteSyncPayload.profile || null : null,
        snapshot_id: offsiteSyncPayload ? offsiteSyncPayload.snapshot_id || null : null,
        file_count: offsiteSyncPayload ? Number(offsiteSyncPayload.file_count || 0) : null,
        offsite_destination: offsiteSyncPayload ? offsiteSyncPayload.offsite_destination || null : null,
        rpo_hours: offsiteSyncPayload && offsiteSyncPayload.metrics
          ? Number(offsiteSyncPayload.metrics.rpo_hours || 0)
          : null,
        reason: !offsiteSyncOk
          ? String(
            (offsiteSyncPayload && offsiteSyncPayload.reason)
            || offsiteSync.stderr
            || offsiteSync.stdout
            || `offsite_backup_sync_exit_${offsiteSync.code}`
          ).slice(0, 180)
          : null
      });
      if (offsiteSyncOk) {
        console.log(
          ` offsite_backup_sync ok snapshot=${String(offsiteSyncPayload && offsiteSyncPayload.snapshot_id || "unknown")}` +
          ` files=${Number(offsiteSyncPayload && offsiteSyncPayload.file_count || 0)}` +
          ` rpo_hours=${String(offsiteSyncPayload && offsiteSyncPayload.metrics ? offsiteSyncPayload.metrics.rpo_hours : "n/a")}`
        );
      } else {
        console.log(` offsite_backup_sync unavailable reason=${String(offsiteSync.stderr || offsiteSync.stdout || "unknown").slice(0, 120)}`);
        if (offsiteStrict) process.exit(offsiteSync.code || 1);
      }

      if (String(process.env.SPINE_OFFSITE_RESTORE_DRILL_ENABLED || "1") !== "0") {
        const statusArgs = ["systems/ops/offsite_backup.js", "status"];
        if (offsitePolicyPath) statusArgs.push(`--policy=${offsitePolicyPath}`);
        if (offsiteProfile) statusArgs.push(`--profile=${offsiteProfile}`);
        if (offsiteDest) statusArgs.push(`--offsite-dest=${offsiteDest}`);
        const offsiteStatus = runJson("node", statusArgs);
        const offsiteStatusPayload = offsiteStatus.payload && typeof offsiteStatus.payload === "object"
          ? offsiteStatus.payload
          : null;
        const offsiteDue = !!(offsiteStatus.ok && offsiteStatusPayload && offsiteStatusPayload.restore_drill_due === true);
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_offsite_restore_drill_status",
          mode,
          date: dateStr,
          ok: offsiteStatus.ok && !!offsiteStatusPayload && offsiteStatusPayload.ok === true,
          due: offsiteDue,
          profile: offsiteStatusPayload ? offsiteStatusPayload.profile || null : null,
          last_drill_ts: offsiteStatusPayload ? offsiteStatusPayload.last_drill_ts || null : null,
          next_due_ts: offsiteStatusPayload ? offsiteStatusPayload.restore_drill_next_due_ts || null : null,
          reason: (!offsiteStatus.ok || !offsiteStatusPayload || offsiteStatusPayload.ok !== true)
            ? String(offsiteStatus.stderr || offsiteStatus.stdout || `offsite_restore_status_exit_${offsiteStatus.code}`).slice(0, 180)
            : null
        });

        if (offsiteDue) {
          const restoreArgs = ["systems/ops/offsite_backup.js", "restore-drill"];
          const restoreStrict = String(process.env.SPINE_OFFSITE_RESTORE_DRILL_STRICT || "0") === "1";
          const restoreDest = String(process.env.SPINE_OFFSITE_RESTORE_DRILL_DEST || "").trim();
          if (offsitePolicyPath) restoreArgs.push(`--policy=${offsitePolicyPath}`);
          if (offsiteProfile) restoreArgs.push(`--profile=${offsiteProfile}`);
          if (offsiteDest) restoreArgs.push(`--offsite-dest=${offsiteDest}`);
          if (restoreDest) restoreArgs.push(`--dest=${restoreDest}`);
          if (restoreStrict) restoreArgs.push("--strict=1");
          const offsiteRestore = runJson("node", restoreArgs);
          const offsiteRestorePayload = offsiteRestore.payload && typeof offsiteRestore.payload === "object"
            ? offsiteRestore.payload
            : null;
          const offsiteRestoreOk = offsiteRestore.ok && !!offsiteRestorePayload && offsiteRestorePayload.ok === true;
          appendLedger(dateStr, {
            ts: nowIso(),
            type: "spine_offsite_restore_drill",
            mode,
            date: dateStr,
            ok: offsiteRestoreOk,
            strict: restoreStrict,
            profile: offsiteRestorePayload ? offsiteRestorePayload.profile || null : null,
            snapshot_id: offsiteRestorePayload ? offsiteRestorePayload.snapshot_id || null : null,
            verified_files: offsiteRestorePayload ? Number(offsiteRestorePayload.verified_files || 0) : null,
            rto_minutes: offsiteRestorePayload && offsiteRestorePayload.metrics
              ? Number(offsiteRestorePayload.metrics.rto_minutes || 0)
              : null,
            rpo_hours: offsiteRestorePayload && offsiteRestorePayload.metrics
              ? Number(offsiteRestorePayload.metrics.rpo_hours || 0)
              : null,
            reason: !offsiteRestoreOk
              ? String(
                (offsiteRestorePayload && Array.isArray(offsiteRestorePayload.reasons) && offsiteRestorePayload.reasons[0])
                || offsiteRestorePayload && offsiteRestorePayload.reason
                || offsiteRestore.stderr
                || offsiteRestore.stdout
                || `offsite_restore_drill_exit_${offsiteRestore.code}`
              ).slice(0, 180)
              : null
          });
          if (offsiteRestoreOk) {
            console.log(
              ` offsite_restore_drill ok snapshot=${String(offsiteRestorePayload && offsiteRestorePayload.snapshot_id || "unknown")}` +
              ` rto=${String(offsiteRestorePayload && offsiteRestorePayload.metrics ? offsiteRestorePayload.metrics.rto_minutes : "n/a")}` +
              ` rpo=${String(offsiteRestorePayload && offsiteRestorePayload.metrics ? offsiteRestorePayload.metrics.rpo_hours : "n/a")}`
            );
          } else {
            console.log(` offsite_restore_drill unavailable reason=${String(offsiteRestore.stderr || offsiteRestore.stdout || "unknown").slice(0, 120)}`);
            if (restoreStrict) process.exit(offsiteRestore.code || 1);
          }
        } else {
          console.log(
            ` offsite_restore_drill not_due next=${String(offsiteStatusPayload && offsiteStatusPayload.restore_drill_next_due_ts || "unknown")}`
          );
        }
      } else {
        appendLedger(dateStr, {
          ts: nowIso(),
          type: "spine_offsite_restore_drill_skipped",
          mode,
          date: dateStr,
          reason: "feature_flag_disabled",
          flag: "SPINE_OFFSITE_RESTORE_DRILL_ENABLED",
          flag_value: String(process.env.SPINE_OFFSITE_RESTORE_DRILL_ENABLED || "")
        });
        console.log(" offsite_restore_drill skipped reason=feature_flag_disabled flag=SPINE_OFFSITE_RESTORE_DRILL_ENABLED");
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_offsite_backup_sync_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "STATE_BACKUP_OFFSITE_ENABLED",
        flag_value: String(process.env.STATE_BACKUP_OFFSITE_ENABLED || "")
      });
      console.log(" offsite_backup_sync skipped reason=feature_flag_disabled flag=STATE_BACKUP_OFFSITE_ENABLED");
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
        if (strict) process.exit(backupIntegrity.code || 1);
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

    // 6) centralized cleanup orchestrator (state churn + backup retention + optional cryonics).
    const cleanupOrchestratorEnabled = String(process.env.SPINE_CLEANUP_ORCHESTRATOR_ENABLED || "1") !== "0";
    if (cleanupOrchestratorEnabled) {
      const cleanupProfile = String(process.env.SPINE_CLEANUP_ORCHESTRATOR_PROFILE || "spine_default").trim() || "spine_default";
      const cleanupArgs = [
        "systems/ops/cleanup_orchestrator.js",
        "run",
        `--profile=${cleanupProfile}`
      ];
      const cleanupApply = String(process.env.SPINE_CLEANUP_ORCHESTRATOR_APPLY || "1") !== "0";
      const cleanupDryRun = String(process.env.SPINE_CLEANUP_ORCHESTRATOR_DRY_RUN || "0") === "1";
      if (!cleanupApply) cleanupArgs.push("--apply=0");
      if (cleanupDryRun) cleanupArgs.push("--dry-run=1");
      if (String(process.env.CLEANUP_ORCHESTRATOR_POLICY_PATH || "").trim()) {
        cleanupArgs.push(`--policy=${String(process.env.CLEANUP_ORCHESTRATOR_POLICY_PATH).trim()}`);
      }
      const cleanup = runJson("node", cleanupArgs);
      const cleanupPayload = cleanup.payload && typeof cleanup.payload === "object" ? cleanup.payload : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_cleanup_orchestrator",
        mode,
        date: dateStr,
        ok: cleanup.ok && !!cleanupPayload && cleanupPayload.ok === true,
        profile: cleanupPayload ? cleanupPayload.profile || cleanupProfile : cleanupProfile,
        forced_dry_run: cleanupPayload ? cleanupPayload.forced_dry_run === true : null,
        tasks_executed: cleanupPayload ? Number(cleanupPayload.tasks_executed || 0) : null,
        tasks_failed: cleanupPayload ? Number(cleanupPayload.tasks_failed || 0) : null,
        critical_failures: cleanupPayload ? Number(cleanupPayload.critical_failures || 0) : null,
        state_deleted: cleanupPayload ? Number(cleanupPayload.state_deleted || 0) : null,
        backups_moved: cleanupPayload ? Number(cleanupPayload.backups_moved || 0) : null,
        cryonics_archived: cleanupPayload ? Number(cleanupPayload.cryonics_archived || 0) : null,
        reason: (!cleanup.ok || !cleanupPayload || cleanupPayload.ok !== true)
          ? String(cleanup.stderr || cleanup.stdout || `cleanup_orchestrator_exit_${cleanup.code}`).slice(0, 180)
          : null
      });
      if (cleanup.ok && cleanupPayload && cleanupPayload.ok === true) {
        console.log(
          ` cleanup_orchestrator profile=${String(cleanupPayload.profile || cleanupProfile)}` +
          ` tasks=${Number(cleanupPayload.tasks_executed || 0)}` +
          ` failed=${Number(cleanupPayload.tasks_failed || 0)}` +
          ` state_deleted=${Number(cleanupPayload.state_deleted || 0)}`
        );
      } else {
        console.log(` cleanup_orchestrator unavailable reason=${String(cleanup.stderr || cleanup.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_cleanup_orchestrator_skipped",
        mode,
        date: dateStr,
        reason: "feature_flag_disabled",
        flag: "SPINE_CLEANUP_ORCHESTRATOR_ENABLED",
        flag_value: String(process.env.SPINE_CLEANUP_ORCHESTRATOR_ENABLED || "")
      });
      console.log(" cleanup_orchestrator skipped reason=feature_flag_disabled flag=SPINE_CLEANUP_ORCHESTRATOR_ENABLED");
    }

    // 6a) external OpenClaw config backup retention fallback path (legacy mode).
    if (!cleanupOrchestratorEnabled && String(process.env.SPINE_OPENCLAW_BACKUP_RETENTION || "1") !== "0") {
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
        reason: cleanupOrchestratorEnabled ? "delegated_to_cleanup_orchestrator" : "feature_flag_disabled",
        flag: "SPINE_OPENCLAW_BACKUP_RETENTION",
        flag_value: String(process.env.SPINE_OPENCLAW_BACKUP_RETENTION || "")
      });
      console.log(
        cleanupOrchestratorEnabled
          ? " openclaw_backup_retention skipped reason=delegated_to_cleanup_orchestrator"
          : " openclaw_backup_retention skipped reason=feature_flag_disabled flag=SPINE_OPENCLAW_BACKUP_RETENTION"
      );
    }

    // 6b) runtime state cleanup fallback path (legacy mode).
    if (!cleanupOrchestratorEnabled && String(process.env.SPINE_STATE_CLEANUP_ENABLED || "1") !== "0") {
      const cleanupArgs = ["systems/ops/state_cleanup.js", "run"];
      const cleanupProfile = String(process.env.SPINE_STATE_CLEANUP_PROFILE || "runtime_churn").trim() || "runtime_churn";
      cleanupArgs.push(`--profile=${cleanupProfile}`);
      if (String(process.env.SPINE_STATE_CLEANUP_MAX_DELETE || "").trim()) {
        cleanupArgs.push(`--max-delete=${String(process.env.SPINE_STATE_CLEANUP_MAX_DELETE).trim()}`);
      }
      const cleanupApply = String(process.env.SPINE_STATE_CLEANUP_APPLY || "1") !== "0";
      const cleanupDryRun = String(process.env.SPINE_STATE_CLEANUP_DRY_RUN || "0") === "1";
      if (cleanupApply && !cleanupDryRun) cleanupArgs.push("--apply");
      if (cleanupDryRun) cleanupArgs.push("--dry-run");
      const cleanup = runJson("node", cleanupArgs);
      const cleanupPayload = cleanup.payload && typeof cleanup.payload === "object" ? cleanup.payload : null;
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_state_cleanup",
        mode,
        date: dateStr,
        ok: cleanup.ok && !!cleanupPayload && cleanupPayload.ok === true,
        profile: cleanupPayload ? cleanupPayload.profile || cleanupProfile : cleanupProfile,
        dry_run: cleanupPayload ? cleanupPayload.dry_run === true : null,
        candidates: cleanupPayload && cleanupPayload.totals ? Number(cleanupPayload.totals.candidates || 0) : null,
        selected: cleanupPayload && cleanupPayload.totals ? Number(cleanupPayload.totals.selected || 0) : null,
        deleted: cleanupPayload && cleanupPayload.totals ? Number(cleanupPayload.totals.deleted || 0) : null,
        protected_tracked: cleanupPayload && cleanupPayload.totals ? Number(cleanupPayload.totals.protected_tracked || 0) : null,
        reason: (!cleanup.ok || !cleanupPayload || cleanupPayload.ok !== true)
          ? String(cleanup.stderr || cleanup.stdout || `state_cleanup_exit_${cleanup.code}`).slice(0, 180)
          : null
      });
      if (cleanup.ok && cleanupPayload && cleanupPayload.ok === true) {
        console.log(
          ` state_cleanup profile=${String(cleanupPayload.profile || cleanupProfile)}` +
          ` deleted=${Number(cleanupPayload.totals && cleanupPayload.totals.deleted || 0)}` +
          ` selected=${Number(cleanupPayload.totals && cleanupPayload.totals.selected || 0)}` +
          ` candidates=${Number(cleanupPayload.totals && cleanupPayload.totals.candidates || 0)}` +
          ` dry_run=${cleanupPayload.dry_run === true ? "1" : "0"}`
        );
      } else {
        console.log(` state_cleanup unavailable reason=${String(cleanup.stderr || cleanup.stdout || "unknown").slice(0, 120)}`);
      }
    } else {
      appendLedger(dateStr, {
        ts: nowIso(),
        type: "spine_state_cleanup_skipped",
        mode,
        date: dateStr,
        reason: cleanupOrchestratorEnabled ? "delegated_to_cleanup_orchestrator" : "feature_flag_disabled",
        flag: "SPINE_STATE_CLEANUP_ENABLED",
        flag_value: String(process.env.SPINE_STATE_CLEANUP_ENABLED || "")
      });
      console.log(
        cleanupOrchestratorEnabled
          ? " state_cleanup skipped reason=delegated_to_cleanup_orchestrator"
          : " state_cleanup skipped reason=feature_flag_disabled flag=SPINE_STATE_CLEANUP_ENABLED"
      );
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
  const ternary = emitSpineTernaryBelief(dateStr, mode, {
    signal_gate_ok: signalGateOk,
    signal_slo_ok: signalSloOk
  });
  maybeEmitSpineTritAnomaly(dateStr, mode, ternary);
  if (String(process.env.SPINE_OBSERVABILITY_ENABLED || "1") !== "0"
    && String(process.env.SPINE_OBSERVABILITY_TRACE_ENABLED || "1") !== "0") {
    const finalStatus = signalGateOk === true && signalSloOk === true ? "ok" : "warn";
    const finalTrace = runJson("node", [
      "systems/observability/trace_bridge.js",
      "span",
      "--name=spine.run.completed",
      `--status=${finalStatus}`,
      `--duration-ms=${Math.max(0, Date.now() - spineRunStartMs)}`,
      "--component=spine",
      `--attrs-json=${JSON.stringify({
        mode,
        date: dateStr,
        signal_gate_ok: signalGateOk === true,
        signal_slo_ok: signalSloOk === true
      })}`
    ]);
    const finalTracePayload = finalTrace.payload && typeof finalTrace.payload === "object" ? finalTrace.payload : null;
    appendLedger(dateStr, {
      ts: nowIso(),
      type: "spine_observability_trace",
      mode,
      date: dateStr,
      window: "run_completed",
      ok: finalTrace.ok && !!finalTracePayload && finalTracePayload.ok === true,
      trace_name: finalTracePayload && finalTracePayload.span ? finalTracePayload.span.name || null : null,
      trace_status: finalTracePayload && finalTracePayload.span ? finalTracePayload.span.status || null : null,
      trace_duration_ms: finalTracePayload && finalTracePayload.span ? Number(finalTracePayload.span.duration_ms || 0) : null,
      reason: (!finalTrace.ok || !finalTracePayload || finalTracePayload.ok !== true)
        ? String(finalTrace.stderr || finalTrace.stdout || `observability_trace_exit_${finalTrace.code}`).slice(0, 180)
        : null
    });
  }

  if (mode === "daily") {
    const pending = modelCatalogPendingCount();
    console.log(` model_catalog_apply_pending=${pending}`);
  }

  console.log(` ✅ spine complete (${mode}) for ${dateStr}`);
}

main();
export {};
