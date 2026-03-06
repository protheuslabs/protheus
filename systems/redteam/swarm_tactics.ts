#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function uniqueTokens(src: unknown, maxItems = 64) {
  const rows = Array.isArray(src) ? src : [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rows) {
    const token = String(raw == null ? '' : raw).trim();
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxItems) break;
  }
  return out;
}

function buildSwarmTactics(input: AnyObj = {}, policy: AnyObj = {}) {
  const mode = String(input.mode || 'peacetime').trim().toLowerCase();
  const shadowOnly = input.shadow_only !== false;
  const intensity = clampNumber(input.intensity, 0, 1, 0.25);
  const warCfg = policy && policy.war_mode && typeof policy.war_mode === 'object'
    ? policy.war_mode
    : {};
  const targetLatencyMs = clampInt(warCfg.target_activation_ms, 1, 60000, 50);
  const priorityTargets = uniqueTokens(input.priority_targets, 128);

  const actions: AnyObj[] = [];
  if (mode !== 'war') {
    actions.push({
      action: 'friendly_probe_rotation',
      apply: false,
      sandbox: true,
      intensity
    });
    actions.push({
      action: 'zero_day_simulation_batch',
      apply: false,
      sandbox: true,
      intensity
    });
    if (priorityTargets.length > 0) {
      actions.push({
        action: 'priority_graft_stress_test',
        apply: false,
        sandbox: true,
        targets: priorityTargets.slice(0, 32)
      });
    }
  } else {
    actions.push({
      action: 'swarm_isolate_vectors',
      apply: !shadowOnly,
      sandbox: true,
      target_activation_ms: targetLatencyMs
    });
    actions.push({
      action: 'swarm_forensic_capture',
      apply: !shadowOnly,
      sandbox: true,
      target_activation_ms: targetLatencyMs
    });
    actions.push({
      action: 'swarm_neutralize_sandboxed_copy',
      apply: !shadowOnly,
      sandbox: true,
      target_activation_ms: targetLatencyMs
    });
  }
  return {
    ok: true,
    mode,
    shadow_only: shadowOnly,
    intensity,
    action_count: actions.length,
    actions
  };
}

module.exports = {
  buildSwarmTactics
};
