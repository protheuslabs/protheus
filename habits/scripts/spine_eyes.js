#!/usr/bin/env node
/**
 * habits/scripts/spine_eyes.js — tier-friendly wrapper for spine eyes
 *
 * Purpose:
 * - Provide an easy "habit/reflex" entrypoint
 * - Let higher-tier infra do the orchestration
 */

const { spawnSync } = require("child_process");

function run(cmd, args, env = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) process.exit(r.status || 1);
}

const date = process.argv[2];
const maxEyesArg = process.argv.find(a => a.startsWith("--max-eyes="));

// Wrappers run with infra clearance (tier 3) by default
if (!process.env.CLEARANCE) process.env.CLEARANCE = "3";

const args = ["systems/spine/spine.js", "eyes"];
if (date) args.push(date);
if (maxEyesArg) args.push(maxEyesArg);

run("node", args);
