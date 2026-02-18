#!/usr/bin/env node
/**
 * systems/routing/model_router.js — deterministic model routing w/ local health probes + banlist
 *
 * Goals:
 * - Keep routing deterministic and cheap
 * - Add *optional* safety/quality controls for local models (Ollama) ONLY
 * - Never assume cloud models are runnable via `ollama run`
 *
 * Reads:
 * - config/agent_routing_rules.json
 *
 * Writes:
 * - state/routing/model_health.json
 * - state/routing/banned_models.json
 * - state/routing/routing_decisions.jsonl
 *
 * CLI:
 *   node systems/routing/model_router.js route --risk=low --complexity=low --intent="summarize" --task="..."
 *   node systems/routing/model_router.js probe --model=ollama/smallthinker
 *   node systems/routing/model_router.js probe-all
 *   node systems/routing/model_router.js bans
 *   node systems/routing/model_router.js unban --model=ollama/smallthinker
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

// Repo paths
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(REPO_ROOT, "config", "agent_routing_rules.json");
const STATE_DIR = path.join(REPO_ROOT, "state", "routing");
const HEALTH_PATH = path.join(STATE_DIR, "model_health.json");
const BANS_PATH = path.join(STATE_DIR, "banned_models.json");
const DECISIONS_LOG = path.join(STATE_DIR, "routing_decisions.jsonl");

// Tunables (env-overridable)
const PROBE_TTL_MS = Number(process.env.ROUTER_PROBE_TTL_MS || 30 * 60 * 1000); // 30m
const PROBE_TIMEOUT_MS = Number(process.env.ROUTER_PROBE_TIMEOUT_MS || 9000);   // 9s
const BAN_MS = Number(process.env.ROUTER_BAN_MS || 6 * 60 * 60 * 1000);         // 6h

// Heuristic markers for "template garbage" that kills agentic workflows
const GENERIC_MARKERS = [
  "as an ai",
  "i'm an ai",
  "i cannot",
  "i can't access",
  "i don't have access",
  "i'd be happy to",
  "here's a step-by-step guide",
  "to assist you effectively",
  "agilenix" // example failure mode
];

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

function parseArg(name) {
  const pref = `--${name}=`;
  const a = process.argv.find(x => x.startsWith(pref));
  return a ? a.slice(pref.length) : null;
}

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`routing config missing: ${CONFIG_PATH}`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function isLocalOllamaModel(modelId) {
  // Treat ONLY ollama/* without :cloud as local runnable via `ollama run`.
  if (!modelId || typeof modelId !== "string") return false;
  if (!modelId.startsWith("ollama/")) return false;
  if (modelId.includes(":cloud")) return false;
  return true;
}

function ollamaModelName(modelId) {
  // "ollama/qwen3:4b" -> "qwen3:4b"
  return modelId.replace(/^ollama\//, "");
}

function getBans() {
  return loadJson(BANS_PATH, {});
}

function isBanned(modelId) {
  const bans = getBans();
  const exp = bans[modelId];
  if (!exp) return false;
  const expMs = Number(exp.expires_ms || 0);
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
    reason: String(reason || "unspecified").slice(0, 200)
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
  for (const m of GENERIC_MARKERS) {
    if (lower.includes(m)) hits++;
  }
  return hits;
}

function probeLocalModel(modelId) {
  const started = Date.now();
  if (!isLocalOllamaModel(modelId)) {
    return { model: modelId, available: null, skipped: true, reason: "not_local_ollama" };
  }

  // Probe prompt that should be easy for even tiny models
  const prompt = 'Return exactly: OK';

  const r = spawnSync("ollama", ["run", ollamaModelName(modelId), prompt], {
    encoding: "utf8",
    timeout: PROBE_TIMEOUT_MS
  });

  const latency = Date.now() - started;
  const out = (r.stdout || "").trim();
  const err = (r.stderr || "").trim();

  if (r.status !== 0) {
    return {
      model: modelId,
      available: false,
      latency_ms: latency,
      reason: `exit_${r.status}`,
      stderr: err.slice(0, 120)
    };
  }

  if (!out) {
    return { model: modelId, available: false, latency_ms: latency, reason: "empty_output" };
  }

  const genericHits = scoreGeneric(out);
  const follows = out === "OK";

  return {
    model: modelId,
    available: true,
    latency_ms: latency,
    follows_instructions: follows,
    generic_hits: genericHits,
    sample: out.slice(0, 120)
  };
}

function getHealthCache() {
  return loadJson(HEALTH_PATH, {});
}

function health(modelId, force = false) {
  const cache = getHealthCache();
  const ent = cache[modelId];
  if (!force && ent && (Date.now() - Number(ent.checked_ms || 0)) < PROBE_TTL_MS) {
    return ent;
  }

  const res = probeLocalModel(modelId);
  const record = {
    ...res,
    ts: nowIso(),
    checked_ms: Date.now()
  };

  // Auto-ban if local model appears generic AND didn't follow simple instruction
  if (record.available === true && record.skipped !== true) {
    const genericBad = (record.generic_hits || 0) >= 2;
    const followBad = record.follows_instructions !== true;
    if (genericBad && followBad) {
      ban(modelId, `probe_generic+nofollow (hits=${record.generic_hits || 0})`);
      record.banned = true;
    }
  }

  cache[modelId] = record;
  saveJson(HEALTH_PATH, cache);
  return record;
}

function modelsFromAllowlist(cfg) {
  const allow = cfg?.routing?.spawn_model_allowlist || [];
  return Array.isArray(allow) ? allow : [];
}

function pickFromSlotSelection(cfg, risk, complexity) {
  const rules = cfg?.routing?.slot_selection || [];
  const riskVal = String(risk || "medium");
  const cxVal = String(complexity || "medium");

  function matches(val, cond) {
    if (cond == null) return true;
    if (Array.isArray(cond)) return cond.map(String).includes(String(val));
    return String(cond) === String(val);
  }

  for (const r of rules) {
    const w = r.when || {};
    const okRisk = matches(riskVal, w.risk);
    const okCx = matches(cxVal, w.complexity);
    if (okRisk && okCx) {
      return {
        slot: r.use_slot || null,
        prefer_model: r.prefer_model || null,
        fallback_slot: r.fallback_slot || null
      };
    }
  }
  return { slot: null, prefer_model: null, fallback_slot: null };
}

function routeDecision({ risk, complexity, intent, task }) {
  const cfg = readConfig();
  const allowlist = modelsFromAllowlist(cfg);
  const rulePick = pickFromSlotSelection(cfg, risk, complexity);

  const candidates = [];
  if (rulePick.prefer_model) candidates.push(rulePick.prefer_model);
  for (const m of allowlist) {
    if (!candidates.includes(m)) candidates.push(m);
  }

  const tried = [];
  let selected = null;
  let reason = null;

  for (const m of candidates) {
    tried.push(m);
    if (isBanned(m)) continue;

    if (isLocalOllamaModel(m)) {
      const h = health(m, false);
      if (h.available !== true) continue;
      if (h.banned === true) continue;
      if (h.follows_instructions !== true) continue;
    }

    selected = m;
    reason = "picked_first_healthy_unbanned";
    break;
  }

  if (!selected && rulePick.prefer_model && !isBanned(rulePick.prefer_model)) {
    selected = rulePick.prefer_model;
    reason = "fallback_prefer_model";
  }

  if (!selected) {
    for (const m of allowlist) {
      if (!isBanned(m)) {
        selected = m;
        reason = "last_ditch_allowlist";
        break;
      }
    }
  }

  const decision = {
    ts: nowIso(),
    type: "route",
    risk: String(risk || "medium"),
    complexity: String(complexity || "medium"),
    intent: intent ? String(intent).slice(0, 80) : "",
    task: task ? String(task).slice(0, 200) : "",
    selected_model: selected,
    reason: reason || "no_model_available",
    tried: tried.slice(0, 64)
  };

  appendJsonl(DECISIONS_LOG, decision);
  return decision;
}

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function cmdRoute() {
  const risk = parseArg("risk") || "medium";
  const complexity = parseArg("complexity") || "medium";
  const intent = parseArg("intent") || "";
  const task = parseArg("task") || "";
  const d = routeDecision({ risk, complexity, intent, task });
  printJson(d);
}

function cmdProbe() {
  const model = parseArg("model");
  if (!model) {
    console.error("missing --model=");
    process.exit(2);
  }
  const h = health(model, true);
  printJson(h);
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

function main() {
  const cmd = process.argv[2] || "";
  if (cmd === "route") return cmdRoute();
  if (cmd === "probe") return cmdProbe();
  if (cmd === "probe-all") return cmdProbeAll();
  if (cmd === "bans") return cmdBans();
  if (cmd === "unban") return cmdUnban();

  console.log("Usage:");
  console.log("  node systems/routing/model_router.js route --risk=low|medium|high --complexity=low|medium|high [--intent=..] [--task=..]");
  console.log("  node systems/routing/model_router.js probe --model=ollama/<name>");
  console.log("  node systems/routing/model_router.js probe-all");
  console.log("  node systems/routing/model_router.js bans");
  console.log("  node systems/routing/model_router.js unban --model=ollama/<name>");
}

if (require.main === module) main();
module.exports = { routeDecision, health, ban, unban, isBanned, isLocalOllamaModel };
