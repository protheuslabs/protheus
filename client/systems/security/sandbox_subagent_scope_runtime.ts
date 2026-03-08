#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { nowIso, normalizeToken, cleanText, toBool } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.SANDBOX_SUBAGENT_SCOPE_POLICY_PATH
  ? path.resolve(process.env.SANDBOX_SUBAGENT_SCOPE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'sandbox_subagent_scope_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/sandbox_subagent_scope_runtime.js spawn --owner=<id> --scope=<name> [--tools=a,b] [--apply=1]');
  console.log('  node systems/security/sandbox_subagent_scope_runtime.js terminate --agent-id=<id> [--reason=<text>] [--apply=1]');
  console.log('  node systems/security/sandbox_subagent_scope_runtime.js report [--apply=0|1]');
  console.log('  node systems/security/sandbox_subagent_scope_runtime.js status');
}

function loadState(policy: any) {
  const p = String(policy.paths.state_path || '');
  if (!p || !fs.existsSync(p)) return { schema_id: 'sandbox_subagent_scope_state_v1', agents: {} };
  try { return JSON.parse(String(fs.readFileSync(p, 'utf8') || '{}')); } catch { return { schema_id: 'sandbox_subagent_scope_state_v1', agents: {} }; }
}

function saveState(policy: any, state: any) {
  const p = String(policy.paths.state_path || '');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

runStandardLane({
  lane_id: 'V6-SBOX-002',
  script_rel: 'systems/security/sandbox_subagent_scope_runtime.js',
  policy_path: POLICY_PATH,
  stream: 'security.sandbox_subagent_scope',
  paths: {
    memory_dir: 'client/local/state/security/sandbox_subagent_scope/memory',
    adaptive_index_path: 'client/local/adaptive/security/sandbox_subagent_scope/index.json',
    events_path: 'client/local/state/security/sandbox_subagent_scope/events.jsonl',
    latest_path: 'client/local/state/security/sandbox_subagent_scope/latest.json',
    receipts_path: 'client/local/state/security/sandbox_subagent_scope/receipts.jsonl',
    state_path: 'client/local/state/security/sandbox_subagent_scope/state.json'
  },
  usage,
  handlers: {
    spawn(policy: any, args: any, ctx: any) {
      const state = loadState(policy);
      const owner = normalizeToken(args.owner || 'system', 80) || 'system';
      const scope = normalizeToken(args.scope || 'default', 80) || 'default';
      const tools = String(args.tools || '')
        .split(',')
        .map((v: string) => normalizeToken(v, 80))
        .filter(Boolean);
      const agentId = `subagent_${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
      state.agents = state.agents || {};
      state.agents[agentId] = {
        id: agentId,
        owner,
        scope,
        tools,
        status: 'active',
        created_at: nowIso(),
        termination_condition: cleanText(args['termination-condition'] || args.termination_condition || 'manual', 120)
      };
      if (toBool(args.apply, true)) saveState(policy, state);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sandbox_subagent_spawn',
        payload_json: JSON.stringify({ ok: true, agent: state.agents[agentId], aggregate_count: Object.keys(state.agents).length })
      });
    },
    terminate(policy: any, args: any, ctx: any) {
      const state = loadState(policy);
      const id = cleanText(args['agent-id'] || args.agent_id || '', 120);
      const agent = state.agents && state.agents[id] ? state.agents[id] : null;
      if (!agent) {
        return { ok: false, type: 'sandbox_subagent_scope_runtime', action: 'terminate', error: 'agent_not_found', ts: nowIso() };
      }
      agent.status = 'terminated';
      agent.terminated_at = nowIso();
      agent.termination_reason = cleanText(args.reason || 'manual_terminate', 180);
      if (toBool(args.apply, true)) saveState(policy, state);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sandbox_subagent_terminate',
        payload_json: JSON.stringify({ ok: true, agent })
      });
    },
    report(policy: any, args: any, ctx: any) {
      const state = loadState(policy);
      const rows = Object.values(state.agents || {});
      const summary = {
        total: rows.length,
        active: rows.filter((row: any) => row.status === 'active').length,
        terminated: rows.filter((row: any) => row.status === 'terminated').length
      };
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sandbox_subagent_report',
        payload_json: JSON.stringify({ ok: true, summary, agents: rows })
      });
    }
  }
});
