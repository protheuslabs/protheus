#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-165
 * MCP interoperability + skill discovery gateway.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeToken,
  cleanText,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');
const { verifyMcpSkillDescriptor } = require('../../systems/security/mcp_skill_verifier.js');

const POLICY_PATH = process.env.MCP_GATEWAY_POLICY_PATH
  ? path.resolve(process.env.MCP_GATEWAY_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'mcp_gateway_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node skills/mcp/mcp_gateway.js configure --owner=<owner_id> [--channel=default]');
  console.log('  node skills/mcp/mcp_gateway.js discover [--query=keyword] [--risk-tier=2]');
  console.log('  node skills/mcp/mcp_gateway.js install --owner=<owner_id> --id=<skill_id> [--risk-tier=2]');
  console.log('  node skills/mcp/mcp_gateway.js status [--owner=<owner_id>]');
}

function registryPath(policy: any) {
  return policy.paths && policy.paths.registry_path
    ? String(policy.paths.registry_path)
    : path.join(__dirname, 'registry.json');
}

function loadRegistry(policy: any) {
  const row = readJson(registryPath(policy), { skills: [] });
  return Array.isArray(row && row.skills) ? row.skills : [];
}

runStandardLane({
  lane_id: 'V3-RACE-165',
  script_rel: 'skills/mcp/mcp_gateway.js',
  policy_path: POLICY_PATH,
  stream: 'skills.mcp_gateway',
  paths: {
    memory_dir: 'memory/skills/mcp',
    adaptive_index_path: 'adaptive/skills/mcp/index.json',
    events_path: 'state/skills/mcp_gateway/events.jsonl',
    latest_path: 'state/skills/mcp_gateway/latest.json',
    receipts_path: 'state/skills/mcp_gateway/receipts.jsonl',
    registry_path: 'skills/mcp/registry.json',
    installs_path: 'state/skills/mcp_gateway/installs.json'
  },
  usage,
  handlers: {
    discover(policy: any, args: any, ctx: any) {
      const query = normalizeToken(args.query || '', 120) || null;
      const skills = loadRegistry(policy)
        .filter((row: any) => !query || String(row.id || '').includes(query) || String(row.title || '').toLowerCase().includes(query))
        .map((row: any) => ({
          id: normalizeToken(row.id || '', 120),
          title: cleanText(row.title || row.id || 'Untitled', 180),
          source: cleanText(row.source || 'mcp://unknown', 300),
          trust_tier: cleanText(row.trust_tier || 'standard', 40),
          signature: cleanText(row.signature || '', 120) || null
        }))
        .slice(0, 32);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'mcp_discover',
        payload_json: JSON.stringify({
          query,
          discovered_count: skills.length,
          skills
        })
      });
    },
    install(policy: any, args: any, ctx: any) {
      const owner = normalizeToken(args.owner || args.owner_id, 120);
      const id = normalizeToken(args.id || args.skill_id, 120);
      if (!owner || !id) return { ok: false, error: 'missing_owner_or_skill_id' };
      const skill = loadRegistry(policy).find((row: any) => normalizeToken(row.id || '', 120) === id);
      if (!skill) return { ok: false, error: 'skill_not_found', skill_id: id };
      const verify = verifyMcpSkillDescriptor(skill);
      if (!verify.ok) return { ok: false, error: 'skill_verification_failed', verification: verify };

      const installsPath = String(policy.paths.installs_path);
      const payload = readJson(installsPath, { installs: [] });
      payload.installs = Array.isArray(payload.installs) ? payload.installs : [];
      payload.installs.push({
        owner_id: owner,
        skill_id: id,
        installed_at: new Date().toISOString(),
        source: cleanText(skill.source || '', 300),
        verification: verify
      });
      fs.mkdirSync(path.dirname(installsPath), { recursive: true });
      writeJsonAtomic(installsPath, payload);

      return ctx.cmdRecord(policy, {
        ...args,
        owner,
        event: 'mcp_install',
        payload_json: JSON.stringify({
          owner_id: owner,
          skill_id: id,
          source: cleanText(skill.source || '', 300),
          verification: verify
        })
      });
    }
  }
});
