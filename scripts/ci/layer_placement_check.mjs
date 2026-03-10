#!/usr/bin/env node
/* eslint-disable no-console */
import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

function shell(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function parseArgs(argv) {
  const out = {
    baseRef: '',
    policyPath: 'client/runtime/config/layer_placement_policy.json',
  };
  for (const arg of argv) {
    if (arg.startsWith('--base-ref=')) out.baseRef = arg.slice('--base-ref='.length);
    else if (arg.startsWith('--policy=')) out.policyPath = arg.slice('--policy='.length);
  }
  return out;
}

function resolveBaseRef(explicitBaseRef) {
  if (explicitBaseRef) return explicitBaseRef;
  if (process.env.GITHUB_BASE_REF) return `origin/${process.env.GITHUB_BASE_REF}`;
  try {
    return shell('git rev-parse --verify HEAD~1');
  } catch {
    return shell('git rev-parse --verify HEAD');
  }
}

function changedFiles(baseRef) {
  try {
    const diff = shell(`git diff --name-only --diff-filter=ACMR ${baseRef}...HEAD`);
    if (!diff) return [];
    return diff
      .split('\n')
      .map((v) => v.trim())
      .filter(Boolean)
      .filter((file) => existsSync(file));
  } catch {
    return [];
  }
}

function startsWithAny(path, prefixes) {
  return prefixes.some((prefix) => path.startsWith(prefix));
}

function hasAnyMarkerInHeader(content, markers, maxLines) {
  const header = content.split('\n').slice(0, maxLines).join('\n');
  return markers.some((m) => header.includes(m));
}

function hasAnyMarker(content, markers) {
  return markers.some((m) => content.includes(m));
}

function isSourceFile(path) {
  return /\.(ts|js|rs)$/.test(path);
}

function requiresOwnershipHeader(path) {
  if (!isSourceFile(path)) return false;
  if (path.startsWith('core/layer0/') || path.startsWith('core/layer1/') || path.startsWith('core/layer2/')) return true;
  if (path.startsWith('client/runtime/systems/')) return true;
  if (path.startsWith('apps/')) return true;
  return false;
}

function run() {
  const args = parseArgs(process.argv.slice(2));
  const baseRef = resolveBaseRef(args.baseRef);
  const policyFile = resolve(args.policyPath);
  const policy = JSON.parse(readFileSync(policyFile, 'utf8'));
  const files = changedFiles(baseRef);

  const violations = [];
  for (const file of files) {
    if (!isSourceFile(file)) continue;
    const content = readFileSync(file, 'utf8');

    if (requiresOwnershipHeader(file)) {
      const ok = hasAnyMarkerInHeader(
        content,
        policy.ownership_markers ?? ['Layer ownership:', 'App ownership:'],
        Number(policy.ownership_header_scan_lines ?? 12),
      );
      if (!ok) {
        violations.push({
          type: 'missing_ownership_header',
          file,
          hint: 'Add "Layer ownership:" or "App ownership:" in the first 12 lines.',
        });
      }
    }

    if (startsWithAny(file, policy.authority_client_roots ?? [])) {
      const wrapperOk = hasAnyMarker(content, policy.wrapper_markers ?? []);
      if (!wrapperOk) {
        violations.push({
          type: 'authority_logic_in_client',
          file,
          hint: 'Authority paths in client/runtime/systems must remain thin wrappers.',
        });
      }
    }
  }

  const receipt = {
    ok: violations.length === 0,
    type: 'layer_placement_policy_check',
    policy: args.policyPath,
    base_ref: baseRef,
    changed_files: files.length,
    violations_count: violations.length,
    violations,
  };

  console.log(JSON.stringify(receipt, null, 2));
  if (violations.length > 0) process.exit(1);
}

run();
