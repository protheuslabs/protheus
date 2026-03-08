#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { nowIso, normalizeToken, cleanText } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.SANDBOX_SKILL_LOADER_POLICY_PATH
  ? path.resolve(process.env.SANDBOX_SKILL_LOADER_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'sandbox_skill_loader_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/sandbox_skill_loader.js load --skill=<id> [--scope=<name>] [--apply=1]');
  console.log('  node systems/security/sandbox_skill_loader.js list');
  console.log('  node systems/security/sandbox_skill_loader.js status');
}

function loadState(policy: any) {
  const p = String(policy.paths.state_path || '');
  if (!p || !fs.existsSync(p)) return { schema_id: 'sandbox_skill_loader_state_v1', loaded: [] };
  try { return JSON.parse(String(fs.readFileSync(p, 'utf8') || '{}')); } catch { return { schema_id: 'sandbox_skill_loader_state_v1', loaded: [] }; }
}

function saveState(policy: any, state: any) {
  fs.mkdirSync(path.dirname(policy.paths.state_path), { recursive: true });
  fs.writeFileSync(policy.paths.state_path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

runStandardLane({
  lane_id: 'V6-SBOX-004',
  script_rel: 'systems/security/sandbox_skill_loader.js',
  policy_path: POLICY_PATH,
  stream: 'security.sandbox_skill_loader',
  paths: {
    memory_dir: 'client/local/state/security/sandbox_skill_loader/memory',
    adaptive_index_path: 'client/local/adaptive/security/sandbox_skill_loader/index.json',
    events_path: 'client/local/state/security/sandbox_skill_loader/events.jsonl',
    latest_path: 'client/local/state/security/sandbox_skill_loader/latest.json',
    receipts_path: 'client/local/state/security/sandbox_skill_loader/receipts.jsonl',
    state_path: 'client/local/state/security/sandbox_skill_loader/state.json'
  },
  usage,
  handlers: {
    load(policy: any, args: any, ctx: any) {
      const skill = normalizeToken(args.skill || '', 120);
      if (!skill) {
        return { ok: false, type: 'sandbox_skill_loader', action: 'load', error: 'skill_required', ts: nowIso() };
      }
      const allow = Array.isArray(policy.allowed_skills) ? policy.allowed_skills.map((v: string) => normalizeToken(v, 120)).filter(Boolean) : [];
      if (allow.length > 0 && !allow.includes(skill)) {
        return { ok: false, type: 'sandbox_skill_loader', action: 'load', error: 'skill_not_allowed', skill, ts: nowIso() };
      }
      const state = loadState(policy);
      state.loaded = Array.isArray(state.loaded) ? state.loaded : [];
      state.loaded.push({
        skill,
        scope: cleanText(args.scope || 'default', 80),
        ts: nowIso(),
        capability_scoped: true
      });
      saveState(policy, state);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sandbox_skill_load',
        payload_json: JSON.stringify({ ok: true, loaded: state.loaded[state.loaded.length - 1], total: state.loaded.length })
      });
    },
    list(policy: any, args: any, ctx: any) {
      const state = loadState(policy);
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'sandbox_skill_list',
        payload_json: JSON.stringify({ ok: true, loaded: Array.isArray(state.loaded) ? state.loaded : [] })
      });
    }
  }
});
