#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-193
 * Mobile wrapper/runtime distribution pack for Android/Termux + iOS/Tauri.
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  cleanText,
  normalizeToken,
  toBool,
  stableHash,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.MOBILE_WRAPPER_DISTRIBUTION_PACK_POLICY_PATH
  ? path.resolve(process.env.MOBILE_WRAPPER_DISTRIBUTION_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'mobile_wrapper_distribution_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/mobile_wrapper_distribution_pack.js configure --owner=<owner_id>');
  console.log('  node systems/ops/mobile_wrapper_distribution_pack.js build --owner=<owner_id> --target=android_termux|ios_tauri [--version=0.1.0] [--apply=1]');
  console.log('  node systems/ops/mobile_wrapper_distribution_pack.js verify --owner=<owner_id> [--target=android_termux|ios_tauri] [--bundle-id=<id>] [--strict=1] [--apply=1]');
  console.log('  node systems/ops/mobile_wrapper_distribution_pack.js rollback --owner=<owner_id> [--target=android_termux|ios_tauri] [--bundle-id=<id>] [--reason=<text>] [--apply=1]');
  console.log('  node systems/ops/mobile_wrapper_distribution_pack.js status [--owner=<owner_id>]');
}

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function absPath(rawPath: unknown, fallbackRel: string) {
  const raw = cleanText(rawPath || '', 600);
  if (!raw) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
}

function readManifest(policy: any) {
  return readJson(policy.paths.manifest_path, {
    schema_id: 'mobile_wrapper_distribution_manifest',
    schema_version: '1.0',
    bundles: [],
    active_by_target: {},
    updated_at: null
  });
}

function writeManifest(policy: any, manifest: any) {
  ensureDir(policy.paths.manifest_path);
  writeJsonAtomic(policy.paths.manifest_path, manifest);
}

function allowedTargets(policy: any) {
  const fromPolicy = Array.isArray(policy.allowed_targets)
    ? policy.allowed_targets.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
    : [];
  if (fromPolicy.length > 0) return fromPolicy;
  const wrapperKeys = policy.wrappers && typeof policy.wrappers === 'object'
    ? Object.keys(policy.wrappers)
      .map((row) => normalizeToken(row, 80))
      .filter(Boolean)
    : [];
  return wrapperKeys.length > 0 ? wrapperKeys : ['android_termux', 'ios_tauri'];
}

function wrapperConfig(policy: any, target: string) {
  const wrappers = policy.wrappers && typeof policy.wrappers === 'object' ? policy.wrappers : {};
  const row = wrappers[target] && typeof wrappers[target] === 'object' ? wrappers[target] : {};
  return {
    target,
    install_script_path: absPath(row.install_script_path, `packages/protheus-edge/wrappers/${target}/install.sh`),
    run_script_path: absPath(row.run_script_path, `packages/protheus-edge/wrappers/${target}/run.sh`),
    verify_script_path: absPath(row.verify_script_path, `packages/protheus-edge/wrappers/${target}/verify.sh`)
  };
}

function bundleSignature(bundle: any) {
  return stableHash(
    [
      bundle.bundle_id,
      bundle.owner_id,
      bundle.target,
      bundle.version,
      bundle.install_script_path,
      bundle.run_script_path,
      bundle.verify_script_path,
      bundle.created_at
    ].join('|'),
    32
  );
}

function summarize(manifest: any) {
  const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : [];
  return {
    bundle_count: bundles.length,
    active_count: bundles.filter((row: any) => row.status === 'active').length,
    rolled_back_count: bundles.filter((row: any) => row.status === 'rolled_back').length
  };
}

function pickBundle(manifest: any, target: string, bundleId: string) {
  const bundles = Array.isArray(manifest.bundles) ? manifest.bundles : [];
  if (bundleId) return bundles.find((row: any) => String(row.bundle_id) === bundleId) || null;
  const activeByTarget = manifest.active_by_target && typeof manifest.active_by_target === 'object'
    ? manifest.active_by_target
    : {};
  const activeId = activeByTarget[target] ? String(activeByTarget[target]) : '';
  if (!activeId) return null;
  return bundles.find((row: any) => String(row.bundle_id) === activeId) || null;
}

runStandardLane({
  lane_id: 'V3-RACE-193',
  script_rel: 'systems/ops/mobile_wrapper_distribution_pack.js',
  policy_path: POLICY_PATH,
  stream: 'edge.wrapper_distribution',
  paths: {
    memory_dir: 'memory/edge/mobile_wrapper_distribution',
    adaptive_index_path: 'adaptive/edge/mobile_wrapper_distribution/index.json',
    events_path: 'state/edge/mobile_wrapper_distribution/events.jsonl',
    latest_path: 'state/edge/mobile_wrapper_distribution/latest.json',
    receipts_path: 'state/edge/mobile_wrapper_distribution/receipts.jsonl',
    manifest_path: 'state/edge/mobile_wrapper_distribution/manifest.json'
  },
  usage,
  handlers: {
    build(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const target = normalizeToken(args.target || 'android_termux', 80);
      const targets = allowedTargets(policy);
      if (!target || !targets.includes(target)) {
        return { ok: false, error: 'unsupported_target', target: target || null, allowed_targets: targets };
      }
      const apply = toBool(args.apply, true);
      const version = cleanText(args.version || '0.1.0', 64) || '0.1.0';
      const wrapper = wrapperConfig(policy, target);
      if (!fs.existsSync(wrapper.install_script_path) || !fs.existsSync(wrapper.run_script_path)) {
        return {
          ok: false,
          error: 'wrapper_scripts_missing',
          target,
          install_script_path: rel(wrapper.install_script_path),
          run_script_path: rel(wrapper.run_script_path)
        };
      }

      const ts = nowIso();
      const bundle = {
        bundle_id: `edge_bundle_${stableHash(`${ownerId}|${target}|${version}|${ts}`, 16)}`,
        owner_id: ownerId,
        target,
        version,
        status: 'active',
        install_script_path: rel(wrapper.install_script_path),
        run_script_path: rel(wrapper.run_script_path),
        verify_script_path: fs.existsSync(wrapper.verify_script_path) ? rel(wrapper.verify_script_path) : null,
        created_at: ts,
        updated_at: ts
      };
      bundle.signed_bundle_manifest_hash = bundleSignature(bundle);

      const manifest = readManifest(policy);
      const bundles = Array.isArray(manifest.bundles) ? manifest.bundles.filter((row: any) => String(row.bundle_id) !== bundle.bundle_id) : [];
      bundles.push(bundle);
      while (bundles.length > 200) bundles.shift();
      const activeByTarget = manifest.active_by_target && typeof manifest.active_by_target === 'object'
        ? { ...manifest.active_by_target }
        : {};
      activeByTarget[target] = bundle.bundle_id;

      const next = {
        ...manifest,
        bundles,
        active_by_target: activeByTarget,
        updated_at: ts
      };
      if (apply) writeManifest(policy, next);

      return ctx.cmdRecord(policy, {
        ...args,
        event: 'mobile_wrapper_bundle_built',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          target,
          version,
          bundle,
          summary: summarize(next),
          manifest_path: rel(policy.paths.manifest_path)
        })
      });
    },

    verify(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const target = normalizeToken(args.target || 'android_termux', 80) || 'android_termux';
      const bundleId = normalizeToken(args['bundle-id'] || args.bundle_id, 120) || '';
      const strict = toBool(args.strict, policy.strict_default !== false);
      const apply = toBool(args.apply, true);

      const manifest = readManifest(policy);
      const bundle = pickBundle(manifest, target, bundleId);
      if (!bundle) {
        return {
          ok: false,
          error: 'bundle_not_found',
          target,
          bundle_id: bundleId || null,
          manifest_path: rel(policy.paths.manifest_path)
        };
      }

      const installExists = fs.existsSync(path.join(ROOT, String(bundle.install_script_path || '')));
      const runExists = fs.existsSync(path.join(ROOT, String(bundle.run_script_path || '')));
      const verifyExists = bundle.verify_script_path ? fs.existsSync(path.join(ROOT, String(bundle.verify_script_path))) : true;
      const expectedHash = bundleSignature(bundle);
      const signatureMatches = String(bundle.signed_bundle_manifest_hash || '') === expectedHash;
      const verified = installExists && runExists && verifyExists && signatureMatches;
      const event = verified ? 'mobile_wrapper_bundle_verified' : 'mobile_wrapper_bundle_verify_failed';

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event,
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          target,
          bundle_id: bundle.bundle_id,
          verified,
          checks: {
            install_exists: installExists,
            run_exists: runExists,
            verify_exists: verifyExists,
            signature_matches: signatureMatches
          },
          manifest_path: rel(policy.paths.manifest_path)
        })
      });

      if (strict && !verified) {
        return {
          ...receipt,
          ok: false,
          error: 'bundle_verification_failed',
          verified,
          bundle_id: bundle.bundle_id
        };
      }
      return {
        ...receipt,
        verified,
        bundle_id: bundle.bundle_id
      };
    },

    rollback(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };
      const target = normalizeToken(args.target || 'android_termux', 80) || 'android_termux';
      const bundleId = normalizeToken(args['bundle-id'] || args.bundle_id, 120) || '';
      const apply = toBool(args.apply, true);
      const reason = cleanText(args.reason || 'operator_rollback', 240) || 'operator_rollback';

      const manifest = readManifest(policy);
      const bundles = Array.isArray(manifest.bundles) ? manifest.bundles.slice() : [];
      const row = pickBundle(manifest, target, bundleId);
      if (!row) {
        return {
          ok: false,
          error: 'bundle_not_found',
          target,
          bundle_id: bundleId || null,
          manifest_path: rel(policy.paths.manifest_path)
        };
      }
      const idx = bundles.findIndex((entry: any) => String(entry.bundle_id) === String(row.bundle_id));
      if (idx < 0) return { ok: false, error: 'bundle_not_found', bundle_id: row.bundle_id };

      const updated = {
        ...bundles[idx],
        status: 'rolled_back',
        rollback_reason: reason,
        updated_at: nowIso(),
        rolled_back_at: nowIso()
      };
      bundles[idx] = updated;

      const activeByTarget = manifest.active_by_target && typeof manifest.active_by_target === 'object'
        ? { ...manifest.active_by_target }
        : {};
      if (String(activeByTarget[target] || '') === String(updated.bundle_id)) {
        activeByTarget[target] = null;
      }
      const next = {
        ...manifest,
        bundles,
        active_by_target: activeByTarget,
        updated_at: nowIso()
      };
      if (apply) writeManifest(policy, next);

      return ctx.cmdRecord(policy, {
        ...args,
        event: 'mobile_wrapper_bundle_rollback',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          target,
          bundle_id: updated.bundle_id,
          reason,
          summary: summarize(next),
          manifest_path: rel(policy.paths.manifest_path)
        })
      });
    },

    status(policy: any, args: any, ctx: any) {
      const base = ctx.cmdStatus(policy, args);
      const manifest = readManifest(policy);
      const summary = summarize(manifest);
      const activeByTarget = manifest.active_by_target && typeof manifest.active_by_target === 'object'
        ? manifest.active_by_target
        : {};
      return {
        ...base,
        ...summary,
        active_by_target: activeByTarget,
        bundles: Array.isArray(manifest.bundles) ? manifest.bundles : [],
        artifacts: {
          ...base.artifacts,
          manifest_path: rel(policy.paths.manifest_path)
        }
      };
    }
  }
});
