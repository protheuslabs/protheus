#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  normalizeToken,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  emit
} = require('../../lib/queued_backlog_runtime');

const DEFAULT_POLICY_PATH = process.env.HOLO_OVERLAY_COMPILER_POLICY_PATH
  ? path.resolve(process.env.HOLO_OVERLAY_COMPILER_POLICY_PATH)
  : path.join(ROOT, 'config', 'holo_overlay_compiler_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/holo_overlay_compiler.js compile [--apply=0|1] [--policy=<path>]');
  console.log('  node systems/ops/holo_overlay_compiler.js status [--policy=<path>]');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    paths: {
      latest_path: 'state/ops/holo_overlay_compiler/latest.json',
      receipts_path: 'state/ops/holo_overlay_compiler/receipts.jsonl',
      overlay_path: 'state/ops/holo_overlays/latest.json',
      fusion_path: 'state/fractal/symbiotic_fusion_chamber/latest.json',
      resonance_path: 'state/fractal/resonance_field_gates/latest.json',
      inversion_path: 'state/autonomy/inversion/latest.json',
      runtime_path: 'state/ops/protheus_top/latest.json',
      router_path: 'state/routing/model_router/latest.json',
      weaver_path: 'state/weaver/latest.json'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    paths: {
      latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
      receipts_path: resolvePath(paths.receipts_path, base.paths.receipts_path),
      overlay_path: resolvePath(paths.overlay_path, base.paths.overlay_path),
      fusion_path: resolvePath(paths.fusion_path, base.paths.fusion_path),
      resonance_path: resolvePath(paths.resonance_path, base.paths.resonance_path),
      inversion_path: resolvePath(paths.inversion_path, base.paths.inversion_path),
      runtime_path: resolvePath(paths.runtime_path, base.paths.runtime_path),
      router_path: resolvePath(paths.router_path, base.paths.router_path),
      weaver_path: resolvePath(paths.weaver_path, base.paths.weaver_path)
    }
  };
}

function writeReceipt(policy, row) {
  const out = { ts: nowIso(), ok: true, shadow_only: policy.shadow_only, ...row };
  writeJsonAtomic(policy.paths.latest_path, out);
  appendJsonl(policy.paths.receipts_path, out);
  return out;
}

function compile(args, policy) {
  const apply = toBool(args.apply, false);
  const fusion = readJson(policy.paths.fusion_path, {});
  const resonance = readJson(policy.paths.resonance_path, {});
  const inversion = readJson(policy.paths.inversion_path, {});
  const runtime = readJson(policy.paths.runtime_path, {});
  const router = readJson(policy.paths.router_path, {});
  const weaver = readJson(policy.paths.weaver_path, {});

  const emergence = {
    fusion_state: cleanText(fusion.fusion_state || fusion.state || 'idle', 40),
    resonance_band: cleanText(resonance.band || resonance.resonance_band || 'neutral', 40),
    shadow_pressure: Number(inversion.shadow_pressure || inversion.shadow_pressure_index || 0),
    molt_window: cleanText(runtime.molt_window || runtime.molt_state || 'closed', 40)
  };

  const control_plane = {
    routing_lane: cleanText(router.selected_lane || router.last_lane || 'unknown', 40),
    trust_posture: cleanText(weaver.trust_posture || weaver.trust_lane || 'unknown', 40),
    provider_health: Array.isArray(router.providers)
      ? router.providers.slice(0, 8).map((row) => ({
          provider: cleanText(row.provider || row.id || 'unknown', 60),
          status: cleanText(row.status || 'unknown', 40)
        }))
      : [],
    error_lane_count: Number(router.error_lane_count || 0)
  };

  const payload = {
    schema_id: 'holo_overlay_contract',
    schema_version: '1.0',
    generated_at: nowIso(),
    emergence,
    control_plane
  };

  if (apply) writeJsonAtomic(policy.paths.overlay_path, payload);

  return writeReceipt(policy, {
    type: 'holo_overlay_compile',
    apply,
    overlay_path: path.relative(ROOT, policy.paths.overlay_path).replace(/\\/g, '/'),
    emergence,
    control_plane_summary: {
      routing_lane: control_plane.routing_lane,
      trust_posture: control_plane.trust_posture,
      provider_count: control_plane.provider_health.length,
      error_lane_count: control_plane.error_lane_count
    }
  });
}

function status(policy) {
  return {
    ok: true,
    type: 'holo_overlay_compiler_status',
    shadow_only: policy.shadow_only,
    latest: readJson(policy.paths.latest_path, {}),
    overlay: readJson(policy.paths.overlay_path, {})
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    return;
  }
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  if (!policy.enabled) emit({ ok: false, error: 'holo_overlay_compiler_disabled' }, 1);

  if (cmd === 'compile') emit(compile(args, policy));
  if (cmd === 'status') emit(status(policy));

  emit({ ok: false, error: `unknown_command:${cmd}` }, 1);
}

main();
