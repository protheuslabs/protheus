#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-CONF-001
 *
 * Platform Path-Contract Compatibility Pack
 * - maintains external-facing platform artifacts under `platform/`
 * - references canonical open-platform release-pack outputs
 * - verifies compatibility artifacts without duplicating release business logic
 */

const fs = require('fs');
const path = require('path');
const {
  ROOT,
  nowIso,
  parseArgs,
  cleanText,
  toBool,
  readJson,
  writeJsonAtomic,
  appendJsonl,
  resolvePath,
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

const POLICY_PATH = process.env.PLATFORM_PATH_CONTRACT_POLICY_PATH
  ? path.resolve(process.env.PLATFORM_PATH_CONTRACT_POLICY_PATH)
  : path.join(ROOT, 'config', 'platform_path_contract_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/platform_path_contract_pack.js sync [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/platform_path_contract_pack.js verify [--policy=<path>]');
  console.log('  node systems/ops/platform_path_contract_pack.js status [--policy=<path>]');
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function writeText(filePath: string, body: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, 'utf8');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    shadow_only: true,
    source: {
      release_pack_path: 'state/ops/open_platform_release_pack/release_pack.json',
      checklist_path: 'state/ops/open_platform_release_pack/checklist_evidence.json',
      latest_path: 'state/ops/open_platform_release_pack/latest.json'
    },
    output: {
      readme_path: 'platform/README.md',
      license_carveout_path: 'platform/LICENSE_APACHE_2_0_CARVEOUT.md',
      badges_index_path: 'platform/compatibility_badges.json',
      export_manifest_path: 'platform/export_manifest.json',
      export_cli_path: 'platform/export_cli.js',
      latest_path: 'state/ops/platform_path_contract_pack/latest.json',
      receipts_path: 'state/ops/platform_path_contract_pack/receipts.jsonl',
      state_path: 'state/ops/platform_path_contract_pack/state.json'
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const source = raw.source && typeof raw.source === 'object' ? raw.source : {};
  const output = raw.output && typeof raw.output === 'object' ? raw.output : {};
  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: toBool(raw.enabled, true),
    shadow_only: toBool(raw.shadow_only, true),
    source: {
      release_pack_path: resolvePath(source.release_pack_path, base.source.release_pack_path),
      checklist_path: resolvePath(source.checklist_path, base.source.checklist_path),
      latest_path: resolvePath(source.latest_path, base.source.latest_path)
    },
    output: {
      readme_path: resolvePath(output.readme_path, base.output.readme_path),
      license_carveout_path: resolvePath(output.license_carveout_path, base.output.license_carveout_path),
      badges_index_path: resolvePath(output.badges_index_path, base.output.badges_index_path),
      export_manifest_path: resolvePath(output.export_manifest_path, base.output.export_manifest_path),
      export_cli_path: resolvePath(output.export_cli_path, base.output.export_cli_path),
      latest_path: resolvePath(output.latest_path, base.output.latest_path),
      receipts_path: resolvePath(output.receipts_path, base.output.receipts_path),
      state_path: resolvePath(output.state_path, base.output.state_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function readSources(policy: any) {
  const releasePack = readJson(policy.source.release_pack_path, null);
  const checklist = readJson(policy.source.checklist_path, null);
  const latest = readJson(policy.source.latest_path, null);
  return {
    release_pack: releasePack,
    checklist,
    latest,
    release_pack_exists: !!(releasePack && typeof releasePack === 'object'),
    checklist_exists: !!(checklist && typeof checklist === 'object'),
    latest_exists: !!(latest && typeof latest === 'object')
  };
}

function buildReadme(policy: any, src: any, manifestRel: string) {
  const badges = Array.isArray(src.release_pack && src.release_pack.compatibility_badges)
    ? src.release_pack.compatibility_badges
    : [];
  const integrations = badges
    .map((row: any) => cleanText(row.integration || '', 80))
    .filter(Boolean)
    .sort();
  const integrationText = integrations.length ? integrations.join(', ') : 'none';
  return [
    '# Platform Compatibility Layer',
    '',
    'This directory is a compatibility surface for external path-contract tooling.',
    'Canonical implementation remains in `systems/ops/open_platform_release_pack.ts`.',
    '',
    '## Canonical Sources',
    `- release pack: \`${rel(policy.source.release_pack_path)}\``,
    `- checklist evidence: \`${rel(policy.source.checklist_path)}\``,
    `- latest status: \`${rel(policy.source.latest_path)}\``,
    '',
    '## Compatibility Artifacts',
    `- export manifest: \`${manifestRel}\``,
    `- badges index: \`${rel(policy.output.badges_index_path)}\``,
    `- export CLI shim: \`${rel(policy.output.export_cli_path)}\``,
    '',
    `Known integrations: ${integrationText}`,
    ''
  ].join('\n');
}

function buildLicenseCarveout(policy: any) {
  return [
    '# Apache-2.0 Platform Carveout',
    '',
    'This compatibility layer references open-platform artifacts for external consumers.',
    'Canonical licensing and release policy remain governed by:',
    '',
    '- `LICENSE`',
    '- `systems/ops/open_platform_release_pack.ts`',
    '- `config/open_platform_release_pack_policy.json`',
    '',
    `Generated: ${nowIso()} (${rel(policy.policy_path)})`,
    ''
  ].join('\n');
}

function syncPack(policy: any, strict = false) {
  const src = readSources(policy);
  const badges = Array.isArray(src.release_pack && src.release_pack.compatibility_badges)
    ? src.release_pack.compatibility_badges
    : [];

  const badgesIndex = {
    schema_id: 'platform_compatibility_badges_index',
    schema_version: '1.0',
    generated_at: nowIso(),
    source_release_pack: rel(policy.source.release_pack_path),
    badges: badges.map((row: any) => ({
      integration: cleanText(row.integration || '', 80),
      ok: row.ok === true,
      signed: row.signed === true,
      badge_path: cleanText(row.badge_path || '', 260) || null
    }))
  };
  writeJsonAtomic(policy.output.badges_index_path, badgesIndex);

  const exportManifest = {
    schema_id: 'platform_export_manifest',
    schema_version: '1.0',
    generated_at: nowIso(),
    canonical: {
      release_pack_path: rel(policy.source.release_pack_path),
      checklist_path: rel(policy.source.checklist_path),
      latest_path: rel(policy.source.latest_path)
    },
    compatibility: {
      readme_path: rel(policy.output.readme_path),
      license_carveout_path: rel(policy.output.license_carveout_path),
      badges_index_path: rel(policy.output.badges_index_path),
      export_cli_path: rel(policy.output.export_cli_path)
    },
    signature: stableHash(JSON.stringify({
      canonical: [rel(policy.source.release_pack_path), rel(policy.source.checklist_path), rel(policy.source.latest_path)],
      compatibility: [rel(policy.output.readme_path), rel(policy.output.license_carveout_path), rel(policy.output.badges_index_path), rel(policy.output.export_cli_path)]
    }), 40)
  };
  writeJsonAtomic(policy.output.export_manifest_path, exportManifest);

  writeText(policy.output.readme_path, `${buildReadme(policy, src, rel(policy.output.export_manifest_path))}\n`);
  writeText(policy.output.license_carveout_path, `${buildLicenseCarveout(policy)}\n`);

  const checks = {
    release_pack_exists: src.release_pack_exists,
    checklist_exists: src.checklist_exists,
    latest_exists: src.latest_exists,
    export_cli_exists: fs.existsSync(policy.output.export_cli_path),
    badges_index_exists: fs.existsSync(policy.output.badges_index_path),
    readme_exists: fs.existsSync(policy.output.readme_path),
    manifest_exists: fs.existsSync(policy.output.export_manifest_path)
  };
  const requiredChecks = [
    'release_pack_exists',
    'checklist_exists',
    'latest_exists',
    'export_cli_exists',
    'badges_index_exists',
    'readme_exists',
    'manifest_exists'
  ];
  const passed = requiredChecks.filter((key) => checks[key] === true).length;
  const ok = strict ? passed === requiredChecks.length : true;

  const out = {
    ok,
    type: 'platform_path_contract_pack_sync',
    strict,
    checks,
    checks_total: requiredChecks.length,
    checks_passed: passed,
    output: {
      readme_path: rel(policy.output.readme_path),
      license_carveout_path: rel(policy.output.license_carveout_path),
      badges_index_path: rel(policy.output.badges_index_path),
      export_manifest_path: rel(policy.output.export_manifest_path),
      export_cli_path: rel(policy.output.export_cli_path)
    },
    source: {
      release_pack_path: rel(policy.source.release_pack_path),
      checklist_path: rel(policy.source.checklist_path),
      latest_path: rel(policy.source.latest_path)
    },
    ts: nowIso()
  };
  appendJsonl(policy.output.receipts_path, out);
  writeJsonAtomic(policy.output.latest_path, out);
  writeJsonAtomic(policy.output.state_path, {
    schema_id: 'platform_path_contract_pack_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    last_sync_ok: ok,
    checks
  });
  return out;
}

function verifyPack(policy: any) {
  const latest = readJson(policy.output.latest_path, null);
  const manifest = readJson(policy.output.export_manifest_path, null);
  const badges = readJson(policy.output.badges_index_path, null);
  const readmeExists = fs.existsSync(policy.output.readme_path);
  const licenseExists = fs.existsSync(policy.output.license_carveout_path);

  const checks = {
    latest_exists: !!(latest && typeof latest === 'object'),
    manifest_exists: !!(manifest && typeof manifest === 'object'),
    badges_exists: !!(badges && typeof badges === 'object'),
    readme_exists: readmeExists,
    license_exists: licenseExists
  };
  const keys = Object.keys(checks);
  const passed = keys.filter((key) => checks[key] === true).length;
  const ok = passed === keys.length;
  const out = {
    ok,
    type: 'platform_path_contract_pack_verify',
    checks,
    checks_total: keys.length,
    checks_passed: passed,
    ts: nowIso()
  };
  appendJsonl(policy.output.receipts_path, out);
  writeJsonAtomic(policy.output.latest_path, out);
  return out;
}

function statusPack(policy: any) {
  const latest = readJson(policy.output.latest_path, null);
  const state = readJson(policy.output.state_path, null);
  const manifest = readJson(policy.output.export_manifest_path, null);
  return {
    ok: true,
    type: 'platform_path_contract_pack_status',
    ts: nowIso(),
    policy: {
      version: policy.version,
      shadow_only: policy.shadow_only,
      policy_path: rel(policy.policy_path)
    },
    latest,
    state,
    export_manifest: manifest
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || args.help) {
    usage();
    process.exit(cmd ? 0 : 1);
  }
  const policy = loadPolicy(args.policy || POLICY_PATH);
  if (!policy.enabled) emit({ ok: false, error: 'platform_path_contract_pack_disabled' }, 1);

  if (cmd === 'sync') {
    const strict = toBool(args.strict, false);
    const out = syncPack(policy, strict);
    emit(out, out.ok ? 0 : 1);
  }
  if (cmd === 'verify') emit(verifyPack(policy), 0);
  if (cmd === 'status') emit(statusPack(policy), 0);
  usage();
  process.exit(1);
}

main();
