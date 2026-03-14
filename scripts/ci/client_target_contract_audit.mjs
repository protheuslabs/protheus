#!/usr/bin/env node
/* eslint-disable no-console */
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

const ROOT = process.cwd();

function parseArgs(argv) {
  const out = {
    policy: 'client/runtime/config/client_target_contract_policy.json',
    scope: 'core/local/artifacts/client_scope_inventory_current.json',
    disposition: 'core/local/artifacts/client_surface_disposition_current.json',
    boundary: 'core/local/artifacts/client_layer_boundary_audit_current.json',
    out: 'core/local/artifacts/client_target_contract_audit_current.json',
    strict: false,
  };
  for (const arg of argv) {
    if (arg.startsWith('--policy=')) out.policy = arg.slice('--policy='.length);
    else if (arg.startsWith('--scope=')) out.scope = arg.slice('--scope='.length);
    else if (arg.startsWith('--disposition=')) out.disposition = arg.slice('--disposition='.length);
    else if (arg.startsWith('--boundary=')) out.boundary = arg.slice('--boundary='.length);
    else if (arg.startsWith('--out=')) out.out = arg.slice('--out='.length);
    else if (arg === '--strict') out.strict = true;
    else if (arg.startsWith('--strict=')) out.strict = ['1', 'true', 'yes', 'on'].includes(String(arg.slice('--strict='.length)).toLowerCase());
  }
  return out;
}

function rel(p) {
  return path.relative(ROOT, p).replace(/\\/g, '/');
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', '.git', 'dist', 'state'].includes(ent.name)) continue;
      walk(p, out);
    } else {
      out.push(p);
    }
  }
  return out;
}

function extOf(file) {
  return path.extname(file).toLowerCase().replace(/^\./, '') || '<none>';
}

function countBy(entries, keyFn) {
  const counts = {};
  for (const entry of entries) {
    const key = keyFn(entry);
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const policyPath = path.resolve(ROOT, args.policy);
  const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  const scope = JSON.parse(fs.readFileSync(path.resolve(ROOT, args.scope), 'utf8'));
  const disposition = JSON.parse(fs.readFileSync(path.resolve(ROOT, args.disposition), 'utf8'));
  const boundary = JSON.parse(fs.readFileSync(path.resolve(ROOT, args.boundary), 'utf8'));

  let revision = 'unknown';
  try {
    revision = execSync('git rev-parse HEAD', { cwd: ROOT, encoding: 'utf8' }).trim();
  } catch {}

  const clientFiles = walk(path.resolve(ROOT, 'client')).map(rel);
  const byExt = countBy(clientFiles, (file) => extOf(file));
  const hardViolations = [];
  const targetGaps = [];

  for (const ext of policy.hard_zero_exts || []) {
    const count = Number(byExt[ext] || 0);
    if (count > 0) {
      hardViolations.push({ reason: 'hard_zero_extension_present', ext, count });
    }
  }

  const dispositionFiles = new Set((disposition.entries || []).map((entry) => entry.file));
  for (const entry of scope.entries || []) {
    if (!dispositionFiles.has(entry.file)) {
      hardViolations.push({ reason: 'scope_file_missing_disposition', file: entry.file });
    }
  }

  const allowlist = policy.allowlist_decisions || {};
  for (const file of boundary.allowed_non_wrapper_paths || []) {
    if (!allowlist[file]) {
      hardViolations.push({ reason: 'allowlisted_non_wrapper_missing_decision', file });
    }
  }

  const caps = policy.target_caps || {};
  const scopeSummary = scope.summary || {};
  const byCategory = scopeSummary.by_category || {};
  const dispositionSummary = disposition.summary || {};
  const metrics = {
    total_ts_files: Number(scopeSummary.total_ts_files || 0),
    runtime_system_surface: Number(byCategory.runtime_system_surface || 0),
    cognition_surface: Number(byCategory.cognition_surface || 0),
    runtime_sdk_surface: Number(byCategory.runtime_sdk_surface || 0),
    sdk_surface: Number(byCategory.sdk_surface || 0),
    wrapper_count: Number(boundary.summary && boundary.summary.wrapper_count || 0),
    allowed_non_wrapper_count: Number(boundary.summary && boundary.summary.allowed_non_wrapper_count || 0),
    keep_public_client: Number(dispositionSummary.keep_public_client || 0),
    promote_to_core: Number(dispositionSummary.promote_to_core || 0),
    move_to_apps: Number(dispositionSummary.move_to_apps || 0),
    move_to_adapters: Number(dispositionSummary.move_to_adapters || 0),
    collapse_to_generic_wrapper: Number(dispositionSummary.collapse_to_generic_wrapper || 0),
  };

  for (const [metric, rule] of Object.entries(caps)) {
    const current = Number(metrics[metric] || 0);
    const target = Number(rule.target || 0);
    if (current > target) {
      targetGaps.push({ metric, current, target, reason: rule.reason || 'target_exceeded' });
    }
  }

  const payload = {
    type: 'client_target_contract_audit',
    generated_at: new Date().toISOString(),
    revision,
    policy_path: rel(policyPath),
    summary: {
      hard_violation_count: hardViolations.length,
      target_gap_count: targetGaps.length,
      pass: hardViolations.length === 0,
    },
    ext_counts: byExt,
    metrics,
    target_gaps: targetGaps,
    hard_violations: hardViolations,
  };

  const outPath = path.resolve(ROOT, args.out);
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, `${JSON.stringify(payload, null, 2)}\n`);
  console.log(JSON.stringify(payload, null, 2));
  if (args.strict && hardViolations.length > 0) process.exit(1);
}

main();
