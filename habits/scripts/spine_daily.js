#!/usr/bin/env node
/**
 * habits/scripts/spine_daily.js — habit wrapper for daily spine run
 * Reflex convenience wrapper (changeable by lower tiers).
 */

const { spawnSync } = require("child_process");

function run(args) {
  const r = spawnSync("node", args, { stdio: "inherit", env: process.env });
  process.exit(r.status || 0);
}

// Wrapper defaults:
if (!process.env.CLEARANCE) process.env.CLEARANCE = "3";

const dateStr = process.argv[2]; // optional YYYY-MM-DD
const maxEyesArg = process.argv.find(a => a.startsWith("--max-eyes="));
const args = ["systems/spine/spine.js", "daily"];
if (dateStr) args.push(dateStr);
if (maxEyesArg) args.push(maxEyesArg);

run(args);
