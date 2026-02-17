#!/usr/bin/env node
/**
 * habits/scripts/spine_eyes.js — habit/reflex wrapper
 *
 * Usage:
 *   node habits/scripts/spine_eyes.js [YYYY-MM-DD] [--max-eyes=N]
 *
 * Note: spine sets its own CLEARANCE=3 (infra). We don't override it here.
 */

const { spawnSync } = require("child_process");

// Do NOT set CLEARANCE here - spine manages its own clearance
const args = process.argv.slice(2);
const r = spawnSync("node", ["systems/spine/spine.js", "eyes", ...args], { stdio: "inherit" });
process.exit(r.status || 0);
