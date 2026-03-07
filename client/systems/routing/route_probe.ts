#!/usr/bin/env node
/**
 * systems/routing/route_probe.js — quick local model health probe (deterministic)
 *
 * Runs probes for local ollama models in spawn_model_allowlist and prints a human-friendly summary.
 *
 * Usage:
 *   node systems/routing/route_probe.js
 */

const fs = require("fs");
const path = require("path");
const { health, isLocalOllamaModel, isBanned } = require("./model_router");

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const CONFIG_PATH = path.join(REPO_ROOT, "config", "agent_routing_rules.json");

function readConfig() {
  if (!fs.existsSync(CONFIG_PATH)) throw new Error(`missing: ${CONFIG_PATH}`);
  return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
}

function main() {
  const cfg = readConfig();
  const allow = (cfg?.routing?.spawn_model_allowlist || []).filter(Boolean);
  const locals = allow.filter(m => isLocalOllamaModel(m));

  console.log("═══════════════════════════════════════════════════════════");
  console.log(" MODEL ROUTER - LOCAL PROBE");
  console.log("═══════════════════════════════════════════════════════════");

  if (!locals.length) {
    console.log("No local ollama models found in spawn_model_allowlist.");
    console.log("Tip: add e.g. 'ollama/qwen3:4b' or 'ollama/smallthinker' to allowlist.");
    process.exit(0);
  }

  for (const m of locals) {
    const banned = isBanned(m);
    const h = health(m, true);

    const avail = h.available === true ? "✅" : "❌";
    const banMark = banned ? "⛔" : " ";
    const lat = typeof h.latency_ms === "number" ? `${h.latency_ms}ms` : "-";
    const follow = h.follows_instructions === true ? "OK" : "BAD";
    const generic = typeof h.generic_hits === "number" ? h.generic_hits : "-";

    console.log(`${avail}${banMark} ${m}`);
    console.log(`    latency=${lat} follows=${follow} generic_hits=${generic} sample="${String(h.sample || "").slice(0, 60)}"`);
  }

  console.log("\nDone.");
}

main();
export {};
