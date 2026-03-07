#!/usr/bin/env node
'use strict';
export {};

/**
 * V4-MIGR-002
 * Community repo graduation artifact pack.
 */

const fs = require('fs');
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
  stableHash,
  emit
} = require('../../lib/queued_backlog_runtime');

type AnyObj = Record<string, any>;

const DEFAULT_POLICY_PATH = process.env.COMMUNITY_REPO_GRADUATION_PACK_POLICY_PATH
  ? path.resolve(process.env.COMMUNITY_REPO_GRADUATION_PACK_POLICY_PATH)
  : path.join(ROOT, 'config', 'community_repo_graduation_pack_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/migration/community_repo_graduation_pack.js run --legacy-repo=<url> --target-repo=<url> [--apply=1|0] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/migration/community_repo_graduation_pack.js status [--policy=<path>]');
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_default: false,
    signing: {
      key_env: 'PROTHEUS_MIGRATION_SIGNING_KEY',
      default_key: 'migration_dev_key',
      algorithm: 'sha256'
    },
    defaults: {
      legacy_repo_url: 'https://github.com/openclaw/openclaw',
      target_repo_url: 'https://github.com/protheuslabs/protheus',
      migration_guide_url: 'docs/CORE_MIGRATION_BRIDGE.md'
    },
    files: {
      legacy_readme_path: 'README.md',
      banner_path: 'docs/migration/community_repo_banner.md',
      pinned_issue_path: 'docs/migration/pinned_migration_issue.md',
      redirect_metadata_path: 'docs/migration/repo_redirect.json',
      latest_path: 'state/migration/community_repo_graduation/latest.json',
      receipts_path: 'state/migration/community_repo_graduation/receipts.jsonl'
    },
    readme_banner_markers: {
      start: '<!-- MIGRATION_BANNER_START -->',
      end: '<!-- MIGRATION_BANNER_END -->'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const raw = readJson(policyPath, {});
  const base = defaultPolicy();
  const signing = raw.signing && typeof raw.signing === 'object' ? raw.signing : {};
  const defaults = raw.defaults && typeof raw.defaults === 'object' ? raw.defaults : {};
  const files = raw.files && typeof raw.files === 'object' ? raw.files : {};
  const markers = raw.readme_banner_markers && typeof raw.readme_banner_markers === 'object'
    ? raw.readme_banner_markers
    : {};

  return {
    version: cleanText(raw.version || base.version, 32),
    enabled: toBool(raw.enabled, true),
    strict_default: toBool(raw.strict_default, base.strict_default),
    signing: {
      key_env: cleanText(signing.key_env || base.signing.key_env, 120),
      default_key: cleanText(signing.default_key || base.signing.default_key, 240),
      algorithm: cleanText(signing.algorithm || base.signing.algorithm, 40)
    },
    defaults: {
      legacy_repo_url: cleanText(defaults.legacy_repo_url || base.defaults.legacy_repo_url, 280),
      target_repo_url: cleanText(defaults.target_repo_url || base.defaults.target_repo_url, 280),
      migration_guide_url: cleanText(defaults.migration_guide_url || base.defaults.migration_guide_url, 280)
    },
    files: {
      legacy_readme_path: resolvePath(files.legacy_readme_path, base.files.legacy_readme_path),
      banner_path: resolvePath(files.banner_path, base.files.banner_path),
      pinned_issue_path: resolvePath(files.pinned_issue_path, base.files.pinned_issue_path),
      redirect_metadata_path: resolvePath(files.redirect_metadata_path, base.files.redirect_metadata_path),
      latest_path: resolvePath(files.latest_path, base.files.latest_path),
      receipts_path: resolvePath(files.receipts_path, base.files.receipts_path)
    },
    readme_banner_markers: {
      start: cleanText(markers.start || base.readme_banner_markers.start, 80),
      end: cleanText(markers.end || base.readme_banner_markers.end, 80)
    },
    policy_path: path.resolve(policyPath)
  };
}

function ensureDirFor(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readText(filePath: string) {
  try {
    return fs.existsSync(filePath) ? String(fs.readFileSync(filePath, 'utf8') || '') : '';
  } catch {
    return '';
  }
}

function writeText(filePath: string, content: string) {
  ensureDirFor(filePath);
  fs.writeFileSync(filePath, String(content || ''), 'utf8');
}

function sign(policy: AnyObj, payload: AnyObj) {
  const envName = cleanText(policy.signing.key_env || 'PROTHEUS_MIGRATION_SIGNING_KEY', 120) || 'PROTHEUS_MIGRATION_SIGNING_KEY';
  const secret = cleanText(process.env[envName] || policy.signing.default_key || 'migration_dev_key', 400) || 'migration_dev_key';
  return {
    algorithm: cleanText(policy.signing.algorithm || 'sha256', 40) || 'sha256',
    key_id: stableHash(`${envName}:${secret}`, 12),
    signature: stableHash(`${JSON.stringify(payload)}|${secret}`, 48)
  };
}

function writeReceipt(policy: AnyObj, payload: AnyObj) {
  const row = {
    ts: nowIso(),
    schema_id: 'community_repo_graduation_pack_receipt',
    schema_version: '1.0',
    ...payload
  };
  row.signature = sign(policy, {
    type: row.type,
    ok: row.ok === true,
    artifact_bundle_id: row.artifact_bundle_id || null
  });
  writeJsonAtomic(policy.files.latest_path, row);
  appendJsonl(policy.files.receipts_path, row);
  return row;
}

function buildBanner(legacyRepo: string, targetRepo: string, migrationGuide: string) {
  return [
    '### Repository Migration Notice',
    '',
    `This repository has moved to **${targetRepo}**.`,
    `- One-click upgrade path: [Open official repository](${targetRepo})`,
    `- Migration evidence and runbook: [Core Migration Bridge](${migrationGuide})`,
    `- Legacy location reference: [${legacyRepo}](${legacyRepo})`,
    ''
  ].join('\n');
}

function buildPinnedIssue(legacyRepo: string, targetRepo: string, migrationGuide: string) {
  return [
    '# This Repository Has Graduated',
    '',
    `The canonical home is now **${targetRepo}**.`,
    '',
    '## What to do now',
    `1. Open the official repo: ${targetRepo}`,
    '2. Pull latest migration guidance and receipts.',
    `3. Follow the runbook: ${migrationGuide}`,
    '',
    '## Why this issue is pinned',
    '- Preserve one-click discoverability from old → new home.',
    '- Prevent ambiguity about where active development happens.',
    '',
    `Legacy repository reference: ${legacyRepo}`,
    ''
  ].join('\n');
}

function upsertReadmeBanner(policy: AnyObj, banner: string) {
  const readmePath = policy.files.legacy_readme_path;
  const existing = readText(readmePath);
  const start = policy.readme_banner_markers.start;
  const end = policy.readme_banner_markers.end;
  const block = `${start}\n${banner.trim()}\n${end}`;

  if (!existing.trim()) {
    writeText(readmePath, `${block}\n`);
    return { inserted: true, replaced: false };
  }

  const startIdx = existing.indexOf(start);
  const endIdx = existing.indexOf(end);
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).replace(/\s*$/, '');
    const after = existing.slice(endIdx + end.length).replace(/^\s*/, '');
    const next = `${before}\n\n${block}\n\n${after}`.trimEnd() + '\n';
    writeText(readmePath, next);
    return { inserted: false, replaced: true };
  }

  const next = `${block}\n\n${existing}`;
  writeText(readmePath, next);
  return { inserted: true, replaced: false };
}

function verifyArtifacts(policy: AnyObj, targetRepo: string, migrationGuide: string) {
  const banner = readText(policy.files.banner_path);
  const pinned = readText(policy.files.pinned_issue_path);
  const redirect = readJson(policy.files.redirect_metadata_path, null);
  const readme = readText(policy.files.legacy_readme_path);
  const oneClick = `${targetRepo}`;

  const checks = {
    banner_exists: !!banner.trim(),
    pinned_issue_exists: !!pinned.trim(),
    redirect_metadata_exists: !!redirect,
    banner_has_one_click_link: banner.includes(oneClick),
    pinned_issue_has_one_click_link: pinned.includes(oneClick),
    redirect_has_one_click_url: !!(redirect && redirect.one_click_upgrade_url && String(redirect.one_click_upgrade_url).trim()),
    migration_guide_linked: banner.includes(migrationGuide) && pinned.includes(migrationGuide),
    legacy_readme_discoverable: readme.includes(oneClick) || readme.includes(policy.readme_banner_markers.start)
  };

  return {
    checks,
    pass: Object.values(checks).every(Boolean),
    redirect_metadata: redirect
  };
}

function runPack(args: AnyObj, policy: AnyObj) {
  const strict = args.strict != null ? toBool(args.strict, false) : policy.strict_default;
  const apply = toBool(args.apply, false);
  const legacyRepo = cleanText(args['legacy-repo'] || args.legacy_repo || policy.defaults.legacy_repo_url, 280);
  const targetRepo = cleanText(args['target-repo'] || args.target_repo || policy.defaults.target_repo_url, 280);
  const migrationGuide = cleanText(args['migration-guide'] || args.migration_guide || policy.defaults.migration_guide_url, 280);

  if (!legacyRepo || !targetRepo || !migrationGuide) {
    return writeReceipt(policy, {
      ok: false,
      type: 'community_repo_graduation_pack_run',
      error: 'legacy_repo_target_repo_and_migration_guide_required',
      strict,
      apply
    });
  }

  const banner = buildBanner(legacyRepo, targetRepo, migrationGuide);
  const pinned = buildPinnedIssue(legacyRepo, targetRepo, migrationGuide);
  const redirect = {
    schema_id: 'community_repo_redirect',
    schema_version: '1.0',
    ts: nowIso(),
    legacy_repo_url: legacyRepo,
    target_repo_url: targetRepo,
    one_click_upgrade_url: targetRepo,
    migration_guide_url: migrationGuide,
    pinned_issue_path: rel(policy.files.pinned_issue_path),
    banner_path: rel(policy.files.banner_path)
  };

  const artifactBundleId = `grad_${stableHash(`${legacyRepo}|${targetRepo}|${migrationGuide}`, 12)}`;

  if (apply) {
    writeText(policy.files.banner_path, `${banner.trim()}\n`);
    writeText(policy.files.pinned_issue_path, `${pinned.trim()}\n`);
    ensureDirFor(policy.files.redirect_metadata_path);
    writeJsonAtomic(policy.files.redirect_metadata_path, redirect);
    upsertReadmeBanner(policy, banner);
  }

  const verification = verifyArtifacts(policy, targetRepo, migrationGuide);
  const out = {
    ok: strict ? verification.pass : true,
    type: 'community_repo_graduation_pack_run',
    lane_id: 'V4-MIGR-002',
    strict,
    apply,
    artifact_bundle_id: artifactBundleId,
    legacy_repo_url: legacyRepo,
    target_repo_url: targetRepo,
    migration_guide_url: migrationGuide,
    artifacts: {
      banner_path: rel(policy.files.banner_path),
      pinned_issue_path: rel(policy.files.pinned_issue_path),
      redirect_metadata_path: rel(policy.files.redirect_metadata_path),
      legacy_readme_path: rel(policy.files.legacy_readme_path)
    },
    verification
  };

  return writeReceipt(policy, out);
}

function status(policy: AnyObj) {
  return {
    ok: true,
    type: 'community_repo_graduation_pack_status',
    lane_id: 'V4-MIGR-002',
    enabled: policy.enabled,
    latest: readJson(policy.files.latest_path, null),
    latest_path: rel(policy.files.latest_path),
    receipts_path: rel(policy.files.receipts_path)
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
  if (!policy.enabled) emit({ ok: false, error: 'community_repo_graduation_pack_disabled' }, 1);

  if (cmd === 'run') {
    const out = runPack(args, policy);
    emit(out, out.ok ? 0 : 1);
  }
  if (cmd === 'status') emit(status(policy));

  usage();
  process.exit(1);
}

main();
