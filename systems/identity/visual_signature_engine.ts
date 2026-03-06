#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-134
 * Deterministic visual signature engine.
 */

const fs = require('fs');
const path = require('path');
const {
  normalizeToken,
  cleanText,
  stableHash,
  nowIso,
  readJson,
  writeJsonAtomic
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.VISUAL_SIGNATURE_ENGINE_POLICY_PATH
  ? path.resolve(process.env.VISUAL_SIGNATURE_ENGINE_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'visual_signature_engine_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/identity/visual_signature_engine.js configure --owner=<owner_id> [--theme=ember] [--complexity=2]');
  console.log('  node systems/identity/visual_signature_engine.js render --owner=<owner_id> [--apply=1] [--risk-tier=2]');
  console.log('  node systems/identity/visual_signature_engine.js status [--owner=<owner_id>]');
}

function colorFromSeed(seed: string, offset: string) {
  const h = parseInt(stableHash(`${seed}|${offset}`, 6), 16) % 360;
  const s = 58 + (parseInt(stableHash(`${seed}|${offset}|s`, 2), 16) % 28);
  const l = 42 + (parseInt(stableHash(`${seed}|${offset}|l`, 2), 16) % 22);
  return `hsl(${h} ${s}% ${l}%)`;
}

function buildSvg(seed: string, complexity: number) {
  const layers = Math.max(1, Math.min(6, Number(complexity || 2)));
  const accent = colorFromSeed(seed, 'accent');
  const base = colorFromSeed(seed, 'base');
  const rings = [];
  for (let i = 0; i < layers; i += 1) {
    const r = 10 + i * 10;
    const stroke = colorFromSeed(seed, `ring-${i}`);
    const width = 1 + (i % 3);
    rings.push(`<circle cx="64" cy="64" r="${r}" stroke="${stroke}" stroke-width="${width}" fill="none" opacity="0.85"/>`);
  }
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
    `<rect width="128" height="128" rx="18" fill="${base}"/>`,
    ...rings,
    `<path d="M20,96 Q64,20 108,96" stroke="${accent}" stroke-width="4" fill="none" opacity="0.95"/>`,
    '</svg>'
  ].join('');
}

function resolveMemoryOwnerPath(policy: any, ownerId: string) {
  return path.join(policy.paths.memory_dir, `${ownerId}.json`);
}

function loadOwnerState(policy: any, ownerId: string) {
  const fp = resolveMemoryOwnerPath(policy, ownerId);
  const row = readJson(fp, {
    owner_id: ownerId,
    preferences: {},
    render_history: []
  });
  return {
    owner_id: ownerId,
    preferences: row && row.preferences && typeof row.preferences === 'object' ? row.preferences : {},
    render_history: Array.isArray(row && row.render_history) ? row.render_history : []
  };
}

function saveOwnerState(policy: any, ownerId: string, row: any) {
  const fp = resolveMemoryOwnerPath(policy, ownerId);
  writeJsonAtomic(fp, row);
  return fp;
}

function updateAdaptiveStyle(policy: any, ownerId: string, styleRow: any) {
  const stylePath = policy.paths.style_tuning_path
    ? String(policy.paths.style_tuning_path)
    : path.join(path.dirname(policy.paths.adaptive_index_path), 'style_tuning.json');
  const payload = readJson(stylePath, { owners: {} });
  const owners = payload && payload.owners && typeof payload.owners === 'object' ? payload.owners : {};
  owners[ownerId] = styleRow;
  writeJsonAtomic(stylePath, {
    schema_id: 'visual_signature_style_tuning',
    schema_version: '1.0',
    updated_at: nowIso(),
    owners
  });
  return stylePath;
}

runStandardLane({
  lane_id: 'V3-RACE-134',
  script_rel: 'systems/identity/visual_signature_engine.js',
  policy_path: POLICY_PATH,
  stream: 'identity.visual_signature',
  paths: {
    memory_dir: 'memory/identity/signature',
    adaptive_index_path: 'adaptive/identity/signature/index.json',
    events_path: 'state/identity/visual_signature/events.jsonl',
    latest_path: 'state/identity/visual_signature/latest.json',
    receipts_path: 'state/identity/visual_signature/receipts.jsonl',
    manifests_dir: 'state/identity/visual_signature/manifests',
    style_tuning_path: 'adaptive/identity/signature/style_tuning.json'
  },
  usage,
  handlers: {
    render(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const owner = loadOwnerState(policy, ownerId);
      const pref = owner.preferences || {};
      const complexity = Math.max(1, Math.min(6, Number(args.complexity || pref.complexity || 2)));
      const theme = cleanText(args.theme || pref.theme || 'ember', 80) || 'ember';
      const seed = `${ownerId}|${theme}|${complexity}|${owner.render_history.length}`;
      const svg = buildSvg(seed, complexity);
      const manifestId = `sig_${stableHash(`${ownerId}|${theme}|${complexity}|${Date.now()}`, 18)}`;
      const signatureHash = stableHash(svg, 32);
      const ts = nowIso();

      const manifest = {
        manifest_id: manifestId,
        owner_id: ownerId,
        lane_id: 'V3-RACE-134',
        theme,
        complexity,
        generated_at: ts,
        signature_hash: signatureHash,
        renderer: {
          engine: 'visual_signature_engine',
          deterministic: true
        }
      };

      const apply = args.apply == null ? true : String(args.apply) !== '0';
      let manifestPath = null;
      let svgPath = null;
      if (apply) {
        const dir = String(policy.paths.manifests_dir);
        fs.mkdirSync(dir, { recursive: true });
        manifestPath = path.join(dir, `${manifestId}.json`);
        svgPath = path.join(dir, `${manifestId}.svg`);
        writeJsonAtomic(manifestPath, manifest);
        fs.writeFileSync(svgPath, svg, 'utf8');

        const maxHistory = Math.max(5, Math.min(200, Number(policy.constraints && policy.constraints.max_render_history || 50)));
        const nextHistory = owner.render_history.concat([{
          manifest_id: manifestId,
          signature_hash: signatureHash,
          generated_at: ts,
          theme,
          complexity
        }]).slice(-maxHistory);
        const ownerPath = saveOwnerState(policy, ownerId, {
          owner_id: ownerId,
          preferences: {
            ...pref,
            theme,
            complexity
          },
          render_history: nextHistory
        });
        const stylePath = updateAdaptiveStyle(policy, ownerId, {
          theme,
          complexity,
          last_manifest_id: manifestId,
          last_signature_hash: signatureHash,
          updated_at: ts
        });
        manifest.memory_owner_path = path.relative(path.resolve(__dirname, '..', '..'), ownerPath).replace(/\\/g, '/');
        manifest.adaptive_style_tuning_path = path.relative(path.resolve(__dirname, '..', '..'), stylePath).replace(/\\/g, '/');
      }

      const record = ctx.cmdRecord(policy, {
        ...args,
        owner: ownerId,
        event: 'visual_signature_render',
        apply: apply ? '1' : '0',
        payload_json: JSON.stringify({
          manifest_id: manifestId,
          owner_id: ownerId,
          theme,
          complexity,
          signature_hash: signatureHash
        })
      });
      if (!record.ok) return record;
      return {
        ...record,
        manifest,
        svg,
        artifacts: {
          ...(record.artifacts || {}),
          manifest_path: manifestPath
            ? path.relative(path.resolve(__dirname, '..', '..'), manifestPath).replace(/\\/g, '/')
            : null,
          svg_path: svgPath
            ? path.relative(path.resolve(__dirname, '..', '..'), svgPath).replace(/\\/g, '/')
            : null
        }
      };
    }
  }
});
