#!/usr/bin/env node
/**
 * systems/routing/model_router.js — deterministic model routing v2 (builds on V1)
 *
 * Adds on top of V1:
 * - role-aware + tier-aware scoring
 * - outcome-aware scoring from autonomy run history
 * - switch tracking + model-change events
 * - deterministic escalation chain for fallback
 */

const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = process.env.ROUTER_CONFIG_PATH || path.join(REPO_ROOT, "config", "agent_routing_rules.json");
const MODE_ADAPTERS_PATH = process.env.ROUTER_MODE_ADAPTERS_PATH || path.join(REPO_ROOT, "config", "model_adapters.json");
const STATE_DIR = process.env.ROUTER_STATE_DIR || path.join(REPO_ROOT, "state", "routing");
const AUTONOMY_RUNS_DIR = process.env.ROUTER_AUTONOMY_RUNS_DIR || path.join(REPO_ROOT, "state", "autonomy", "runs");
const HEALTH_PATH = path.join(STATE_DIR, "model_health.json");
const HEALTH_RECORDS_DIR = path.join(STATE_DIR, "model_health");
const BANS_PATH = path.join(STATE_DIR, "banned_models.json");
const DECISIONS_LOG = path.join(STATE_DIR, "routing_decisions.jsonl");
const ROUTE_STATE_PATH = path.join(STATE_DIR, "route_state.json");
const OUTCOME_STATS_PATH = path.join(STATE_DIR, "model_outcomes.json");
const HARDWARE_PLAN_PATH = path.join(STATE_DIR, "hardware_plan.json");
const ROUTER_BUDGET_DIR = process.env.ROUTER_BUDGET_DIR || path.join(REPO_ROOT, "state", "autonomy", "daily_budget");
const ROUTER_BUDGET_TODAY = process.env.ROUTER_BUDGET_TODAY || "";
const ROUTER_SPEND_DIR = process.env.ROUTER_SPEND_DIR || path.join(STATE_DIR, "spend");

const PROBE_TTL_MS = Number(process.env.ROUTER_PROBE_TTL_MS || 30 * 60 * 1000);
const PROBE_TIMEOUT_MS = Number(process.env.ROUTER_PROBE_TIMEOUT_MS || 15000);
const BAN_MS = Number(process.env.ROUTER_BAN_MS || 6 * 60 * 60 * 1000);
const OUTCOME_WINDOW_DAYS = Number(process.env.ROUTER_OUTCOME_WINDOW_DAYS || 14);
const MIN_ATTEMPTS_FOR_OUTCOME_WEIGHT = Number(process.env.ROUTER_MIN_ATTEMPTS_FOR_OUTCOME_WEIGHT || 2);
const T1_LOCAL_FIRST = String(process.env.ROUTER_T1_LOCAL_FIRST || "1") !== "0";
const T1_LOCAL_MAX_LATENCY_MS = Number(process.env.ROUTER_T1_LOCAL_MAX_LATENCY_MS || 9000);
const T1_LOCAL_MIN_OUTCOME_SCORE = Number(process.env.ROUTER_T1_LOCAL_MIN_OUTCOME_SCORE || -5);
const HOST_CACHE_MAX_STALE_MS = Number(process.env.ROUTER_HOST_CACHE_MAX_STALE_MS || 24 * 60 * 60 * 1000);
const PROBE_ACCEPT_OK_TOKEN = String(process.env.ROUTER_PROBE_ACCEPT_OK_TOKEN || "1") !== "0";
const ROUTER_MIN_REQUEST_TOKENS = Number(process.env.ROUTER_MIN_REQUEST_TOKENS || 120);
const ROUTER_MAX_REQUEST_TOKENS = Number(process.env.ROUTER_MAX_REQUEST_TOKENS || 12000);

const GENERIC_MARKERS = [
  "as an ai", "i'm an ai", "i cannot", "i can't access", "i don't have access",
  "i'd be happy to", "here's a step-by-step guide", "to assist you effectively", "agilenix"
];

const DEFAULT_FAST_PATH_DISALLOW_REGEXES = [
  "https?:\\/\\/",
  "(^|\\s)--?[a-z0-9][a-z0-9_-]*\\b",
  "\\b(node|npm|pnpm|yarn|git|curl|python|bash|zsh|ollama)\\b",
  "[`{}\\[\\]<>$;=]",
  "(^|\\s)(~\\/|\\.\\.?\\/|\\/users\\/|[a-z]:\\\\)"
];

function isEnvProbeBlockedText(s) {
  const t = String(s || "").toLowerCase();
  if (!t) return false;
  if (t.includes("operation not permitted") && t.includes("11434")) return true;
  if (t.includes("permission denied") && t.includes("11434")) return true;
  if (t.includes("sandbox") && t.includes("11434")) return true;
  return false;
}

function normalizeProbeBlockedRecord(rec) {
  const r = rec && typeof rec === "object" ? { ...rec } : null;
  if (!r) return { rec: null, changed: false };
  const txt = `${String(r.reason || "")} ${String(r.stderr || "")}`;
  const blocked = r.probe_blocked === true || isEnvProbeBlockedText(txt);
  if (!blocked) return { rec: r, changed: false };
  let changed = false;
  if (r.probe_blocked !== true) {
    r.probe_blocked = true;
    changed = true;
  }
  if (r.reason !== "env_probe_blocked") {
    r.reason = "env_probe_blocked";
    changed = true;
  }
  if (r.available !== null) {
    r.available = null;
    changed = true;
  }
  return { rec: r, changed };
}

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function loadJson(p, fallback) {
  try {
    if (!fs.existsSync(p)) return fallback;
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}

function saveJson(p, obj) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
}

function appendJsonl(p, obj) {
  ensureDir(path.dirname(p));
  fs.appendFileSync(p, JSON.stringify(obj) + "\n");
}

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  const lines = fs.readFileSync(p, "utf8").split("\n").filter(Boolean);
  const out = [];
  for (const line of lines) {
    try { out.push(JSON.parse(line)); } catch {}
  }
  return out;
}

function writeJsonAtomic(p, obj) {
  ensureDir(path.dirname(p));
  const tmp = `${p}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

function hardwarePlannerPolicyFromConfig(cfg) {
  const raw = cfg && cfg.routing && cfg.routing.local_hardware_planner && typeof cfg.routing.local_hardware_planner === "object"
    ? cfg.routing.local_hardware_planner
    : {};
  const classThresholdsRaw = Array.isArray(raw.class_thresholds) && raw.class_thresholds.length
    ? raw.class_thresholds
    : [
        { id: "tiny", max_ram_gb: 8, max_cpu_threads: 4 },
        { id: "small", max_ram_gb: 16, max_cpu_threads: 8 },
        { id: "medium", max_ram_gb: 32, max_cpu_threads: 16 },
        { id: "large", max_ram_gb: 64, max_cpu_threads: 32 },
        { id: "xlarge" }
      ];
  const classThresholds = classThresholdsRaw.map((entry, idx) => {
    const id = normalizeKey(entry && entry.id || `class_${idx + 1}`) || `class_${idx + 1}`;
    return {
      id,
      max_ram_gb: Number(entry && entry.max_ram_gb),
      max_cpu_threads: Number(entry && entry.max_cpu_threads),
      max_vram_gb: Number(entry && entry.max_vram_gb)
    };
  });
  const localReqs = raw.local_model_requirements && typeof raw.local_model_requirements === "object"
    ? raw.local_model_requirements
    : {};

  return {
    enabled: toBool(raw.enabled, true),
    activate_recommended_locals: toBool(raw.activate_recommended_locals, true),
    class_thresholds: classThresholds,
    local_model_requirements: localReqs
  };
}

function envNumber(keys, fallback = null) {
  for (const k of keys) {
    const raw = process.env[k];
    if (raw == null || String(raw).trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) return n;
  }
  return fallback;
}

function detectHardwareProfile() {
  const cpuThreads = (() => {
    try {
      const cpus = os.cpus();
      if (Array.isArray(cpus) && cpus.length) return cpus.length;
    } catch {}
    return null;
  })();
  const ramGb = (() => {
    try {
      const total = Number(os.totalmem() || 0);
      if (Number.isFinite(total) && total > 0) {
        return Number((total / (1024 * 1024 * 1024)).toFixed(2));
      }
    } catch {}
    return null;
  })();

  const base = {
    detected_at: nowIso(),
    source: "os",
    platform: String(os.platform ? os.platform() : ""),
    arch: String(os.arch ? os.arch() : ""),
    cpu_threads: cpuThreads,
    ram_gb: ramGb,
    gpu_vram_gb: null
  };

  const overrideJsonRaw = String(process.env.ROUTER_HW_PROFILE_JSON || "").trim();
  if (overrideJsonRaw) {
    try {
      const parsed = JSON.parse(overrideJsonRaw);
      if (parsed && typeof parsed === "object") {
        if (Number.isFinite(Number(parsed.cpu_threads))) base.cpu_threads = Number(parsed.cpu_threads);
        if (Number.isFinite(Number(parsed.ram_gb))) base.ram_gb = Number(parsed.ram_gb);
        if (Number.isFinite(Number(parsed.gpu_vram_gb))) base.gpu_vram_gb = Number(parsed.gpu_vram_gb);
        if (parsed.platform) base.platform = String(parsed.platform);
        if (parsed.arch) base.arch = String(parsed.arch);
        base.source = "env_json_override";
      }
    } catch {}
  }

  const envVram = envNumber(["ROUTER_GPU_VRAM_GB", "ROUTER_VRAM_GB"], null);
  if (envVram != null && Number.isFinite(Number(envVram))) {
    base.gpu_vram_gb = Number(envVram);
    if (base.source === "os") base.source = "env_override";
  }
  const envCpu = envNumber(["ROUTER_CPU_THREADS"], null);
  if (envCpu != null && Number.isFinite(Number(envCpu))) {
    base.cpu_threads = Number(envCpu);
    if (base.source === "os") base.source = "env_override";
  }
  const envRam = envNumber(["ROUTER_RAM_GB"], null);
  if (envRam != null && Number.isFinite(Number(envRam))) {
    base.ram_gb = Number(envRam);
    if (base.source === "os") base.source = "env_override";
  }

  return base;
}

function metricFitsMax(value, maxValue) {
  if (!Number.isFinite(Number(maxValue))) return true;
  if (!Number.isFinite(Number(value))) return false;
  return Number(value) <= Number(maxValue);
}

function classifyHardwareClass(profile, thresholds) {
  const ordered = Array.isArray(thresholds) ? thresholds : [];
  if (!ordered.length) return "unknown";
  for (const t of ordered) {
    const ok = metricFitsMax(profile.ram_gb, t.max_ram_gb)
      && metricFitsMax(profile.cpu_threads, t.max_cpu_threads)
      && metricFitsMax(profile.gpu_vram_gb, t.max_vram_gb);
    if (ok) return normalizeKey(t.id || "") || "unknown";
  }
  const last = ordered[ordered.length - 1];
  return normalizeKey(last && last.id || "") || "unknown";
}

function hardwareClassRankMap(thresholds) {
  const out = {};
  const ordered = Array.isArray(thresholds) ? thresholds : [];
  for (let i = 0; i < ordered.length; i++) {
    const id = normalizeKey(ordered[i] && ordered[i].id || "");
    if (!id) continue;
    out[id] = i;
  }
  return out;
}

function hardwareClassAtLeast(currentClass, minClass, rankMap) {
  const cur = normalizeKey(currentClass || "");
  const min = normalizeKey(minClass || "");
  if (!min) return true;
  if (!cur) return false;
  if (Object.prototype.hasOwnProperty.call(rankMap || {}, cur) && Object.prototype.hasOwnProperty.call(rankMap || {}, min)) {
    return Number(rankMap[cur]) >= Number(rankMap[min]);
  }
  return cur === min;
}

function localModelRequirementFor(modelId, policy) {
  const reqs = policy && policy.local_model_requirements && typeof policy.local_model_requirements === "object"
    ? policy.local_model_requirements
    : {};
  for (const k of localAliasSet(modelId)) {
    if (reqs[k] && typeof reqs[k] === "object") return reqs[k];
  }
  return null;
}

function evaluateLocalModelHardwareEligibility(modelId, profile, policy, rankMap) {
  const req = localModelRequirementFor(modelId, policy);
  if (!req) {
    return { eligible: true, reasons: [], requirement: null };
  }

  const reasons = [];
  const minClass = normalizeKey(req.min_hardware_class || "");
  if (minClass && !hardwareClassAtLeast(profile.hardware_class, minClass, rankMap)) {
    reasons.push(`hardware_class_below_min:${minClass}`);
  }
  const minRam = Number(req.min_ram_gb);
  if (Number.isFinite(minRam)) {
    if (!Number.isFinite(Number(profile.ram_gb)) || Number(profile.ram_gb) < minRam) {
      reasons.push(`ram_below_min:${minRam}`);
    }
  }
  const minCpu = Number(req.min_cpu_threads);
  if (Number.isFinite(minCpu)) {
    if (!Number.isFinite(Number(profile.cpu_threads)) || Number(profile.cpu_threads) < minCpu) {
      reasons.push(`cpu_below_min:${minCpu}`);
    }
  }
  const minVram = Number(req.min_vram_gb);
  if (Number.isFinite(minVram)) {
    if (!Number.isFinite(Number(profile.gpu_vram_gb)) || Number(profile.gpu_vram_gb) < minVram) {
      reasons.push(`vram_below_min:${minVram}`);
    }
  }

  return {
    eligible: reasons.length === 0,
    reasons,
    requirement: {
      min_hardware_class: minClass || null,
      min_ram_gb: Number.isFinite(minRam) ? minRam : null,
      min_cpu_threads: Number.isFinite(minCpu) ? minCpu : null,
      min_vram_gb: Number.isFinite(minVram) ? minVram : null
    }
  };
}

function buildHardwarePlan(cfg, allowlist) {
  const policy = hardwarePlannerPolicyFromConfig(cfg);
  const forcedClass = normalizeKey(process.env.ROUTER_HW_CLASS || "");
  const profile = detectHardwareProfile();
  const thresholds = policy.class_thresholds || [];
  const rankMap = hardwareClassRankMap(thresholds);
  const inferredClass = classifyHardwareClass(profile, thresholds);
  profile.hardware_class = forcedClass || inferredClass || "unknown";
  profile.hardware_class_source = forcedClass ? "env_forced" : "inferred";

  const locals = (Array.isArray(allowlist) ? allowlist : [])
    .filter((m) => isLocalOllamaModel(m))
    .sort((a, b) => String(a).localeCompare(String(b)));
  const evaluations = [];
  for (const model of locals) {
    const ev = evaluateLocalModelHardwareEligibility(model, profile, policy, rankMap);
    evaluations.push({
      model,
      eligible: ev.eligible,
      reasons: ev.reasons.slice(0),
      requirement: ev.requirement
    });
  }
  const eligibleLocals = evaluations.filter((e) => e.eligible).map((e) => e.model);
  const blockedLocals = evaluations.filter((e) => !e.eligible);
  const effectiveLocals = policy.enabled && policy.activate_recommended_locals
    ? eligibleLocals.slice(0)
    : locals.slice(0);

  return {
    enabled: policy.enabled === true,
    activate_recommended_locals: policy.activate_recommended_locals === true,
    thresholds: thresholds.map((t) => ({
      id: normalizeKey(t.id || ""),
      max_ram_gb: Number.isFinite(Number(t.max_ram_gb)) ? Number(t.max_ram_gb) : null,
      max_cpu_threads: Number.isFinite(Number(t.max_cpu_threads)) ? Number(t.max_cpu_threads) : null,
      max_vram_gb: Number.isFinite(Number(t.max_vram_gb)) ? Number(t.max_vram_gb) : null
    })),
    profile,
    local_models_total: locals.length,
    eligible_local_models: eligibleLocals,
    blocked_local_models: blockedLocals,
    effective_local_models: effectiveLocals
  };
}

function hardwarePlanHash(plan) {
  const payload = {
    enabled: !!(plan && plan.enabled),
    activate_recommended_locals: !!(plan && plan.activate_recommended_locals),
    hardware_class: String(plan && plan.profile && plan.profile.hardware_class || ""),
    cpu_threads: Number(plan && plan.profile && plan.profile.cpu_threads || 0),
    ram_gb: Number(plan && plan.profile && plan.profile.ram_gb || 0),
    gpu_vram_gb: Number(plan && plan.profile && plan.profile.gpu_vram_gb || 0),
    effective_local_models: Array.isArray(plan && plan.effective_local_models) ? plan.effective_local_models.slice(0).sort() : [],
    blocked_local_models: Array.isArray(plan && plan.blocked_local_models)
      ? plan.blocked_local_models.map((x) => ({
          model: String(x && x.model || ""),
          reasons: Array.isArray(x && x.reasons) ? x.reasons.slice(0).sort() : []
        })).sort((a, b) => a.model.localeCompare(b.model))
      : []
  };
  return crypto.createHash("sha1").update(JSON.stringify(payload)).digest("hex").slice(0, 16);
}

function applyHardwarePlanState(plan) {
  const prev = loadJson(HARDWARE_PLAN_PATH, {});
  const prevHash = String(prev && prev.plan_hash || "");
  const nextHash = hardwarePlanHash(plan);
  const payload = {
    ...plan,
    plan_hash: nextHash,
    updated_at: nowIso()
  };
  saveJson(HARDWARE_PLAN_PATH, payload);
  if (prevHash !== nextHash) {
    appendJsonl(DECISIONS_LOG, {
      ts: nowIso(),
      type: "hardware_plan_updated",
      previous_hash: prevHash || null,
      new_hash: nextHash,
      hardware_class: String(plan && plan.profile && plan.profile.hardware_class || ""),
      effective_local_models: Array.isArray(plan && plan.effective_local_models) ? plan.effective_local_models.slice(0) : []
    });
  }
  return payload;
}

function resolveHardwarePlan(cfg, allowlist) {
  const built = buildHardwarePlan(cfg, allowlist);
  return applyHardwarePlanState(built);
}

function localHardwareFilterEnabled(plan) {
  return !!(plan && plan.enabled === true && plan.activate_recommended_locals === true);
}

function effectiveLocalModelSet(plan) {
  const set = new Set();
  const arr = Array.isArray(plan && plan.effective_local_models) ? plan.effective_local_models : [];
  for (const model of arr) {
    const key = String(model || "").trim();
    if (!key) continue;
    set.add(key);
  }
  return set;
}

function blockedLocalReasonMap(plan) {
  const out = {};
  const arr = Array.isArray(plan && plan.blocked_local_models) ? plan.blocked_local_models : [];
  for (const item of arr) {
    const model = String(item && item.model || "").trim();
    if (!model) continue;
    out[model] = Array.isArray(item && item.reasons) ? item.reasons.slice(0) : [];
  }
  return out;
}

function hardwarePlanSummary(plan) {
  return {
    enabled: !!(plan && plan.enabled === true),
    active_filter: localHardwareFilterEnabled(plan),
    hardware_class: String(plan && plan.profile && plan.profile.hardware_class || ""),
    hardware_class_source: String(plan && plan.profile && plan.profile.hardware_class_source || ""),
    profile_source: String(plan && plan.profile && plan.profile.source || ""),
    cpu_threads: Number.isFinite(Number(plan && plan.profile && plan.profile.cpu_threads))
      ? Number(plan.profile.cpu_threads)
      : null,
    ram_gb: Number.isFinite(Number(plan && plan.profile && plan.profile.ram_gb))
      ? Number(plan.profile.ram_gb)
      : null,
    gpu_vram_gb: Number.isFinite(Number(plan && plan.profile && plan.profile.gpu_vram_gb))
      ? Number(plan.profile.gpu_vram_gb)
      : null,
    local_models_total: Number(plan && plan.local_models_total || 0),
    effective_local_models: Array.isArray(plan && plan.effective_local_models) ? plan.effective_local_models.slice(0) : [],
    blocked_local_models: Array.isArray(plan && plan.blocked_local_models)
      ? plan.blocked_local_models.map((item) => ({
          model: String(item && item.model || ""),
          reasons: Array.isArray(item && item.reasons) ? item.reasons.slice(0) : []
        }))
      : [],
    plan_hash: String(plan && plan.plan_hash || "")
  };
}

function normalizeRuntimeScope(v) {
  const s = String(v || "").trim().toLowerCase();
  if (s === "host") return "host";
  if (s === "sandbox") return "sandbox";
  return "";
}

function detectRuntimeScope() {
  const forced = normalizeRuntimeScope(process.env.ROUTER_RUNTIME_SCOPE || "");
  if (forced) return forced;
  if (String(process.env.CODEX_SANDBOX || "") !== "") return "sandbox";
  return "host";
}

function runtimePreferenceOrder(forRouting, currentRuntime) {
  const raw = forRouting
    ? ["host", currentRuntime, "sandbox"]
    : [currentRuntime, "host", "sandbox"];
  const out = [];
  for (const r of raw) {
    const n = normalizeRuntimeScope(r);
    if (!n) continue;
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function looksLikeHealthRecord(v) {
  return !!(v && typeof v === "object" && typeof v.model === "string");
}

function cleanHealthRecordMap(obj) {
  const out = {};
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return out;
  for (const [k, v] of Object.entries(obj)) {
    if (!v || typeof v !== "object" || Array.isArray(v)) continue;
    const model = typeof v.model === "string" ? v.model : String(k);
    out[model] = { ...v, model };
  }
  return out;
}

function parseHealthSnapshot(raw) {
  const out = { runtimes: {} };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;

  if (Number(raw.schema_version || 0) >= 2 && raw.runtimes && typeof raw.runtimes === "object") {
    for (const [runtimeRaw, mapRaw] of Object.entries(raw.runtimes)) {
      const runtime = normalizeRuntimeScope(runtimeRaw);
      if (!runtime) continue;
      const cleaned = cleanHealthRecordMap(mapRaw);
      if (Object.keys(cleaned).length) out.runtimes[runtime] = cleaned;
    }
    if (Object.keys(out.runtimes).length) return out;
  }

  if (raw.records && typeof raw.records === "object") {
    const active = normalizeRuntimeScope(raw.active_runtime || "") || "host";
    const cleaned = cleanHealthRecordMap(raw.records);
    if (Object.keys(cleaned).length) {
      out.runtimes[active] = cleaned;
      return out;
    }
  }

  // Legacy flat map format (model -> health record)
  const legacy = cleanHealthRecordMap(raw);
  if (Object.keys(legacy).length) out.runtimes.host = legacy;
  return out;
}

function listRuntimeScopesFromDir() {
  if (!fs.existsSync(HEALTH_RECORDS_DIR)) return [];
  const out = [];
  const entries = fs.readdirSync(HEALTH_RECORDS_DIR, { withFileTypes: true });
  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const runtime = normalizeRuntimeScope(ent.name);
    if (!runtime) continue;
    if (!out.includes(runtime)) out.push(runtime);
  }
  return out;
}

function loadRuntimeHealthFromDir(runtime) {
  const out = {};
  const dir = path.join(HEALTH_RECORDS_DIR, runtime);
  if (!fs.existsSync(dir)) return out;
  const files = fs.readdirSync(dir).filter(f => f.endsWith(".json"));
  for (const f of files) {
    const p = path.join(dir, f);
    const rec = loadJson(p, null);
    if (!looksLikeHealthRecord(rec)) continue;
    out[rec.model] = rec;
  }
  return out;
}

function loadAllHealthCaches() {
  const fromSnapshot = parseHealthSnapshot(loadJson(HEALTH_PATH, null)).runtimes;
  const out = {};
  for (const [runtime, map] of Object.entries(fromSnapshot)) {
    out[runtime] = { ...(out[runtime] || {}), ...cleanHealthRecordMap(map) };
  }
  for (const runtime of listRuntimeScopesFromDir()) {
    const map = loadRuntimeHealthFromDir(runtime);
    out[runtime] = { ...(out[runtime] || {}), ...map };
  }
  return out;
}

function modelHealthRecordPath(runtime, modelId) {
  const safe = encodeURIComponent(String(modelId || "")).replace(/%/g, "_").slice(0, 96);
  const hash = crypto.createHash("sha1").update(String(modelId || "")).digest("hex").slice(0, 12);
  return path.join(HEALTH_RECORDS_DIR, runtime, `${safe}__${hash}.json`);
}

function writeHealthSnapshotCompat(allCaches, activeRuntime) {
  const runtime = normalizeRuntimeScope(activeRuntime) || detectRuntimeScope();
  const runtimes = {};
  for (const [k, v] of Object.entries(allCaches || {})) {
    const key = normalizeRuntimeScope(k);
    if (!key) continue;
    const cleaned = cleanHealthRecordMap(v);
    if (!Object.keys(cleaned).length) continue;
    runtimes[key] = cleaned;
  }
  const records = cleanHealthRecordMap(runtimes[runtime] || {});
  const payload = {
    schema_version: 2,
    updated_at: nowIso(),
    active_runtime: runtime,
    runtimes,
    records
  };
  writeJsonAtomic(HEALTH_PATH, payload);
}

function saveHealthRecord(runtimeRaw, modelId, recordRaw) {
  const runtime = normalizeRuntimeScope(runtimeRaw) || detectRuntimeScope();
  const model = String(modelId || "").trim();
  if (!model) return;
  const record = {
    ...(recordRaw && typeof recordRaw === "object" ? recordRaw : {}),
    model,
    runtime_scope: runtime
  };

  // Atomic per-model write avoids whole-file clobber from concurrent probes.
  writeJsonAtomic(modelHealthRecordPath(runtime, model), record);

  const all = loadAllHealthCaches();
  if (!all[runtime]) all[runtime] = {};
  all[runtime][model] = record;
  writeHealthSnapshotCompat(all, runtime);
}

function parseArg(name) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}

function parseListArg(name) {
  const pref = `--${name}=`;
  const out = [];
  for (const arg of process.argv) {
    if (!arg.startsWith(pref)) continue;
    const raw = String(arg.slice(pref.length) || "");
    for (const part of raw.split(",")) {
      const v = String(part || "").trim();
      if (!v) continue;
      if (!out.includes(v)) out.push(v);
    }
  }
  return out;
}

function parseBoolArg(name, fallback = false) {
  const raw = parseArg(name);
  if (raw == null) return fallback;
  const s = String(raw).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`routing config missing: ${CONFIG_PATH}`);
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function isLocalOllamaModel(modelId) {
  if (!modelId || typeof modelId !== "string") return false;
  if (!modelId.startsWith("ollama/")) return false;
  if (modelId.includes(":cloud")) return false;
  return true;
}

function isCloudModel(modelId) {
  const m = String(modelId || "");
  if (!m) return false;
  if (m.includes(":cloud")) return true;
  if (!m.startsWith("ollama/")) return true;
  return false;
}

function ollamaModelName(modelId) {
  return modelId.replace(/^ollama\//, "");
}

function normalizeKey(s) {
  return String(s || "").trim().toLowerCase();
}

function inferRole(intent, task) {
  const txt = `${intent || ""} ${task || ""}`.toLowerCase();
  const tests = [
    { role: "coding", rx: /\b(code|refactor|patch|bug|test|typescript|javascript|python|node|compile)\b/ },
    { role: "tools", rx: /\b(tool|api|curl|exec|command|shell|cli|automation|integrat)\b/ },
    { role: "swarm", rx: /\b(swarm|multi-agent|handoff|delegate|parallel agent)\b/ },
    { role: "planning", rx: /\b(plan|roadmap|strategy|priorit|backlog|roi)\b/ },
    { role: "logic", rx: /\b(prove|formal|derive|reason|logic|constraint)\b/ },
    { role: "chat", rx: /\b(chat|reply|post|comment|write|summar|explain)\b/ }
  ];
  for (const t of tests) if (t.rx.test(txt)) return t.role;
  return "general";
}

function normalizeCapabilityKey(v) {
  const s = normalizeKey(v);
  if (!s) return "";
  return s.replace(/[^a-z0-9:_-]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "").slice(0, 72);
}

function inferCapability(intent, task, role) {
  const txt = `${intent || ""} ${task || ""}`.toLowerCase();
  const tests = [
    { key: "file_edit", rx: /\b(edit|patch|refactor|rewrite|modify|fix)\b/ },
    { key: "file_read", rx: /\b(read|list|show|inspect|cat)\b/ },
    { key: "tool_use", rx: /\b(tool|api|curl|exec|command|shell|cli|automation)\b/ },
    { key: "planning", rx: /\b(plan|roadmap|strategy|priorit|backlog|roi)\b/ },
    { key: "chat", rx: /\b(reply|respond|chat|comment|summar|explain)\b/ }
  ];
  for (const t of tests) {
    if (t.rx.test(txt)) return t.key;
  }
  const r = normalizeKey(role || "");
  return r ? `role:${r}` : "general";
}

function loadOutcomeStatsCached() {
  const cached = loadJson(OUTCOME_STATS_PATH, null);
  if (cached && typeof cached === "object" && cached.models && typeof cached.models === "object") {
    if (!cached.by_capability || typeof cached.by_capability !== "object") cached.by_capability = {};
    if (!cached.by_role || typeof cached.by_role !== "object") cached.by_role = {};
    return cached;
  }
  return {
    ts: nowIso(),
    window_days: OUTCOME_WINDOW_DAYS,
    cached_only: true,
    models: {},
    by_capability: {},
    by_role: {}
  };
}

function compileRegexSafe(pattern) {
  try {
    return new RegExp(String(pattern), "i");
  } catch {
    return null;
  }
}

function communicationFastPathPolicy(cfg) {
  const policy = cfg?.routing?.communication_fast_path;
  const src = policy && typeof policy === "object" ? policy : {};
  const patterns = Array.isArray(src.patterns) ? src.patterns.map(String) : [];
  const disallowRegexes = Array.isArray(src.disallow_regexes) && src.disallow_regexes.length
    ? src.disallow_regexes.map(String)
    : DEFAULT_FAST_PATH_DISALLOW_REGEXES.slice(0);
  return {
    enabled: toBool(src.enabled, true),
    match_mode: String(src.match_mode || "heuristic"),
    max_chars: toBoundedNumber(src.max_chars, 48, 8, 220),
    max_words: toBoundedNumber(src.max_words, 8, 1, 32),
    max_newlines: toBoundedNumber(src.max_newlines, 0, 0, 8),
    patterns,
    disallow_regexes: disallowRegexes,
    slot: String(src.slot || "grunt"),
    prefer_model: String(src.prefer_model || "ollama/smallthinker"),
    fallback_slot: String(src.fallback_slot || "fallback"),
    skip_outcome_scan: toBool(src.skip_outcome_scan, true)
  };
}

function detectCommunicationFastPath({ cfg, risk, complexity, intent, task, mode }) {
  const policy = communicationFastPathPolicy(cfg);
  if (!policy.enabled) return { matched: false, reason: "disabled", policy };

  const m = normalizeKey(mode || "normal");
  if (m === "deep-thinker" || m === "deep_thinker" || m === "hyper-creative" || m === "hyper_creative") {
    return { matched: false, reason: "mode_disallowed", policy };
  }
  if (normalizeKey(risk) !== "low") return { matched: false, reason: "risk_not_low", policy };
  const cx = normalizeKey(complexity || "medium");
  if (!(cx === "low" || cx === "medium")) return { matched: false, reason: "complexity_not_eligible", policy };

  const rawText = String(task || intent || "");
  const newlineCount = (rawText.match(/\n/g) || []).length;
  if (newlineCount > policy.max_newlines) return { matched: false, reason: "too_many_newlines", policy };
  const text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return { matched: false, reason: "empty_text", policy };
  const words = text.split(" ").filter(Boolean).length;
  if (text.length > policy.max_chars) return { matched: false, reason: "text_too_long", policy };
  if (words > policy.max_words) return { matched: false, reason: "word_count_too_high", policy };

  for (const raw of policy.disallow_regexes || []) {
    const rx = compileRegexSafe(raw);
    if (!rx) continue;
    if (rx.test(rawText)) return { matched: false, reason: "contains_structured_intent", blocked_pattern: raw, policy };
  }

  const structuralRole = inferRole(text, text);
  if (["coding", "tools", "swarm", "planning", "logic"].includes(normalizeKey(structuralRole))) {
    return { matched: false, reason: "role_not_chat_like", policy };
  }

  const matchMode = normalizeKey(policy.match_mode || "heuristic");
  if (matchMode === "patterns") {
    for (const raw of policy.patterns || []) {
      const rx = compileRegexSafe(raw);
      if (!rx) continue;
      if (rx.test(text)) {
        return {
          matched: true,
          reason: "communication_fast_path_pattern",
          matched_pattern: raw,
          text,
          slot: policy.slot,
          prefer_model: policy.prefer_model,
          fallback_slot: policy.fallback_slot,
          skip_outcome_scan: policy.skip_outcome_scan
        };
      }
    }
    return { matched: false, reason: "no_pattern_match", policy };
  }

  return {
    matched: true,
    reason: "communication_fast_path_heuristic",
    text,
    slot: policy.slot,
    prefer_model: policy.prefer_model,
    fallback_slot: policy.fallback_slot,
    skip_outcome_scan: policy.skip_outcome_scan
  };
}

function normalizeRiskLevel(v) {
  const r = normalizeKey(v || "");
  if (r === "low" || r === "medium" || r === "high") return r;
  return "medium";
}

function normalizeComplexityLevel(v) {
  const c = normalizeKey(v || "");
  if (c === "low" || c === "medium" || c === "high") return c;
  return "medium";
}

function routeClassPolicy(cfg, routeClassRaw) {
  const classes = cfg && cfg.routing && cfg.routing.route_classes && typeof cfg.routing.route_classes === "object"
    ? cfg.routing.route_classes
    : {};
  const id = normalizeKey(routeClassRaw || "default") || "default";
  const src = classes[id] && typeof classes[id] === "object" ? classes[id] : {};
  const reflexFallback = id === "reflex"
    ? {
        force_risk: "low",
        force_complexity: "low",
        force_role: "reflex",
        prefer_slot: "grunt",
        prefer_model: "ollama/smallthinker",
        fallback_slot: "fallback",
        disable_fast_path: true,
        max_tokens_est: 420
      }
    : {};
  const merged = { ...reflexFallback, ...src };
  const forceRiskRaw = normalizeKey(merged.force_risk || "");
  const forceComplexityRaw = normalizeKey(merged.force_complexity || "");

  const maxTokens = Number(merged.max_tokens_est);
  return {
    id,
    force_risk: (forceRiskRaw === "low" || forceRiskRaw === "medium" || forceRiskRaw === "high") ? forceRiskRaw : null,
    force_complexity: (forceComplexityRaw === "low" || forceComplexityRaw === "medium" || forceComplexityRaw === "high") ? forceComplexityRaw : null,
    force_role: normalizeKey(merged.force_role || ""),
    prefer_slot: String(merged.prefer_slot || "").trim() || null,
    prefer_model: String(merged.prefer_model || "").trim() || null,
    fallback_slot: String(merged.fallback_slot || "").trim() || null,
    disable_fast_path: toBool(merged.disable_fast_path, false),
    max_tokens_est: Number.isFinite(maxTokens) && maxTokens > 0 ? Math.max(50, Math.min(12000, Math.round(maxTokens))) : null
  };
}

function routerBudgetPolicy(cfg) {
  const src = cfg?.routing?.router_budget_policy;
  const policy = src && typeof src === "object" ? src : {};
  const dirRaw = String(policy.state_dir || ROUTER_BUDGET_DIR);
  const stateDir = path.isAbsolute(dirRaw) ? dirRaw : path.resolve(REPO_ROOT, dirRaw);
  const modelTokenMultipliers = policy.model_token_multipliers && typeof policy.model_token_multipliers === "object"
    ? policy.model_token_multipliers
    : {};
  const classTokenMultipliers = policy.class_token_multipliers && typeof policy.class_token_multipliers === "object"
    ? policy.class_token_multipliers
    : {};
  const defaultClassTokenMultipliers = {
    cheap_local: 0.42,
    local: 0.55,
    cloud_anchor: 1.15,
    cloud_specialist: 1.35,
    cloud: 1.2,
    default: 1
  };
  return {
    enabled: toBool(policy.enabled, true),
    state_dir: stateDir,
    soft_ratio: toBoundedNumber(policy.soft_ratio, 0.75, 0.2, 0.98),
    hard_ratio: toBoundedNumber(policy.hard_ratio, 0.92, 0.3, 0.995),
    enforce_hard_cap: toBool(policy.enforce_hard_cap, true),
    escalate_on_no_local_fallback: toBool(policy.escalate_on_no_local_fallback, true),
    cloud_penalty_soft: toBoundedNumber(policy.cloud_penalty_soft, 4, 0, 40),
    cloud_penalty_hard: toBoundedNumber(policy.cloud_penalty_hard, 10, 0, 60),
    cheap_local_bonus_soft: toBoundedNumber(policy.cheap_local_bonus_soft, 3, 0, 40),
    cheap_local_bonus_hard: toBoundedNumber(policy.cheap_local_bonus_hard, 7, 0, 60),
    model_token_multipliers: modelTokenMultipliers,
    class_token_multipliers: { ...defaultClassTokenMultipliers, ...classTokenMultipliers }
  };
}

function budgetDateStr() {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ROUTER_BUDGET_TODAY)) return ROUTER_BUDGET_TODAY;
  return nowIso().slice(0, 10);
}

function routerBudgetState(cfg) {
  const policy = routerBudgetPolicy(cfg);
  const out = {
    enabled: policy.enabled,
    available: false,
    pressure: "none",
    ratio: null,
    token_cap: null,
    used_est: null,
    path: null,
    policy
  };
  if (!policy.enabled) return out;

  const fp = path.join(policy.state_dir, `${budgetDateStr()}.json`);
  out.path = fp;
  const raw = loadJson(fp, null);
  if (!raw || typeof raw !== "object") return out;

  const cap = Number(raw.token_cap || 0);
  const used = Number(raw.used_est || 0);
  if (!(Number.isFinite(cap) && cap > 0) || !Number.isFinite(used)) return out;

  const ratio = Math.max(0, used / cap);
  let pressure = "none";
  if (ratio >= policy.hard_ratio) pressure = "hard";
  else if (ratio >= policy.soft_ratio) pressure = "soft";

  return {
    ...out,
    available: true,
    pressure,
    ratio: Number(ratio.toFixed(4)),
    token_cap: cap,
    used_est: used
  };
}

function estimateRequestTokens(tokensEst, intent, task) {
  const direct = Number(tokensEst);
  if (Number.isFinite(direct) && direct > 0) {
    return Math.max(
      ROUTER_MIN_REQUEST_TOKENS,
      Math.min(ROUTER_MAX_REQUEST_TOKENS, Math.round(direct))
    );
  }
  const text = `${String(intent || "")} ${String(task || "")}`.trim();
  const chars = text.length;
  const words = text ? text.split(/\s+/).filter(Boolean).length : 0;
  const heuristic = Math.round((chars / 3.6) + (words * 1.6) + 80);
  return Math.max(
    ROUTER_MIN_REQUEST_TOKENS,
    Math.min(ROUTER_MAX_REQUEST_TOKENS, heuristic)
  );
}

function resolveModelTokenMultiplier(modelId, profileClass, policy) {
  const key = normalizeKey(modelId);
  const byModel = policy && policy.model_token_multipliers && typeof policy.model_token_multipliers === "object"
    ? policy.model_token_multipliers
    : {};
  for (const [model, rawMultiplier] of Object.entries(byModel)) {
    if (normalizeKey(model) !== key) continue;
    const m = Number(rawMultiplier);
    if (Number.isFinite(m) && m > 0) {
      return { multiplier: m, source: "model" };
    }
  }

  const classMultipliers = policy && policy.class_token_multipliers && typeof policy.class_token_multipliers === "object"
    ? policy.class_token_multipliers
    : {};
  const classKey = normalizeKey(profileClass || "");
  const fallbackClass = isLocalOllamaModel(modelId) ? "local" : "cloud";
  const classValue = Number(classMultipliers[classKey] || classMultipliers[fallbackClass] || classMultipliers.default || 1);
  if (Number.isFinite(classValue) && classValue > 0) {
    return { multiplier: classValue, source: "class" };
  }
  return { multiplier: 1, source: "default" };
}

function estimateModelRequestTokens(modelId, requestTokens, profileClass, policy) {
  const req = Number(requestTokens);
  if (!Number.isFinite(req) || req <= 0) {
    return { tokens_est: null, multiplier: null, source: "none" };
  }
  const detail = resolveModelTokenMultiplier(modelId, profileClass, policy);
  const est = Math.max(
    ROUTER_MIN_REQUEST_TOKENS,
    Math.min(ROUTER_MAX_REQUEST_TOKENS, Math.round(req * detail.multiplier))
  );
  return {
    tokens_est: est,
    multiplier: Number(detail.multiplier.toFixed(4)),
    source: detail.source
  };
}

function projectBudgetState(budgetState, requestTokens) {
  const req = Number(requestTokens);
  const safeReq = Number.isFinite(req) && req > 0 ? Math.round(req) : 0;
  if (!budgetState || budgetState.available !== true) {
    return {
      ...(budgetState || {}),
      request_tokens_est: safeReq,
      projected_used_est: null,
      projected_ratio: null,
      projected_pressure: budgetState && budgetState.pressure ? budgetState.pressure : "none"
    };
  }
  const cap = Number(budgetState.token_cap || 0);
  const used = Number(budgetState.used_est || 0);
  if (!(Number.isFinite(cap) && cap > 0) || !Number.isFinite(used)) {
    return {
      ...budgetState,
      request_tokens_est: safeReq,
      projected_used_est: null,
      projected_ratio: null,
      projected_pressure: budgetState.pressure || "none"
    };
  }
  const projectedUsed = used + safeReq;
  const projectedRatio = Math.max(0, projectedUsed / cap);
  const policy = budgetState.policy || {};
  let projectedPressure = "none";
  if (projectedRatio >= Number(policy.hard_ratio || 0.92)) projectedPressure = "hard";
  else if (projectedRatio >= Number(policy.soft_ratio || 0.75)) projectedPressure = "soft";
  return {
    ...budgetState,
    request_tokens_est: safeReq,
    projected_used_est: projectedUsed,
    projected_ratio: Number(projectedRatio.toFixed(4)),
    projected_pressure: projectedPressure
  };
}

function routerSpendPathForDate(dateStr) {
  const day = /^\d{4}-\d{2}-\d{2}$/.test(String(dateStr || "")) ? String(dateStr) : budgetDateStr();
  return path.join(ROUTER_SPEND_DIR, `${day}.json`);
}

function recordRouterSpend(entry) {
  const model = String(entry && entry.model ? entry.model : "").trim();
  if (!model) return;
  const reqTokens = Math.max(0, Number(entry.request_tokens_est || 0));
  const modelTokens = Math.max(0, Number(entry.model_tokens_est || 0));
  const fp = routerSpendPathForDate(entry && entry.date);
  const prev = loadJson(fp, null);
  const base = prev && typeof prev === "object"
    ? prev
    : { date: path.basename(fp, ".json"), requests: 0, request_tokens_est_total: 0, model_tokens_est_total: 0, by_model: {} };
  if (!base.by_model || typeof base.by_model !== "object") base.by_model = {};
  const byModel = base.by_model[model] && typeof base.by_model[model] === "object"
    ? base.by_model[model]
    : { requests: 0, request_tokens_est_total: 0, model_tokens_est_total: 0 };
  byModel.requests = Number(byModel.requests || 0) + 1;
  byModel.request_tokens_est_total = Number(byModel.request_tokens_est_total || 0) + reqTokens;
  byModel.model_tokens_est_total = Number(byModel.model_tokens_est_total || 0) + modelTokens;
  base.by_model[model] = byModel;
  base.requests = Number(base.requests || 0) + 1;
  base.request_tokens_est_total = Number(base.request_tokens_est_total || 0) + reqTokens;
  base.model_tokens_est_total = Number(base.model_tokens_est_total || 0) + modelTokens;
  base.updated_at = nowIso();
  writeJsonAtomic(fp, base);
}

function inferTier(risk, complexity) {
  const r = normalizeKey(risk);
  const c = normalizeKey(complexity);
  if (r === "high" || c === "high") return 3;
  if (r === "medium" || c === "medium") return 2;
  return 1;
}

function buildHandoffPacket(decision) {
  const d = decision && typeof decision === "object" ? decision : {};
  const tier = Number(d.tier || 2);
  const role = normalizeKey(d.role || "");
  const out = {
    selected_model: d.selected_model || null,
    previous_model: d.previous_model || null,
    model_changed: d.model_changed === true,
    reason: d.reason || null,
    tier,
    role: role || null,
    route_class: d.route_class || "default",
    mode: d.mode || null,
    slot: d.slot || null,
    escalation_chain: Array.isArray(d.escalation_chain) ? d.escalation_chain.slice(0, Math.max(2, Math.min(4, tier + 1))) : []
  };

  if (d.fast_path && d.fast_path.matched === true) {
    out.fast_path = "communication";
  }

  if (d.budget && typeof d.budget === "object") {
    out.budget = {
      pressure: d.budget.pressure || "none",
      projected_pressure: d.budget.projected_pressure || d.budget.pressure || "none",
      request_tokens_est: Number.isFinite(Number(d.budget.request_tokens_est))
        ? Number(d.budget.request_tokens_est)
        : null
    };
  }

  if (tier >= 2 || ["coding", "tools", "swarm", "planning", "logic"].includes(role)) {
    out.capability = d.capability || null;
    out.fallback_slot = d.fallback_slot || null;
  }

  if (tier >= 3) {
    out.guardrails = {
      deep_thinker: !!d.deep_thinker,
      verification_required: true
    };
    if (d.post_task_return_model) {
      out.post_task_return_model = d.post_task_return_model;
    }
  }

  if (d.budget_enforcement && typeof d.budget_enforcement === "object") {
    out.budget_enforcement = {
      action: d.budget_enforcement.action || null,
      reason: d.budget_enforcement.reason || null,
      blocked: d.budget_enforcement.blocked === true
    };
  }

  return out;
}

function loadModeAdapters() {
  return loadJson(MODE_ADAPTERS_PATH, {});
}

function tierAliasToAdjustment(tierAlias, base) {
  const key = normalizeKey(tierAlias);
  if (key === "tier1_governance") {
    return { ...base, risk: "high", complexity: "high", role: "logic", mode_adjusted: true, mode_reason: "tier1_governance" };
  }
  if (key === "tier2_build") {
    return { ...base, risk: "medium", complexity: "medium", role: "coding", mode_adjusted: true, mode_reason: "tier2_build" };
  }
  if (key === "tier3_grunt") {
    return { ...base, risk: "low", complexity: "low", role: "chat", mode_adjusted: true, mode_reason: "tier3_grunt" };
  }
  return { ...base, mode_adjusted: false, mode_reason: null };
}

function applyModeAdjustments(mode, base) {
  const m = normalizeKey(mode || "normal");
  const out = { ...base, mode: m, mode_adjusted: false, mode_reason: null, mode_policy_source: "fallback" };
  const adapters = loadModeAdapters();
  const modeRouting = adapters && adapters.mode_routing && typeof adapters.mode_routing === "object"
    ? adapters.mode_routing
    : null;
  if (modeRouting) {
    const hasExplicit = Object.prototype.hasOwnProperty.call(modeRouting, m);
    // Keep normal mode neutral unless explicitly configured.
    const allowDefault = !(m === "normal" || m === "default");
    const alias = hasExplicit
      ? modeRouting[m]
      : (allowDefault ? (modeRouting.default || null) : null);
    if (alias) {
      const mapped = tierAliasToAdjustment(alias, out);
      mapped.mode = m;
      mapped.mode_policy_source = "config/model_adapters.json";
      // Preserve deep-thinker strict semantics even if alias points to governance.
      if (m === "deep-thinker" || m === "deep_thinker") {
        mapped.risk = "high";
        mapped.complexity = "high";
        mapped.role = "logic";
        mapped.mode_adjusted = true;
        mapped.mode_reason = "deep_thinker_forces_high_logic";
      }
      return mapped;
    }
  }

  if (m === "deep-thinker" || m === "deep_thinker") {
    out.risk = "high";
    out.complexity = "high";
    out.role = "logic";
    out.mode_adjusted = true;
    out.mode_reason = "deep_thinker_forces_high_logic";
    return out;
  }
  if (m === "hyper-creative" || m === "hyper_creative") {
    out.complexity = out.complexity === "low" ? "medium" : out.complexity;
    out.role = "planning";
    out.mode_adjusted = true;
    out.mode_reason = "hyper_creative_bias_planning";
    return out;
  }
  if (m === "creative" || m === "narrative") {
    out.role = "chat";
    out.mode_adjusted = true;
    out.mode_reason = `${m}_bias_chat`;
    return out;
  }
  return out;
}

function getBans() {
  return loadJson(BANS_PATH, {});
}

function isBanned(modelId) {
  const bans = getBans();
  const ent = bans[modelId];
  if (!ent) return false;
  const expMs = Number(ent.expires_ms || 0);
  if (!expMs || Date.now() > expMs) {
    delete bans[modelId];
    saveJson(BANS_PATH, bans);
    return false;
  }
  return true;
}

function ban(modelId, reason) {
  const bans = getBans();
  const expiresMs = Date.now() + BAN_MS;
  bans[modelId] = {
    ts: nowIso(),
    expires_ms: expiresMs,
    expires_at: new Date(expiresMs).toISOString(),
    reason: String(reason || "unspecified").slice(0, 220)
  };
  saveJson(BANS_PATH, bans);
  appendJsonl(DECISIONS_LOG, { ts: nowIso(), type: "ban", model: modelId, ...bans[modelId] });
}

function unban(modelId) {
  const bans = getBans();
  if (bans[modelId]) {
    delete bans[modelId];
    saveJson(BANS_PATH, bans);
    appendJsonl(DECISIONS_LOG, { ts: nowIso(), type: "unban", model: modelId });
  }
}

function scoreGeneric(output) {
  const lower = String(output || "").toLowerCase();
  let hits = 0;
  for (const m of GENERIC_MARKERS) if (lower.includes(m)) hits++;
  return hits;
}

function toBool(v, fallback) {
  if (typeof v === "boolean") return v;
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
}

function toBoundedNumber(v, fallback, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function stripAnsi(s) {
  return String(s || "").replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "");
}

function sanitizeProbeText(s) {
  return stripAnsi(s)
    .replace(/[\u2800-\u28ff]/g, "")
    .replace(/\u0007/g, "")
    .replace(/\r/g, "")
    .trim();
}

function sampleOneLine(s, maxLen = 160) {
  return sanitizeProbeText(s).replace(/\s+/g, " ").trim().slice(0, maxLen);
}

function followsProbeInstruction(output, acceptOkToken = PROBE_ACCEPT_OK_TOKEN) {
  const txt = sanitizeProbeText(output);
  if (!txt) return false;
  if (txt === "OK") return true;
  const lines = txt.split("\n").map(x => x.trim()).filter(Boolean);
  const last = lines.length ? lines[lines.length - 1] : "";
  if (last === "OK") return true;
  if (acceptOkToken && /\bOK\b/.test(txt)) return true;
  return false;
}

function resolveLocalProbePolicy(modelId) {
  let routing = null;
  try {
    const cfg = readConfig();
    routing = cfg && cfg.routing && typeof cfg.routing === "object" ? cfg.routing : null;
  } catch {}
  const lp = routing && routing.local_probe_policy && typeof routing.local_probe_policy === "object"
    ? routing.local_probe_policy
    : {};
  const def = lp.default && typeof lp.default === "object" ? lp.default : {};
  const models = lp.models && typeof lp.models === "object" ? lp.models : {};
  let mdl = {};
  for (const k of localAliasSet(modelId)) {
    if (models[k] && typeof models[k] === "object") {
      mdl = { ...mdl, ...models[k] };
    }
  }

  return {
    timeout_ms: toBoundedNumber(
      mdl.timeout_ms,
      toBoundedNumber(def.timeout_ms, PROBE_TIMEOUT_MS, 1000, 120000),
      1000,
      120000
    ),
    max_latency_ms: toBoundedNumber(
      mdl.max_latency_ms,
      toBoundedNumber(def.max_latency_ms, T1_LOCAL_MAX_LATENCY_MS, 1000, 120000),
      1000,
      120000
    ),
    accept_ok_token: toBool(
      mdl.accept_ok_token,
      toBool(def.accept_ok_token, PROBE_ACCEPT_OK_TOKEN)
    )
  };
}

function probeLocalModel(modelId) {
  const started = Date.now();
  if (!isLocalOllamaModel(modelId)) {
    return { model: modelId, available: null, skipped: true, reason: "not_local_ollama" };
  }
  const policy = resolveLocalProbePolicy(modelId);
  const prompt = "Return exactly: OK";
  const r = spawnSync("ollama", ["run", ollamaModelName(modelId), "--hidethinking", "--nowordwrap", prompt], {
    encoding: "utf8",
    timeout: policy.timeout_ms
  });
  const latency = Date.now() - started;
  const out = sanitizeProbeText(r.stdout || "");
  const err = sanitizeProbeText(r.stderr || "");
  const timedOut = !!(r.error && String(r.error.code || "").toUpperCase() === "ETIMEDOUT");

  if (timedOut) {
    const sample = out || err;
    const partial = sample.length > 0;
    return {
      model: modelId,
      available: partial ? true : false,
      latency_ms: latency,
      probe_timeout_ms: policy.timeout_ms,
      max_latency_ms: policy.max_latency_ms,
      timeout: true,
      follows_instructions: partial ? followsProbeInstruction(out || sample, policy.accept_ok_token) : null,
      generic_hits: partial ? scoreGeneric(out || sample) : null,
      reason: partial ? "probe_timeout_partial" : "probe_timeout",
      sample: sampleOneLine(sample, 120)
    };
  }
  if (r.status !== 0) {
    if (isEnvProbeBlockedText(err)) {
      return {
        model: modelId,
        available: null,
        skipped: true,
        probe_blocked: true,
        latency_ms: latency,
        probe_timeout_ms: policy.timeout_ms,
        max_latency_ms: policy.max_latency_ms,
        reason: "env_probe_blocked",
        stderr: sampleOneLine(err, 160)
      };
    }
    const failureCode = Number.isInteger(r.status)
      ? `exit_${r.status}`
      : (r.signal ? `signal_${String(r.signal).toLowerCase()}` : "probe_failed");
    return {
      model: modelId,
      available: false,
      latency_ms: latency,
      probe_timeout_ms: policy.timeout_ms,
      max_latency_ms: policy.max_latency_ms,
      reason: failureCode,
      stderr: sampleOneLine(err || out, 120)
    };
  }
  if (!out) return { model: modelId, available: false, latency_ms: latency, reason: "empty_output" };
  const genericHits = scoreGeneric(out);
  const follows = followsProbeInstruction(out, policy.accept_ok_token);
  return {
    model: modelId,
    available: true,
    latency_ms: latency,
    probe_timeout_ms: policy.timeout_ms,
    max_latency_ms: policy.max_latency_ms,
    follows_instructions: follows,
    generic_hits: genericHits,
    sample: sampleOneLine(out, 120)
  };
}

function getHealthCache(forRouting = false) {
  const currentRuntime = detectRuntimeScope();
  const runtimes = loadAllHealthCaches();
  const order = runtimePreferenceOrder(!!forRouting, currentRuntime);
  const records = {};
  const sources = {};
  for (const runtime of order) {
    const map = cleanHealthRecordMap(runtimes[runtime] || {});
    for (const [model, rec] of Object.entries(map)) {
      if (records[model]) continue;
      records[model] = rec;
      sources[model] = runtime;
    }
  }
  return { current_runtime: currentRuntime, runtimes, order, records, sources };
}

function health(modelId, force = false, opts = {}) {
  const forRouting = !!(opts && opts.forRouting === true);
  const cacheState = getHealthCache(forRouting);
  const currentRuntime = cacheState.current_runtime;
  const ent = cacheState.records[modelId];
  const entRuntime = normalizeRuntimeScope(cacheState.sources[modelId] || "") || currentRuntime;

  if (!force && ent) {
    const ageMs = Date.now() - Number(ent.checked_ms || 0);
    const fresh = ageMs < PROBE_TTL_MS;
    if (fresh) {
      const norm = normalizeProbeBlockedRecord(ent);
      if (norm.changed) saveHealthRecord(entRuntime, modelId, norm.rec);
      return { ...norm.rec, source_runtime: entRuntime };
    }

    // In sandbox/limited contexts, preserve host cache for routing instead of clobbering with probe-blocked records.
    if (forRouting && entRuntime === "host" && currentRuntime !== "host" && ageMs < HOST_CACHE_MAX_STALE_MS) {
      const norm = normalizeProbeBlockedRecord(ent);
      if (norm.changed) saveHealthRecord(entRuntime, modelId, norm.rec);
      return { ...norm.rec, source_runtime: entRuntime, stale: true };
    }
  }

  const res = probeLocalModel(modelId);
  const rawRecord = {
    ...res,
    ts: nowIso(),
    checked_ms: Date.now(),
    runtime_scope: currentRuntime
  };
  const record = normalizeProbeBlockedRecord(rawRecord).rec;
  if (record.available === true && record.skipped !== true) {
    const genericBad = (record.generic_hits || 0) >= 2;
    const followBad = record.follows_instructions === false;
    const stableProbe = record.timeout !== true;
    if (genericBad && followBad && stableProbe) {
      ban(modelId, `probe_generic+nofollow (hits=${record.generic_hits || 0})`);
      record.banned = true;
    }
  }

  saveHealthRecord(currentRuntime, modelId, record);
  return { ...record, source_runtime: currentRuntime };
}

function modelsFromAllowlist(cfg) {
  const allow = cfg?.routing?.spawn_model_allowlist || [];
  return Array.isArray(allow) ? allow.filter(Boolean) : [];
}

function pickFromSlotSelection(cfg, risk, complexity) {
  const rules = cfg?.routing?.slot_selection || [];
  const riskVal = normalizeKey(risk || "medium");
  const cxVal = normalizeKey(complexity || "medium");
  function matches(val, cond) {
    if (cond == null) return true;
    if (Array.isArray(cond)) return cond.map(normalizeKey).includes(normalizeKey(val));
    return normalizeKey(cond) === normalizeKey(val);
  }
  for (const r of rules) {
    const w = r.when || {};
    if (matches(riskVal, w.risk) && matches(cxVal, w.complexity)) {
      return {
        slot: r.use_slot || null,
        prefer_model: r.prefer_model || null,
        fallback_slot: r.fallback_slot || null
      };
    }
  }
  return { slot: null, prefer_model: null, fallback_slot: null };
}

function localAliasSet(modelId) {
  const m = String(modelId || "");
  const set = new Set([m]);
  if (m.startsWith("ollama/")) {
    const bare = m.replace(/^ollama\//, "");
    set.add(bare);
    set.add(`ollama/${bare}`);
  }
  return Array.from(set);
}

function modelVariantPolicyFromConfig(cfg) {
  const raw = cfg && cfg.routing && cfg.routing.model_variant_policy && typeof cfg.routing.model_variant_policy === "object"
    ? cfg.routing.model_variant_policy
    : {};
  const roles = Array.isArray(raw.roles) ? raw.roles.map((r) => normalizeKey(r)).filter(Boolean) : ["logic", "planning"];
  const variants = raw.variants && typeof raw.variants === "object"
    ? raw.variants
    : { "ollama/kimi-k2.5:cloud": "ollama/kimi-k2.5:thinking" };
  return {
    enabled: toBool(raw.enabled, true),
    min_tier: toBoundedNumber(raw.min_tier, 3, 1, 3),
    roles,
    require_outcome_score_gain: toBool(raw.require_outcome_score_gain, true),
    min_outcome_score_delta: toBoundedNumber(raw.min_outcome_score_delta, 2, -50, 50),
    max_negative_score_delta: toBoundedNumber(raw.max_negative_score_delta, -8, -100, 100),
    auto_return_to_base: toBool(raw.auto_return_to_base, true),
    variants
  };
}

function variantRoleAllowed(role, policy) {
  const roles = Array.isArray(policy && policy.roles) ? policy.roles : [];
  if (!roles.length) return true;
  return roles.includes(normalizeKey(role || ""));
}

function variantTargetForBase(baseModel, policy) {
  const map = policy && policy.variants && typeof policy.variants === "object" ? policy.variants : {};
  for (const key of localAliasSet(baseModel)) {
    if (!map[key]) continue;
    const target = String(map[key] || "").trim();
    if (target) return target;
  }
  return "";
}

function maybeApplyVariantSelection({
  cfg,
  selectedModel,
  allowlist,
  tier,
  role,
  capability,
  outcomeStats,
  localHealth,
  localModelAllowed
}) {
  const policy = modelVariantPolicyFromConfig(cfg);
  const summaryBase = {
    enabled: policy.enabled === true,
    applied: false,
    base_model: String(selectedModel || ""),
    variant_model: null,
    reason: "not_considered",
    min_tier: Number(policy.min_tier || 3),
    roles: Array.isArray(policy.roles) ? policy.roles.slice(0) : [],
    require_outcome_score_gain: policy.require_outcome_score_gain === true,
    min_outcome_score_delta: Number(policy.min_outcome_score_delta || 0),
    score_delta: null,
    auto_return_to_base: policy.auto_return_to_base === true
  };

  if (!policy.enabled) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: { ...summaryBase, reason: "disabled" }
    };
  }
  if (!selectedModel) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: { ...summaryBase, reason: "no_base_model" }
    };
  }
  if (Number(tier) < Number(policy.min_tier || 3)) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: { ...summaryBase, reason: "tier_not_eligible" }
    };
  }
  if (!variantRoleAllowed(role, policy)) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: { ...summaryBase, reason: "role_not_eligible" }
    };
  }

  const variantModel = variantTargetForBase(selectedModel, policy);
  if (!variantModel || normalizeKey(variantModel) === normalizeKey(selectedModel)) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: { ...summaryBase, reason: "no_variant_mapping" }
    };
  }
  if (!Array.isArray(allowlist) || !allowlist.includes(variantModel)) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: { ...summaryBase, variant_model: variantModel, reason: "variant_not_in_allowlist" }
    };
  }
  if (isBanned(variantModel)) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: { ...summaryBase, variant_model: variantModel, reason: "variant_banned" }
    };
  }
  if (typeof localModelAllowed === "function" && !localModelAllowed(variantModel)) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: { ...summaryBase, variant_model: variantModel, reason: "variant_hardware_ineligible" }
    };
  }

  if (isLocalOllamaModel(variantModel)) {
    const h = health(variantModel, false, { forRouting: true });
    if (localHealth && typeof localHealth === "object") localHealth[variantModel] = h;
    if (h.banned === true) {
      return {
        selected_model: selectedModel,
        base_model: selectedModel,
        summary: { ...summaryBase, variant_model: variantModel, reason: "variant_local_banned" }
      };
    }
    const probeBlocked = h && h.probe_blocked === true;
    if (!probeBlocked) {
      if (h.available !== true) {
        return {
          selected_model: selectedModel,
          base_model: selectedModel,
          summary: { ...summaryBase, variant_model: variantModel, reason: "variant_local_unavailable" }
        };
      }
      if (h.follows_instructions === false && h.timeout !== true) {
        return {
          selected_model: selectedModel,
          base_model: selectedModel,
          summary: { ...summaryBase, variant_model: variantModel, reason: "variant_local_instruction_fail" }
        };
      }
    }
  }

  const baseScore = outcomeScoreForModel(selectedModel, outcomeStats, { capability, role });
  const variantScore = outcomeScoreForModel(variantModel, outcomeStats, { capability, role });
  const scoreDelta = Number((variantScore - baseScore).toFixed(2));
  if (scoreDelta < Number(policy.max_negative_score_delta || -8)) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: {
        ...summaryBase,
        variant_model: variantModel,
        score_delta: scoreDelta,
        reason: "variant_outcome_too_negative"
      }
    };
  }
  if (policy.require_outcome_score_gain === true && scoreDelta < Number(policy.min_outcome_score_delta || 0)) {
    return {
      selected_model: selectedModel,
      base_model: selectedModel,
      summary: {
        ...summaryBase,
        variant_model: variantModel,
        score_delta: scoreDelta,
        reason: "variant_outcome_gain_not_met"
      }
    };
  }

  return {
    selected_model: variantModel,
    base_model: selectedModel,
    summary: {
      ...summaryBase,
      applied: true,
      variant_model: variantModel,
      score_delta: scoreDelta,
      reason: "variant_applied"
    }
  };
}

function modelProfilesFromConfig(cfg) {
  const profiles = cfg?.routing?.model_profiles;
  if (profiles && typeof profiles === "object") return profiles;
  return {
    "ollama/smallthinker": { tiers: [1], roles: ["chat", "planning", "general", "reflex"], class: "cheap_local" },
    "ollama/qwen3:4b": { tiers: [1, 2], roles: ["coding", "tools", "logic", "general", "reflex"], class: "cheap_local" },
    "ollama/gemma3:4b": { tiers: [1, 2], roles: ["chat", "planning", "general", "reflex"], class: "cheap_local" },
    "ollama/kimi-k2.5:cloud": { tiers: [2, 3], roles: ["planning", "logic", "chat", "general"], class: "cloud_anchor" },
    "qwen3-coder:480b-cloud": { tiers: [2, 3], roles: ["coding", "tools", "logic"], class: "cloud_specialist" },
    "gpt-oss:120b-cloud": { tiers: [2, 3], roles: ["planning", "logic", "coding", "general"], class: "cloud_specialist" }
  };
}

function modelProfileFor(modelId, profiles) {
  const keys = localAliasSet(modelId);
  for (const k of keys) {
    if (profiles[k]) return profiles[k];
  }
  return null;
}

function listRunFilesWithinDays(days) {
  if (!fs.existsSync(AUTONOMY_RUNS_DIR)) return [];
  const cutoff = Date.now() - (Math.max(1, days) * 24 * 60 * 60 * 1000);
  return fs.readdirSync(AUTONOMY_RUNS_DIR)
    .filter(f => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
    .map(f => ({ f, t: Date.parse(f.replace('.jsonl', 'T00:00:00.000Z')) }))
    .filter(x => Number.isFinite(x.t) && x.t >= cutoff)
    .sort((a, b) => a.t - b.t)
    .map(x => path.join(AUTONOMY_RUNS_DIR, x.f));
}

function makeOutcomeBucket() {
  return {
    attempts: 0,
    pass: 0,
    fail: 0,
    shipped: 0,
    reverted: 0,
    no_change: 0,
    actual_token_samples: 0,
    total_tokens_actual: 0,
    total_tokens_est: 0,
    total_tokens_effective: 0
  };
}

function outcomeSnapshotFromEvent(event) {
  const evt = event && typeof event === "object" ? event : {};
  const result = String(evt.result || "");
  const verification = evt.verification && typeof evt.verification === "object" ? evt.verification : null;

  let passed = false;
  if (verification && typeof verification.passed === "boolean") {
    passed = verification.passed === true;
  } else if (result === "executed") {
    passed = String(evt.outcome || "") === "shipped";
  }

  let outcome = String(evt.outcome || "");
  if (!outcome) {
    if (result === "executed") outcome = passed ? "shipped" : "no_change";
    else if (result === "init_gate_blocked_route") outcome = "reverted";
  }

  const usage = evt.token_usage && typeof evt.token_usage === "object" ? evt.token_usage : {};
  const actual = Number(usage.actual_total_tokens);
  const est = Number(
    usage.estimated_tokens != null
      ? usage.estimated_tokens
      : (evt.route_tokens_est != null ? evt.route_tokens_est : 0)
  );
  const effectiveRaw = Number(
    usage.effective_tokens != null
      ? usage.effective_tokens
      : (Number.isFinite(actual) && actual > 0 ? actual : est)
  );

  return {
    passed,
    outcome,
    actual_tokens: Number.isFinite(actual) && actual > 0 ? actual : null,
    est_tokens: Number.isFinite(est) && est > 0 ? est : null,
    effective_tokens: Number.isFinite(effectiveRaw) && effectiveRaw > 0 ? effectiveRaw : null
  };
}

function addOutcomeToBucket(bucket, event) {
  const s = bucket || makeOutcomeBucket();
  const snap = outcomeSnapshotFromEvent(event);
  s.attempts += 1;
  if (snap.passed) s.pass += 1;
  else s.fail += 1;
  const outcome = String(snap.outcome || "");
  if (outcome === "shipped") s.shipped += 1;
  if (outcome === "reverted") s.reverted += 1;
  if (outcome === "no_change") s.no_change += 1;
  if (Number.isFinite(Number(snap.actual_tokens))) {
    s.actual_token_samples += 1;
    s.total_tokens_actual += Number(snap.actual_tokens);
  }
  if (Number.isFinite(Number(snap.est_tokens))) {
    s.total_tokens_est += Number(snap.est_tokens);
  }
  if (Number.isFinite(Number(snap.effective_tokens))) {
    s.total_tokens_effective += Number(snap.effective_tokens);
  }
  return s;
}

function deriveOutcomeBucket(bucket) {
  const s = bucket || makeOutcomeBucket();
  const attempts = s.attempts || 1;
  const passRate = s.pass / attempts;
  const shippedRate = s.shipped / attempts;
  const revertedRate = s.reverted / attempts;
  const noChangeRate = s.no_change / attempts;
  const effectiveTokens = Number(s.total_tokens_effective || 0);
  const shippedPer1k = effectiveTokens > 0 ? (Number(s.shipped || 0) * 1000) / effectiveTokens : 0;
  const failPer1k = effectiveTokens > 0 ? (Number(s.fail || 0) * 1000) / effectiveTokens : 0;
  const efficiencyRaw = effectiveTokens > 0
    ? (shippedPer1k * 8) - (failPer1k * 3)
    : 0;
  const efficiencyScore = Math.max(-10, Math.min(10, efficiencyRaw));
  const rawScore = (passRate * 50) + (shippedRate * 35) - (revertedRate * 20) - (noChangeRate * 10) + efficiencyScore;
  return {
    ...s,
    pass_rate: Number(passRate.toFixed(3)),
    shipped_rate: Number(shippedRate.toFixed(3)),
    reverted_rate: Number(revertedRate.toFixed(3)),
    no_change_rate: Number(noChangeRate.toFixed(3)),
    avg_tokens_effective: effectiveTokens > 0 ? Number((effectiveTokens / attempts).toFixed(1)) : null,
    avg_tokens_actual: Number(s.actual_token_samples || 0) > 0
      ? Number((Number(s.total_tokens_actual || 0) / Number(s.actual_token_samples || 1)).toFixed(1))
      : null,
    token_coverage_ratio: attempts > 0
      ? Number((Number(s.actual_token_samples || 0) / attempts).toFixed(3))
      : 0,
    shipped_per_1k_tokens: effectiveTokens > 0 ? Number(shippedPer1k.toFixed(3)) : null,
    fail_per_1k_tokens: effectiveTokens > 0 ? Number(failPer1k.toFixed(3)) : null,
    efficiency_score: Number(efficiencyScore.toFixed(2)),
    score: Number(rawScore.toFixed(2))
  };
}

function deriveNestedOutcomeBuckets(mapByModelAndKey) {
  const out = {};
  for (const [model, scoped] of Object.entries(mapByModelAndKey || {})) {
    if (!scoped || typeof scoped !== "object") continue;
    const next = {};
    for (const [k, bucket] of Object.entries(scoped)) {
      next[k] = deriveOutcomeBucket(bucket);
    }
    out[model] = next;
  }
  return out;
}

function eventRoleKey(evt) {
  const role = normalizeKey(
    evt?.route_summary?.route_role
    || evt?.route_summary?.role
    || evt?.route_role
    || ""
  );
  return role;
}

function eventCapabilityKey(evt) {
  const direct = normalizeCapabilityKey(
    evt?.capability_key
    || evt?.route_summary?.capability_key
    || evt?.route_summary?.capability
    || evt?.proposal_type
    || ""
  );
  if (direct) return direct;
  const role = eventRoleKey(evt);
  return role ? `role:${role}` : "";
}

function modelOutcomeStats(days = OUTCOME_WINDOW_DAYS) {
  const files = listRunFilesWithinDays(days);
  const stats = {};
  const byCapability = {};
  const byRole = {};
  for (const fp of files) {
    const events = readJsonl(fp);
    for (const e of events) {
      if (!e || e.type !== "autonomy_run") continue;
      const runResult = String(e.result || "");
      if (runResult !== "executed" && runResult !== "init_gate_blocked_route") continue;
      const model = e?.route_summary?.selected_model;
      if (!model) continue;
      stats[model] = addOutcomeToBucket(stats[model], e);

      const capability = eventCapabilityKey(e);
      if (capability) {
        byCapability[model] = byCapability[model] || {};
        byCapability[model][capability] = addOutcomeToBucket(byCapability[model][capability], e);
      }

      const role = eventRoleKey(e);
      if (role) {
        byRole[model] = byRole[model] || {};
        byRole[model][role] = addOutcomeToBucket(byRole[model][role], e);
      }
    }
  }

  const derived = {};
  for (const [model, s] of Object.entries(stats)) {
    derived[model] = deriveOutcomeBucket(s);
  }

  const payload = {
    ts: nowIso(),
    window_days: days,
    models: derived,
    by_capability: deriveNestedOutcomeBuckets(byCapability),
    by_role: deriveNestedOutcomeBuckets(byRole)
  };
  saveJson(OUTCOME_STATS_PATH, payload);
  return payload;
}

function findModelOutcomeEntry(map, modelId) {
  if (!map || typeof map !== "object") return null;
  for (const k of localAliasSet(modelId)) {
    const found = map[k];
    if (found && typeof found === "object") return found;
  }
  return null;
}

function findScopedModelOutcomeEntry(map, modelId, key) {
  const modelEntry = findModelOutcomeEntry(map, modelId);
  if (!modelEntry || typeof modelEntry !== "object") return null;
  return modelEntry[key] && typeof modelEntry[key] === "object" ? modelEntry[key] : null;
}

function outcomeScoreDetailForModel(modelId, statsPayload, ctx = {}) {
  if (!statsPayload || typeof statsPayload !== "object") {
    return { score: 0, sources: [], global_score: null, capability_score: null, role_score: null };
  }
  const capability = normalizeCapabilityKey(ctx.capability || "");
  const role = normalizeKey(ctx.role || "");
  const global = findModelOutcomeEntry(statsPayload.models, modelId);
  const scopedCapability = capability ? findScopedModelOutcomeEntry(statsPayload.by_capability, modelId, capability) : null;
  const scopedRole = role ? findScopedModelOutcomeEntry(statsPayload.by_role, modelId, role) : null;

  let score = 0;
  let hasScore = false;
  const sources = [];
  if (global && Number(global.attempts || 0) >= MIN_ATTEMPTS_FOR_OUTCOME_WEIGHT) {
    score = Number(global.score || 0);
    hasScore = true;
    sources.push("global");
  }
  if (scopedCapability && Number(scopedCapability.attempts || 0) >= MIN_ATTEMPTS_FOR_OUTCOME_WEIGHT) {
    const capScore = Number(scopedCapability.score || 0);
    score = hasScore ? ((score * 0.35) + (capScore * 0.65)) : capScore;
    hasScore = true;
    sources.push("capability");
  }
  if (scopedRole && Number(scopedRole.attempts || 0) >= MIN_ATTEMPTS_FOR_OUTCOME_WEIGHT) {
    const roleScore = Number(scopedRole.score || 0);
    score = hasScore ? ((score * 0.7) + (roleScore * 0.3)) : roleScore;
    hasScore = true;
    sources.push("role");
  }
  return {
    score: hasScore ? Number(score.toFixed(2)) : 0,
    sources,
    global_score: global && Number(global.attempts || 0) >= MIN_ATTEMPTS_FOR_OUTCOME_WEIGHT ? Number(global.score || 0) : null,
    capability_score: scopedCapability && Number(scopedCapability.attempts || 0) >= MIN_ATTEMPTS_FOR_OUTCOME_WEIGHT ? Number(scopedCapability.score || 0) : null,
    role_score: scopedRole && Number(scopedRole.attempts || 0) >= MIN_ATTEMPTS_FOR_OUTCOME_WEIGHT ? Number(scopedRole.score || 0) : null
  };
}

function outcomeScoreForModel(modelId, statsPayload, ctx = {}) {
  const detail = outcomeScoreDetailForModel(modelId, statsPayload, ctx);
  return Number(detail.score || 0);
}

function rankCandidate(modelId, ctx) {
  const {
    preferModel,
    role,
    capability,
    tier,
    profiles,
    outcomeStats,
    localHealth,
    budgetState,
    budgetProjected,
    requestTokens
  } = ctx;

  const profile = modelProfileFor(modelId, profiles);
  const roles = Array.isArray(profile && profile.roles) ? profile.roles.map(normalizeKey) : [];
  const tiers = Array.isArray(profile && profile.tiers) ? profile.tiers.map(Number) : [];
  const profileClass = normalizeKey(profile && profile.class || "");

  let score = 0;
  const reasons = [];

  if (preferModel && normalizeKey(modelId) === normalizeKey(preferModel)) {
    score += 16;
    reasons.push("prefer_model");
  }

  if (tiers.length) {
    if (tiers.includes(Number(tier))) {
      score += 10;
      reasons.push("tier_fit");
    } else {
      score -= 8;
      reasons.push("tier_mismatch");
    }
  }

  if (roles.length) {
    if (roles.includes(normalizeKey(role)) || roles.includes("general")) {
      score += 10;
      reasons.push("role_fit");
    } else {
      score -= 6;
      reasons.push("role_mismatch");
    }
  }

  if (Number(tier) === 1 && isLocalOllamaModel(modelId)) {
    score += 6;
    reasons.push("cheap_local_t1");
  }

  if (Number(tier) >= 3 && isCloudModel(modelId)) {
    score += 4;
    reasons.push("cloud_t3");
  }

  const modelCost = estimateModelRequestTokens(
    modelId,
    requestTokens,
    profileClass,
    budgetState && budgetState.policy ? budgetState.policy : {}
  );
  if (Number.isFinite(Number(modelCost.tokens_est))) {
    if (isCloudModel(modelId) && Number(modelCost.tokens_est) >= 1800) {
      const penalty = Math.min(8, Math.max(2, Math.round(Number(modelCost.tokens_est) / 900)));
      score -= penalty;
      reasons.push("request_cost_cloud_penalty");
    }
    if (isLocalOllamaModel(modelId) && profileClass === "cheap_local" && Number(modelCost.tokens_est) <= 900) {
      score += 1;
      reasons.push("request_cost_cheap_local_bonus");
    }
  }

  const outcomeDetail = outcomeScoreDetailForModel(modelId, outcomeStats, { capability, role });
  const outcomeScore = Number(outcomeDetail.score || 0);
  score += Math.max(-20, Math.min(20, outcomeScore / 3));
  if (outcomeScore !== 0) {
    if (outcomeDetail.sources.includes("capability")) reasons.push("outcome_weighted_capability");
    else if (outcomeDetail.sources.includes("role")) reasons.push("outcome_weighted_role");
    else reasons.push("outcome_weighted");
  }

  const effectiveBudget = budgetProjected && budgetProjected.available === true
    ? budgetProjected
    : budgetState;
  const effectivePressure = String(effectiveBudget && effectiveBudget.projected_pressure ? effectiveBudget.projected_pressure : (effectiveBudget && effectiveBudget.pressure ? effectiveBudget.pressure : "none"));
  if (effectiveBudget && effectiveBudget.available === true && effectivePressure !== "none") {
    const hard = effectivePressure === "hard";
    const policy = effectiveBudget.policy || {};
    if (isCloudModel(modelId)) {
      let penalty = hard ? Number(policy.cloud_penalty_hard || 0) : Number(policy.cloud_penalty_soft || 0);
      if (Number(tier) >= 3) penalty = Math.round(penalty * 0.5);
      if (penalty > 0) {
        score -= penalty;
        reasons.push(hard ? "budget_hard_cloud_penalty" : "budget_soft_cloud_penalty");
        if (budgetProjected && budgetProjected.projected_pressure && budgetProjected.projected_pressure !== budgetState.pressure) {
          reasons.push(hard ? "projected_budget_hard" : "projected_budget_soft");
        }
      }
    }
    if (isLocalOllamaModel(modelId) && profileClass === "cheap_local") {
      const bonus = hard ? Number(policy.cheap_local_bonus_hard || 0) : Number(policy.cheap_local_bonus_soft || 0);
      if (bonus > 0) {
        score += bonus;
        reasons.push(hard ? "budget_hard_cheap_local_bonus" : "budget_soft_cheap_local_bonus");
        if (budgetProjected && budgetProjected.projected_pressure && budgetProjected.projected_pressure !== budgetState.pressure) {
          reasons.push(hard ? "projected_budget_hard" : "projected_budget_soft");
        }
      }
    }
  }

  if (isLocalOllamaModel(modelId)) {
    const h = localHealth[modelId] || null;
    if (h && h.available === true && Number.isFinite(Number(h.latency_ms))) {
      const lat = Number(h.latency_ms);
      if (lat <= 3500) score += 3;
      else if (lat >= 10000) score -= 4;
    }
  }

  return {
    model: modelId,
    score: Number(score.toFixed(2)),
    reasons,
    outcome_detail: outcomeDetail,
    model_tokens_est: modelCost.tokens_est,
    token_multiplier: modelCost.multiplier,
    token_multiplier_source: modelCost.source
  };
}

function shouldEscalateFromTier1Local(localCandidate, localHealth, outcomeStats, maxLatencyMs = T1_LOCAL_MAX_LATENCY_MS, ctx = {}) {
  if (!localCandidate) return { escalate: true, reason: "no_local_candidate" };
  const h = localHealth[localCandidate] || null;
  if (h && h.probe_blocked === true) return { escalate: false, reason: "local_probe_blocked_env" };
  if (!h || h.available !== true) return { escalate: true, reason: "local_unavailable" };
  if (h.banned === true) return { escalate: true, reason: "local_banned" };
  if (h.follows_instructions === false && h.timeout !== true) return { escalate: true, reason: "local_instruction_fail" };
  if (Number.isFinite(Number(h.latency_ms)) && Number(h.latency_ms) > Number(maxLatencyMs)) {
    return { escalate: true, reason: "local_latency_slow" };
  }
  const os = outcomeScoreForModel(localCandidate, outcomeStats, ctx);
  if (os < T1_LOCAL_MIN_OUTCOME_SCORE) return { escalate: true, reason: "local_outcome_poor" };
  return { escalate: false, reason: null };
}

function pickTier1LocalCandidate(rankedLocals, localHealth) {
  if (!Array.isArray(rankedLocals) || rankedLocals.length === 0) return null;
  for (const item of rankedLocals) {
    const h = localHealth[item.model] || null;
    if (h && h.available === true) return item.model;
  }
  return rankedLocals[0].model;
}

function enforceBudgetSelection({ selected, ranked, budgetState, budgetProjected }) {
  const policy = budgetState && budgetState.policy ? budgetState.policy : {};
  if (policy.enforce_hard_cap !== true) {
    return {
      selected_model: selected,
      action: "none",
      reason: "hard_cap_enforcement_disabled",
      blocked: false
    };
  }
  const projected = budgetProjected && typeof budgetProjected === "object" ? budgetProjected : {};
  const pressure = String(projected.projected_pressure || projected.pressure || "none");
  if (pressure !== "hard") {
    return {
      selected_model: selected,
      action: "none",
      reason: "budget_pressure_not_hard",
      blocked: false
    };
  }
  if (!selected) {
    return {
      selected_model: null,
      action: "escalate",
      reason: "hard_budget_no_selected_model",
      blocked: policy.escalate_on_no_local_fallback === true
    };
  }
  if (!isCloudModel(selected)) {
    return {
      selected_model: selected,
      action: "none",
      reason: "hard_budget_local_model_already_selected",
      blocked: false
    };
  }
  const localFallback = Array.isArray(ranked)
    ? ranked.find((x) => x && x.model && isLocalOllamaModel(x.model))
    : null;
  if (localFallback && localFallback.model) {
    return {
      selected_model: localFallback.model,
      action: "degrade",
      reason: "hard_budget_force_local_fallback",
      from_model: selected,
      blocked: false
    };
  }
  return {
    selected_model: policy.escalate_on_no_local_fallback === true ? null : selected,
    action: "escalate",
    reason: "hard_budget_no_local_fallback",
    from_model: selected,
    blocked: policy.escalate_on_no_local_fallback === true
  };
}

function getRouteState() {
  return loadJson(ROUTE_STATE_PATH, { last_selected_model: null, last_ts: null });
}

function saveRouteState(s) {
  saveJson(ROUTE_STATE_PATH, s || {});
}

function routeDecision({ risk, complexity, intent, task, mode, forceModel, capability, tokensEst, roleOverride, routeClass }) {
  const cfg = readConfig();
  const allowlist = modelsFromAllowlist(cfg);
  const hardwarePlan = resolveHardwarePlan(cfg, allowlist);
  const hardwareFilterActive = localHardwareFilterEnabled(hardwarePlan);
  const eligibleLocals = effectiveLocalModelSet(hardwarePlan);
  const localModelAllowed = (modelId) => {
    if (!isLocalOllamaModel(modelId)) return true;
    if (!hardwareFilterActive) return true;
    return eligibleLocals.has(String(modelId || ""));
  };
  const classPolicy = routeClassPolicy(cfg, routeClass);
  const requestedRisk = normalizeRiskLevel(risk || "medium");
  const requestedComplexity = normalizeComplexityLevel(complexity || "medium");
  const requestedRole = normalizeKey(roleOverride || inferRole(intent, task) || "general") || "general";
  const adjusted = applyModeAdjustments(mode, {
    risk: requestedRisk,
    complexity: requestedComplexity,
    role: requestedRole
  });
  if (classPolicy.force_risk) adjusted.risk = classPolicy.force_risk;
  if (classPolicy.force_complexity) adjusted.complexity = classPolicy.force_complexity;
  if (classPolicy.force_role) adjusted.role = classPolicy.force_role;
  const fastPath = detectCommunicationFastPath({
    cfg,
    risk: adjusted.risk,
    complexity: adjusted.complexity,
    intent,
    task,
    mode: adjusted.mode
  });

  const effectiveFastPath = classPolicy.disable_fast_path === true
    ? { matched: false, reason: "route_class_fast_path_disabled" }
    : fastPath;

  risk = effectiveFastPath.matched ? "low" : normalizeRiskLevel(adjusted.risk);
  complexity = effectiveFastPath.matched ? "low" : normalizeComplexityLevel(adjusted.complexity);
  const rulePickBase = pickFromSlotSelection(cfg, risk, complexity);
  let rulePick = effectiveFastPath.matched
    ? {
        slot: effectiveFastPath.slot || rulePickBase.slot || "grunt",
        prefer_model: effectiveFastPath.prefer_model || rulePickBase.prefer_model || null,
        fallback_slot: effectiveFastPath.fallback_slot || rulePickBase.fallback_slot || "fallback"
      }
    : rulePickBase;
  if (classPolicy.prefer_slot) rulePick = { ...rulePick, slot: classPolicy.prefer_slot };
  if (classPolicy.prefer_model) rulePick = { ...rulePick, prefer_model: classPolicy.prefer_model };
  if (classPolicy.fallback_slot) rulePick = { ...rulePick, fallback_slot: classPolicy.fallback_slot };
  const anchorModel = String(cfg?.routing?.default_anchor_model || "ollama/kimi-k2.5:cloud");
  const role = effectiveFastPath.matched ? "chat" : (normalizeKey(adjusted.role || requestedRole) || "general");
  const capabilityKey = normalizeCapabilityKey(capability || inferCapability(intent, task, role));
  const tier = inferTier(risk, complexity);
  const budgetState = routerBudgetState(cfg);
  let requestTokensEst = estimateRequestTokens(tokensEst, intent, task);
  if (classPolicy.max_tokens_est != null && Number.isFinite(Number(classPolicy.max_tokens_est))) {
    requestTokensEst = Math.min(requestTokensEst, Number(classPolicy.max_tokens_est));
  }
  const budgetProjected = projectBudgetState(budgetState, requestTokensEst);

  const candidates = [];
  if (rulePick.prefer_model) candidates.push(rulePick.prefer_model);
  for (const m of allowlist) if (!candidates.includes(m)) candidates.push(m);

  const localHealth = {};
  const filtered = [];
  const tried = [];

  for (const m of candidates) {
    tried.push(m);
    if (!localModelAllowed(m)) continue;
    if (isBanned(m)) continue;
    if (isLocalOllamaModel(m)) {
      const h = health(m, false, { forRouting: true });
      localHealth[m] = h;
      if (h.banned === true) continue;
      const probeBlocked = h && h.probe_blocked === true;
      if (!probeBlocked) {
        if (h.available !== true) continue;
        if (h.follows_instructions === false && h.timeout !== true) continue;
      }
    }
    filtered.push(m);
  }

  const profiles = modelProfilesFromConfig(cfg);
  const outcomeStats = (fastPath.matched && fastPath.skip_outcome_scan)
    ? loadOutcomeStatsCached()
    : modelOutcomeStats(OUTCOME_WINDOW_DAYS);

  const rankedAll = filtered
    .map(m => rankCandidate(m, {
      preferModel: rulePick.prefer_model,
      role,
      capability: capabilityKey,
      tier,
      profiles,
      outcomeStats,
      localHealth,
      budgetState,
      budgetProjected,
      requestTokens: requestTokensEst
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.model).localeCompare(String(b.model));
    });

  let ranked = rankedAll;
  let tier1EscalationReason = null;
  if (T1_LOCAL_FIRST && Number(tier) === 1) {
    const locals = rankedAll.filter(x => isLocalOllamaModel(x.model));
    const localBest = pickTier1LocalCandidate(locals, localHealth);
    const maxLatencyMs = localBest ? resolveLocalProbePolicy(localBest).max_latency_ms : T1_LOCAL_MAX_LATENCY_MS;
    const esc = shouldEscalateFromTier1Local(localBest, localHealth, outcomeStats, maxLatencyMs, {
      capability: capabilityKey,
      role
    });
    if (!esc.escalate && localBest) {
      ranked = rankedAll.filter(x => x.model === localBest);
    } else {
      tier1EscalationReason = esc.reason || "tier1_escalation";
      ranked = rankedAll.filter(x => x.model !== localBest);
      if (!ranked.length) ranked = rankedAll;
    }
  }

  let selected = ranked[0] ? ranked[0].model : null;
  let reason = ranked[0] ? "ranked_best_candidate" : "no_model_available";
  if (tier1EscalationReason) reason = `tier1_escalated:${tier1EscalationReason}`;

  const forced = String(forceModel || "").trim();
  if (forced) {
    const forcedCandidate = ranked.find(x => String(x.model) === forced);
    if (forcedCandidate) {
      selected = forced;
      reason = "forced_model_override";
    } else {
      reason = "forced_model_unavailable";
    }
  }

  if (!selected && rulePick.prefer_model && !isBanned(rulePick.prefer_model) && localModelAllowed(rulePick.prefer_model)) {
    selected = rulePick.prefer_model;
    reason = "fallback_prefer_model";
  }
  if (!selected) {
    for (const m of allowlist) {
      if (!localModelAllowed(m)) continue;
      if (!isBanned(m)) {
        selected = m;
        reason = "last_ditch_allowlist";
        break;
      }
    }
  }

  const variantPick = maybeApplyVariantSelection({
    cfg,
    selectedModel: selected,
    allowlist,
    tier,
    role,
    capability: capabilityKey,
    outcomeStats,
    localHealth,
    localModelAllowed
  });
  if (variantPick.summary && variantPick.summary.applied === true && variantPick.selected_model) {
    selected = variantPick.selected_model;
    reason = `${reason}|${variantPick.summary.reason}`;
    if (!tried.includes(selected)) tried.push(selected);
  }

  const budgetEnforcement = enforceBudgetSelection({
    selected,
    ranked,
    budgetState,
    budgetProjected
  });
  if (budgetEnforcement && budgetEnforcement.action === "degrade" && budgetEnforcement.selected_model) {
    if (String(budgetEnforcement.selected_model) !== String(selected || "")) {
      selected = budgetEnforcement.selected_model;
      reason = `${reason}|${budgetEnforcement.reason || "budget_degrade"}`;
      if (!tried.includes(selected)) tried.push(selected);
    }
  } else if (budgetEnforcement && budgetEnforcement.action === "escalate") {
    if (budgetEnforcement.blocked === true) {
      selected = null;
      reason = `${reason}|${budgetEnforcement.reason || "budget_escalate_blocked"}`;
    } else if (budgetEnforcement.selected_model && String(budgetEnforcement.selected_model) !== String(selected || "")) {
      selected = budgetEnforcement.selected_model;
      reason = `${reason}|${budgetEnforcement.reason || "budget_escalate"}`;
      if (!tried.includes(selected)) tried.push(selected);
    }
  }

  const state = getRouteState();
  const prev = state.last_selected_model || null;
  const modelChanged = !!(selected && prev && selected !== prev);

  let selectedRank = selected ? (ranked.find(x => x.model === selected) || null) : null;
  if (!selectedRank && selected) {
    selectedRank = rankCandidate(selected, {
      preferModel: rulePick.prefer_model,
      role,
      capability: capabilityKey,
      tier,
      profiles,
      outcomeStats,
      localHealth,
      budgetState,
      budgetProjected,
      requestTokens: requestTokensEst
    });
  }
  const selectedModelTokensEst = selectedRank && Number.isFinite(Number(selectedRank.model_tokens_est))
    ? Number(selectedRank.model_tokens_est)
    : null;
  const decision = {
    ts: nowIso(),
    type: "route",
    mode: adjusted.mode,
    mode_adjusted: adjusted.mode_adjusted,
    mode_reason: adjusted.mode_reason,
    mode_policy_source: adjusted.mode_policy_source || "fallback",
    risk: String(risk || "medium"),
    complexity: String(complexity || "medium"),
    tier,
    role,
    capability: capabilityKey,
    slot: rulePick.slot || null,
    fallback_slot: rulePick.fallback_slot || null,
    anchor_model: anchorModel,
    should_return_to_anchor: !!(selected && anchorModel && selected !== anchorModel),
    intent: intent ? String(intent).slice(0, 80) : "",
    task: task ? String(task).slice(0, 200) : "",
    selected_model: selected,
    previous_model: prev,
    model_changed: modelChanged,
    reason,
    forced_model: forced || null,
    tier1_local_first: T1_LOCAL_FIRST && Number(tier) === 1,
    tier1_escalation_reason: tier1EscalationReason,
    route_class: classPolicy.id,
    route_class_policy: {
      force_risk: classPolicy.force_risk || null,
      force_complexity: classPolicy.force_complexity || null,
      force_role: classPolicy.force_role || null,
      max_tokens_est: classPolicy.max_tokens_est,
      disable_fast_path: classPolicy.disable_fast_path === true
    },
    fast_path: effectiveFastPath.matched
      ? {
          matched: true,
          reason: effectiveFastPath.reason,
          matched_pattern: effectiveFastPath.matched_pattern,
          text: effectiveFastPath.text,
          skip_outcome_scan: effectiveFastPath.skip_outcome_scan === true
        }
      : { matched: false, reason: effectiveFastPath.reason || "not_checked" },
    budget: {
      enabled: budgetState.enabled === true,
      available: budgetState.available === true,
      pressure: budgetState.pressure || "none",
      ratio: budgetState.ratio,
      token_cap: budgetState.token_cap,
      used_est: budgetState.used_est,
      request_tokens_est: requestTokensEst,
      projected_pressure: budgetProjected.projected_pressure || budgetState.pressure || "none",
      projected_ratio: budgetProjected.projected_ratio,
      projected_used_est: budgetProjected.projected_used_est
    },
    budget_enforcement: {
      action: budgetEnforcement.action || "none",
      reason: budgetEnforcement.reason || null,
      blocked: budgetEnforcement.blocked === true,
      from_model: budgetEnforcement.from_model || null
    },
    cost_estimate: {
      request_tokens_est: requestTokensEst,
      selected_model_tokens_est: selectedModelTokensEst,
      selected_model_multiplier: selectedRank ? selectedRank.token_multiplier : null
    },
    variant_routing: variantPick.summary,
    post_task_return_model: variantPick.summary && variantPick.summary.applied === true && variantPick.summary.auto_return_to_base === true
      ? String(variantPick.base_model || "")
      : null,
    hardware_plan: hardwarePlanSummary(hardwarePlan),
    tried: tried.slice(0, 64),
    escalation_chain: ranked.slice(0, 4).map(x => x.model),
    candidate_scores: ranked.slice(0, 6)
  };
  if (adjusted.mode === "deep-thinker" || adjusted.mode === "deep_thinker") {
    decision.deep_thinker = {
      enabled: true,
      verification_passes: 2,
      primary_model: selected,
      secondary_model: ranked[1] ? ranked[1].model : null,
      requires_model_diversity: true
    };
  }

  decision.handoff_packet = buildHandoffPacket(decision);

  appendJsonl(DECISIONS_LOG, decision);

  if (modelChanged) {
    appendJsonl(DECISIONS_LOG, {
      ts: nowIso(),
      type: "model_switch",
      from_model: prev,
      to_model: selected,
      tier,
      role,
      reason
    });
  }

  if (selected) {
    saveRouteState({
      last_selected_model: selected,
      last_ts: nowIso(),
      last_tier: tier,
      last_role: role
    });
    try {
      recordRouterSpend({
        date: budgetDateStr(),
        model: selected,
        request_tokens_est: requestTokensEst,
        model_tokens_est: selectedModelTokensEst || requestTokensEst
      });
    } catch {}
  }

  return decision;
}

function doctorReport({ risk, complexity, intent, task, capability, includeModels }) {
  const cfg = readConfig();
  const allowlist = modelsFromAllowlist(cfg);
  const hardwarePlan = resolveHardwarePlan(cfg, allowlist);
  const hardwareFilterActive = localHardwareFilterEnabled(hardwarePlan);
  const eligibleLocals = effectiveLocalModelSet(hardwarePlan);
  const blockedReasons = blockedLocalReasonMap(hardwarePlan);
  const localModelAllowed = (modelId) => {
    if (!isLocalOllamaModel(modelId)) return true;
    if (!hardwareFilterActive) return true;
    return eligibleLocals.has(String(modelId || ""));
  };
  const explicit = Array.isArray(includeModels)
    ? includeModels.map(m => String(m || "").trim()).filter(Boolean)
    : [];
  const candidates = Array.from(new Set([...allowlist, ...explicit]));
  const rulePick = pickFromSlotSelection(cfg, risk, complexity);
  const role = inferRole(intent, task);
  const capabilityKey = normalizeCapabilityKey(capability || inferCapability(intent, task, role));
  const tier = inferTier(risk, complexity);
  const profiles = modelProfilesFromConfig(cfg);
  const outcomeStats = modelOutcomeStats(OUTCOME_WINDOW_DAYS);
  const budgetState = routerBudgetState(cfg);
  const localHealth = {};

  const diagnostics = [];
  for (const model of candidates) {
    const item = {
      model,
      banned: false,
      local: isLocalOllamaModel(model),
      cloud: isCloudModel(model),
      reasons: [],
      profile: modelProfileFor(model, profiles) || null,
      outcome_score: outcomeScoreForModel(model, outcomeStats, { capability: capabilityKey, role }),
      eligible: true
    };

    if (isBanned(model)) {
      item.banned = true;
      item.eligible = false;
      item.reasons.push("banned");
    }

    if (item.local) {
      if (!localModelAllowed(model)) {
        item.eligible = false;
        item.reasons.push("local_hardware_ineligible");
        const hwReasons = blockedReasons[model] || [];
        if (hwReasons.length) item.reasons.push(...hwReasons.map((r) => `hardware:${r}`));
      }
      const h = health(model, false, { forRouting: true });
      localHealth[model] = h;
      item.local_health = {
        available: h.available === true,
        probe_blocked: h.probe_blocked === true,
        source_runtime: h.source_runtime || null,
        stale: h.stale === true,
        follows_instructions: h.follows_instructions === true,
        latency_ms: Number.isFinite(Number(h.latency_ms)) ? Number(h.latency_ms) : null,
        max_latency_ms: Number.isFinite(Number(h.max_latency_ms)) ? Number(h.max_latency_ms) : null,
        probe_timeout_ms: Number.isFinite(Number(h.probe_timeout_ms)) ? Number(h.probe_timeout_ms) : null,
        generic_hits: Number.isFinite(Number(h.generic_hits)) ? Number(h.generic_hits) : null,
        reason: h.reason || null
      };
      if (h.probe_blocked === true) {
        item.reasons.push("local_probe_blocked");
      } else if (h.available !== true) {
        item.eligible = false;
        item.reasons.push("local_unavailable");
      } else if (h.follows_instructions === false && h.timeout !== true) {
        item.eligible = false;
        item.reasons.push("local_instruction_fail");
      }
      const modelLatencyMax = resolveLocalProbePolicy(model).max_latency_ms;
      if (Number.isFinite(Number(h.latency_ms)) && Number(h.latency_ms) > Number(modelLatencyMax)) {
        item.reasons.push("local_latency_slow");
      }
    }

    const ranked = rankCandidate(model, {
      preferModel: rulePick.prefer_model,
      role,
      capability: capabilityKey,
      tier,
      profiles,
      outcomeStats,
      localHealth,
      budgetState
    });
    item.rank_score = ranked.score;
    item.rank_reasons = ranked.reasons;

    diagnostics.push(item);
  }

  diagnostics.sort((a, b) => {
    if (Number(b.rank_score) !== Number(a.rank_score)) return Number(b.rank_score) - Number(a.rank_score);
    return String(a.model).localeCompare(String(b.model));
  });

  const localCandidates = diagnostics.filter(d => d.local && d.eligible);
  const localBest = pickTier1LocalCandidate(localCandidates, localHealth);
  const localBestLatencyMax = localBest ? resolveLocalProbePolicy(localBest).max_latency_ms : T1_LOCAL_MAX_LATENCY_MS;
  const tier1Esc = (T1_LOCAL_FIRST && Number(tier) === 1)
    ? shouldEscalateFromTier1Local(localBest, localHealth, outcomeStats, localBestLatencyMax, {
        capability: capabilityKey,
        role
      })
    : { escalate: false, reason: null };

  return {
    ts: nowIso(),
    type: "doctor",
    input: {
      risk: String(risk || "medium"),
      complexity: String(complexity || "medium"),
      intent: String(intent || "").slice(0, 80),
      task: String(task || "").slice(0, 200),
      tier,
      role,
      capability: capabilityKey
    },
    policy: {
      slot: rulePick.slot || null,
      prefer_model: rulePick.prefer_model || null,
      fallback_slot: rulePick.fallback_slot || null,
      variant_policy: modelVariantPolicyFromConfig(cfg),
      allowlist_count: allowlist.length,
      explicit_candidate_count: explicit.length,
      t1_local_first: T1_LOCAL_FIRST,
      t1_local_max_latency_ms_default: T1_LOCAL_MAX_LATENCY_MS,
      t1_local_max_latency_ms_selected: localBestLatencyMax,
      t1_local_min_outcome_score: T1_LOCAL_MIN_OUTCOME_SCORE,
      hardware_plan: hardwarePlanSummary(hardwarePlan),
      budget: {
        enabled: budgetState.enabled === true,
        available: budgetState.available === true,
        pressure: budgetState.pressure || "none",
        ratio: budgetState.ratio,
        token_cap: budgetState.token_cap,
        used_est: budgetState.used_est
      }
    },
    tier1_local_decision: {
      local_best: localBest,
      escalate: tier1Esc.escalate === true,
      reason: tier1Esc.reason || null
    },
    diagnostics
  };
}

function cacheSummaryReport({ risk, complexity, intent, task, capability, forRouting }) {
  const cfg = readConfig();
  const allowlist = modelsFromAllowlist(cfg);
  const hardwarePlan = resolveHardwarePlan(cfg, allowlist);
  const hardwareFilterActive = localHardwareFilterEnabled(hardwarePlan);
  const eligibleLocals = effectiveLocalModelSet(hardwarePlan);
  const blockedReasons = blockedLocalReasonMap(hardwarePlan);
  const localModelAllowed = (modelId) => {
    if (!isLocalOllamaModel(modelId)) return true;
    if (!hardwareFilterActive) return true;
    return eligibleLocals.has(String(modelId || ""));
  };
  const role = inferRole(intent, task);
  const capabilityKey = normalizeCapabilityKey(capability || inferCapability(intent, task, role));
  const tier = inferTier(risk, complexity);
  const rulePick = pickFromSlotSelection(cfg, risk, complexity);
  const profiles = modelProfilesFromConfig(cfg);
  const outcomeStats = modelOutcomeStats(OUTCOME_WINDOW_DAYS);
  const budgetState = routerBudgetState(cfg);
  const cacheState = getHealthCache(!!forRouting);
  const currentRuntime = cacheState.current_runtime || detectRuntimeScope();
  const runtimeCounts = {};
  const localHealth = {};
  const rows = [];

  for (const model of allowlist) {
    if (!isLocalOllamaModel(model)) continue;
    const sourceRuntime = normalizeRuntimeScope(cacheState.sources[model] || "") || "unknown";
    runtimeCounts[sourceRuntime] = Number(runtimeCounts[sourceRuntime] || 0) + 1;
    const raw = cacheState.records[model] || null;
    const rec = raw ? normalizeProbeBlockedRecord(raw).rec : null;
    const checkedMs = rec && Number.isFinite(Number(rec.checked_ms)) ? Number(rec.checked_ms) : null;
    const ageMs = checkedMs == null ? null : Math.max(0, Date.now() - checkedMs);
    const stale = ageMs != null ? ageMs > PROBE_TTL_MS : true;
    const modelLatencyMax = resolveLocalProbePolicy(model).max_latency_ms;
    const reasons = [];
    let eligible = true;

    if (isBanned(model)) {
      eligible = false;
      reasons.push("banned");
    }
    if (!localModelAllowed(model)) {
      eligible = false;
      reasons.push("local_hardware_ineligible");
      const hwReasons = blockedReasons[model] || [];
      if (hwReasons.length) reasons.push(...hwReasons.map((r) => `hardware:${r}`));
    }
    if (!rec) {
      eligible = false;
      reasons.push("missing_health");
    } else if (rec.probe_blocked === true) {
      reasons.push("local_probe_blocked");
    } else if (rec.available !== true) {
      eligible = false;
      reasons.push("local_unavailable");
    } else if (rec.follows_instructions === false && rec.timeout !== true) {
      eligible = false;
      reasons.push("local_instruction_fail");
    }
    if (rec && Number.isFinite(Number(rec.latency_ms)) && Number(rec.latency_ms) > Number(modelLatencyMax)) {
      reasons.push("local_latency_slow");
    }

    const availability = rec ? rec.available : null;
    rows.push({
      model,
      source_runtime: sourceRuntime,
      stale,
      eligible,
      hardware_allowed: localModelAllowed(model),
      available: availability === true ? true : (availability === false ? false : null),
      probe_blocked: !!(rec && rec.probe_blocked === true),
      timeout: !!(rec && rec.timeout === true),
      follows_instructions: !!(rec && rec.follows_instructions === true),
      latency_ms: rec && Number.isFinite(Number(rec.latency_ms)) ? Number(rec.latency_ms) : null,
      max_latency_ms: modelLatencyMax,
      checked_ms: checkedMs,
      reason: rec ? rec.reason || null : "missing_health",
      reasons
    });

    localHealth[model] = rec || { model, available: null };
  }

  const availableRows = rows.filter(r => r.available === true);
  const unavailableRows = rows.filter(r => r.available === false);
  const unknownRows = rows.filter(r => r.available == null);
  const probeBlockedRows = rows.filter(r => r.probe_blocked === true);
  const timeoutRows = rows.filter(r => r.timeout === true);
  const instructionFailRows = availableRows.filter(r => r.follows_instructions !== true);
  const localCandidates = rows.filter(r => r.eligible === true);
  const localDegradedRows = rows.filter(r => r.reasons.includes("local_unavailable") || r.reasons.includes("missing_health"));
  const staleRows = rows.filter(r => r.stale === true);

  const rankedLocals = localCandidates
    .map(r => rankCandidate(r.model, {
      preferModel: rulePick.prefer_model,
      role,
      capability: capabilityKey,
      tier,
      profiles,
      outcomeStats,
      localHealth,
      budgetState
    }))
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return String(a.model).localeCompare(String(b.model));
    });

  const localBest = pickTier1LocalCandidate(rankedLocals, localHealth);
  const localBestLatencyMax = localBest ? resolveLocalProbePolicy(localBest).max_latency_ms : T1_LOCAL_MAX_LATENCY_MS;
  const tier1Esc = (T1_LOCAL_FIRST && Number(tier) === 1)
    ? shouldEscalateFromTier1Local(localBest, localHealth, outcomeStats, localBestLatencyMax, {
        capability: capabilityKey,
        role
      })
    : { escalate: false, reason: null };

  const topFailures = rows
    .filter(r => r.eligible !== true)
    .slice(0, 3)
    .map(r => ({ model: r.model, reason: r.reason || null, reasons: r.reasons.slice(0, 3), source_runtime: r.source_runtime }));

  return {
    ts: nowIso(),
    type: "cache_summary",
    for_routing: !!forRouting,
    current_runtime: currentRuntime,
    variant_policy: modelVariantPolicyFromConfig(cfg),
    role,
    capability: capabilityKey,
    source_runtime_order: Array.isArray(cacheState.order) ? cacheState.order.slice(0, 4) : [],
    source_runtime_counts: runtimeCounts,
    total: rows.length,
    local_total: rows.length,
    available: availableRows.length,
    unavailable: unavailableRows.length,
    unknown: unknownRows.length,
    probe_blocked: probeBlockedRows.length,
    timeout: timeoutRows.length,
    instruction_fail: instructionFailRows.length,
    local_eligible: localCandidates.length,
    local_degraded: localDegradedRows.length,
    stale_count: staleRows.length,
    tier1_local_decision: {
      local_best: localBest,
      escalate: tier1Esc.escalate === true,
      reason: tier1Esc.reason || null,
      max_latency_ms_selected: localBestLatencyMax
    },
    budget: {
      enabled: budgetState.enabled === true,
      available: budgetState.available === true,
      pressure: budgetState.pressure || "none",
      ratio: budgetState.ratio,
      token_cap: budgetState.token_cap,
      used_est: budgetState.used_est
    },
    hardware_plan: hardwarePlanSummary(hardwarePlan),
    top_failures: topFailures,
    results: rows
  };
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function cmdRoute() {
  const risk = parseArg("risk") || "medium";
  const complexity = parseArg("complexity") || "medium";
  const intent = parseArg("intent") || "";
  const task = parseArg("task") || "";
  const mode = parseArg("mode") || process.env.AGENT_MODE || "normal";
  const capability = parseArg("capability") || "";
  const role = parseArg("role") || "";
  const routeClass = parseArg("route_class") || parseArg("route-class") || "";
  const tokensEstRaw = parseArg("tokens_est") || parseArg("tokens-est");
  const tokensEst = Number(tokensEstRaw || 0);
  const d = routeDecision({ risk, complexity, intent, task, mode, capability, tokensEst, roleOverride: role, routeClass });
  printJson(d);
}

function cmdProbe() {
  const model = parseArg("model");
  if (!model) {
    console.error("missing --model=");
    process.exit(2);
  }
  printJson(health(model, true));
}

function cmdProbeAll() {
  const cfg = readConfig();
  const allowlist = modelsFromAllowlist(cfg);
  const results = [];
  for (const m of allowlist) {
    if (!isLocalOllamaModel(m)) continue;
    results.push(health(m, true));
  }
  printJson({ ts: nowIso(), type: "probe_all", count: results.length, results });
}

function cmdBans() {
  printJson(getBans());
}

function cmdUnban() {
  const model = parseArg("model");
  if (!model) {
    console.error("missing --model=");
    process.exit(2);
  }
  unban(model);
  printJson({ ok: true, model, ts: nowIso() });
}

function cmdStats() {
  printJson(modelOutcomeStats(OUTCOME_WINDOW_DAYS));
}

function cmdDoctor() {
  const risk = parseArg("risk") || "medium";
  const complexity = parseArg("complexity") || "medium";
  const intent = parseArg("intent") || "";
  const task = parseArg("task") || "";
  const capability = parseArg("capability") || "";
  const candidates = parseListArg("candidate");
  const candidatesCsv = parseArg("candidates");
  if (candidatesCsv) {
    for (const part of String(candidatesCsv).split(",")) {
      const v = String(part || "").trim();
      if (!v) continue;
      if (!candidates.includes(v)) candidates.push(v);
    }
  }
  printJson(doctorReport({ risk, complexity, intent, task, capability, includeModels: candidates }));
}

function cmdCacheSummary() {
  const risk = parseArg("risk") || "low";
  const complexity = parseArg("complexity") || "low";
  const intent = parseArg("intent") || "";
  const task = parseArg("task") || "";
  const capability = parseArg("capability") || "";
  const forRouting = parseBoolArg("for-routing", true);
  printJson(cacheSummaryReport({ risk, complexity, intent, task, capability, forRouting }));
}

function cmdHardwarePlan() {
  const cfg = readConfig();
  const allowlist = modelsFromAllowlist(cfg);
  const plan = resolveHardwarePlan(cfg, allowlist);
  printJson({
    ts: nowIso(),
    type: "hardware_plan",
    ...plan
  });
}

function main() {
  const cmd = process.argv[2] || "";
  if (cmd === "route") return cmdRoute();
  if (cmd === "probe") return cmdProbe();
  if (cmd === "probe-all") return cmdProbeAll();
  if (cmd === "bans") return cmdBans();
  if (cmd === "unban") return cmdUnban();
  if (cmd === "stats") return cmdStats();
  if (cmd === "doctor") return cmdDoctor();
  if (cmd === "cache-summary") return cmdCacheSummary();
  if (cmd === "hardware-plan") return cmdHardwarePlan();

  console.log("Usage:");
  console.log("  node systems/routing/model_router.js route --risk=low|medium|high --complexity=low|medium|high [--intent=..] [--task=..] [--tokens_est=N] [--capability=..] [--mode=normal|narrative|creative|hyper-creative|deep-thinker] [--role=..] [--route_class=..]");
  console.log("  node systems/routing/model_router.js probe --model=ollama/<name>");
  console.log("  node systems/routing/model_router.js probe-all");
  console.log("  node systems/routing/model_router.js bans");
  console.log("  node systems/routing/model_router.js unban --model=ollama/<name>");
  console.log("  node systems/routing/model_router.js stats");
  console.log("  node systems/routing/model_router.js doctor --risk=low|medium|high --complexity=low|medium|high [--intent=..] [--task=..] [--capability=..] [--candidate=<model>]");
  console.log("  node systems/routing/model_router.js cache-summary [--for-routing=1|0] [--risk=low|medium|high] [--complexity=low|medium|high] [--intent=..] [--task=..] [--capability=..]");
  console.log("  node systems/routing/model_router.js hardware-plan");
}

if (require.main === module) main();
module.exports = {
  routeDecision,
  health,
  ban,
  unban,
  isBanned,
  isLocalOllamaModel,
  inferRole,
  inferTier,
  modelOutcomeStats,
  cacheSummaryReport,
  resolveHardwarePlan
};
