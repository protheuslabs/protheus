#!/usr/bin/env node
// Layer ownership: apps/habits/scripts (authoritative)
// Uses the public protheus-ops CLI contract rather than private runtime paths.

const { runProtheusOps } = require('../../_shared/run_protheus_ops');

const date = process.argv[2];
const maxEyesArg = process.argv.find(a => a.startsWith("--max-eyes="));

// Wrappers run with infra clearance (tier 3) by default
if (!process.env.CLEARANCE) process.env.CLEARANCE = "3";

const args = ["spine", "daily"];
if (date) args.push(date);
if (maxEyesArg) args.push(maxEyesArg);

process.exit(runProtheusOps(args));
