#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();

function parseArgs(argv) {
  const out = {
    policy: 'client/runtime/config/client_target_contract_policy.json',
    out: 'core/local/artifacts/client_surface_disposition_current.json',
  };
  for (const arg of argv) {
    if (arg.startsWith('--policy=')) out.policy = arg.slice('--policy='.length);
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
  }
  return out;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'state'].includes(ent.name)) continue;
      walk(p, out);
    } else if (/\.(ts|tsx)$/.test(ent.name)) {
      out.push(p);
    }
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function isTsBootstrapShim(source) {
  const withoutShebang = source.replace(/^#![^\n]*\n/, '');
  const stripped = withoutShebang
    .replace(/['"]use strict['"];?/g, '')
    .replace(/export\s*\{\s*\};?/g, '')
    .replace(/require\(['"][^'"]*ts_bootstrap\.ts['"]\)\.bootstrap\(__filename,\s*module\);?/g, '')
    .replace(/\s+/g, '');
  return stripped.length === 0;
}

function isLegacyAliasShim(source) {
  if (!source.includes('runLegacyAlias({')) return false;
  if (!source.includes('alias_rel:')) return false;
  if (!source.includes('legacy_alias_adapter.ts')) return false;
  const withoutShebang = source.replace(/^#![^\n]*\n/, '');
  const stripped = withoutShebang
    .replace(/['"]use strict['"];?/g, '')
    .replace(
      /const\s*\{\s*runLegacyAlias\s*\}\s*=\s*require\(['"][^'"]*legacy_alias_adapter\.ts['"]\);?/g,
      ''
    )
    .replace(
      /runLegacyAlias\(\{\s*alias_rel:\s*['"][^'"]+['"]\s*(,\s*target_rel:\s*['"][^'"]+['"])?\s*\}\s*(,\s*process\.argv\.slice\(2\)\s*)?\);?/g,
      ''
    )
    .replace(/\s+/g, '');
  return stripped.length === 0;
}

function classify(file, source, policy) {
  const explicit = policy.allowlist_decisions || {};
  if (explicit[file]) return explicit[file];

  if (isTsBootstrapShim(source)) {
    return { bucket: 'keep_public_client', reason: 'TypeScript bootstrap compatibility shim only' };
  }
  if (isLegacyAliasShim(source)) {
    return { bucket: 'keep_public_client', reason: 'legacy alias shim only (no authority logic)' };
  }

  if (file.startsWith('client/cli/bin/')) {
    return { bucket: 'keep_public_client', reason: 'public CLI entrypoint' };
  }
  if (file.startsWith('client/runtime/platform/') || file.startsWith('client/runtime/patches/')) {
    return { bucket: 'keep_public_client', reason: 'client platform/runtime support surface' };
  }
  if (file.startsWith('client/lib/') || file.startsWith('client/runtime/lib/')) {
    return { bucket: 'keep_public_client', reason: 'public SDK/bridge layer pending consolidation' };
  }
  if (file.startsWith('client/cognition/skills/')) {
    return { bucket: 'move_to_adapters', reason: 'skill/integration surface belongs to adapters' };
  }
  if (file.startsWith('client/cognition/habits/')) {
    return { bucket: 'move_to_apps', reason: 'habit workflow surface belongs to app/product layer' };
  }
  if (file.startsWith('client/cognition/')) {
    return { bucket: 'move_to_apps', reason: 'cognition product/workflow logic should sit on top of the client' };
  }
  if ([
    'createLegacyRetiredModule',
    'createCognitionModule',
    'createOpsLaneBridge',
    'createLaneModule',
    'legacy-retired-lane',
    'TypeScript compatibility shim only.',
    'module.exports = require(',
    'Layer ownership: core/',
    'Layer ownership: apps/'
  ].some((marker) => source.includes(marker))) {
    return { bucket: 'collapse_to_generic_wrapper', reason: 'thin wrapper family should be collapsed behind generic entrypoints' };
  }
  if (file.startsWith('client/runtime/systems/')) {
    return { bucket: 'promote_to_core', reason: 'runtime system logic belongs in core unless explicitly public bridge' };
  }
  return { bucket: 'keep_public_client', reason: 'public client/platform surface' };
}

function countBy(entries, keyFn) {
  const counts = {};
  for (const entry of entries) {
    const key = keyFn(entry);
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyPath = path.resolve(ROOT, args.policy);
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  let revision = 'unknown';
  try {
    revision = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {}

  const files = walk(path.resolve(ROOT, 'client'))
    .map(rel)
    .filter((file) => !file.startsWith('client/runtime/local/'))
    .sort();

  const entries = files.map((file) => {
    const source = fs.readFileSync(path.resolve(ROOT, file), 'utf8');
    const decision = classify(file, source, policy);
    return { file, bucket: decision.bucket, reason: decision.reason };
  });

  const payload = {
    type: 'client_surface_disposition',
    generated_at: new Date().toISOString(),
    revision,
    policy_path: rel(policyPath),
    summary: countBy(entries, (entry) => entry.bucket),
    allowlist_audit: Object.entries(policy.allowlist_decisions || {}).map(([file, decision]) => ({ file, ...decision })),
    entries,
  };

  const outPath = path.resolve(ROOT, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload, null, 2));
}

main();
