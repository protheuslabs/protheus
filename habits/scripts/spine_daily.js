#!/usr/bin/env node
/**
 * habits/scripts/spine_daily.js — habit/reflex wrapper
 *
 * Habits are easy to change (tier-2).
 * They invoke protected infrastructure (spine) without embedding policy.
 *
 * Usage:
 *   node habits/scripts/spine_daily.js [YYYY-MM-DD] [--max-eyes=N]
 *
 * Note: spine sets its own CLEARANCE=3 (infra). We don't override it here.
 */

const { spawnSync } = require("child_process");

// Do NOT set CLEARANCE here - spine manages its own clearance
const args = process.argv.slice(2);
const r = spawnSync("node", ["systems/spine/spine.js", "daily", ...args], { stdio: "inherit" });
process.exit(r.status || 0);
