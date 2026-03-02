#!/usr/bin/env node
'use strict';
export {};

/**
 * CLI bridge for: protheusctl skills discover --mcp
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  nowIso,
  cleanText,
  parseArgs,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.PROTHEUSCTL_SKILLS_DISCOVER_POLICY_PATH
  ? path.resolve(process.env.PROTHEUSCTL_SKILLS_DISCOVER_POLICY_PATH)
  : path.join(ROOT, 'config', 'protheusctl_skills_discover_policy.json');

function usage() {
  console.log('Usage: protheusctl skills discover --mcp [--query=<keyword>]');
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    enabled: raw.enabled !== false,
    require_mcp_flag: raw.require_mcp_flag !== false,
    paths: {
      latest_path: resolvePath(paths.latest_path, 'state/ops/protheusctl_skills_discover/latest.json'),
      receipts_path: resolvePath(paths.receipts_path, 'state/ops/protheusctl_skills_discover/receipts.jsonl')
    }
  };
}

function writeReceipt(policy: any, payload: any) {
  const row = {
    ts: nowIso(),
    type: 'protheusctl_skills_discover',
    ...payload
  };
  writeJsonAtomic(policy.paths.latest_path, row);
  appendJsonl(policy.paths.receipts_path, row);
  return row;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }
  const mcpEnabled = args.mcp === true || args.mcp === '1' || args.mcp === 'true';
  if (policy.require_mcp_flag && !mcpEnabled) {
    usage();
    const out = {
      ok: false,
      error: 'mcp_flag_required',
      expected: 'protheusctl skills discover --mcp'
    };
    writeReceipt(policy, out);
    process.stdout.write(JSON.stringify(out, null, 2) + '\n');
    process.exit(2);
  }
  const gateway = path.join(__dirname, '..', '..', 'skills', 'mcp', 'mcp_gateway.js');
  const params = ['discover'];
  if (args.query) params.push(`--query=${String(args.query)}`);
  const proc = spawnSync('node', [gateway, ...params], {
    cwd: path.join(__dirname, '..', '..'),
    encoding: 'utf8'
  });
  if (proc.stdout) process.stdout.write(proc.stdout);
  if (proc.stderr) process.stderr.write(proc.stderr);
  writeReceipt(policy, {
    ok: Number(proc.status || 0) === 0,
    gateway_status: Number(proc.status || 0),
    query: cleanText(args.query || '', 120) || null,
    mcp: true
  });
  process.exit(Number.isFinite(proc.status) ? proc.status : 1);
}

main();
