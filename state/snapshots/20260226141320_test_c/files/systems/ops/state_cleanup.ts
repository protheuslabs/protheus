#!/usr/bin/env node
'use strict';

/**
 * state_cleanup.js - deterministic stale runtime-state cleanup helper.
 *
 * Default mode is dry-run (non-destructive). Use --apply to delete.
 *
 * Usage:
 *   node systems/ops/state_cleanup.js run [--profile=<id>] [--max-delete=N] [--apply] [--dry-run]
 *   node systems/ops/state_cleanup.js profiles
 *   node systems/ops/state_cleanup.js --help
 *
 * Env overrides (for tests/advanced ops):
 *   STATE_CLEANUP_ROOT=<workspace_root>
 *   STATE_CLEANUP_POLICY=<policy_path>
 *   STATE_CLEANUP_SKIP_GIT=1
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(process.env.STATE_CLEANUP_ROOT || path.join(__dirname, '..', '..'));
const POLICY_PATH = path.resolve(process.env.STATE_CLEANUP_POLICY || path.join(ROOT, 'config', 'state_cleanup_policy.json'));

function usage() {
  console.log('state_cleanup.js - stale runtime-state cleanup (dry-run by default)');
  console.log('');
  console.log('Commands:');
  console.log('  run [--profile=<id>] [--max-delete=N] [--apply] [--dry-run]');
  console.log('  profiles');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (!arg.startsWith('--')) {
      out._.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq === -1) {
      out[arg.slice(2)] = true;
    } else {
      out[arg.slice(2, eq)] = arg.slice(eq + 1);
    }
  }
  return out;
}

function normalizeRelPath(p) {
  const rel = String(p || '').trim().replace(/\\/g, '/').replace(/^\/+/, '');
  if (!rel) return '';
  if (rel === '.' || rel.includes('..') || path.isAbsolute(rel)) {
    throw new Error(`invalid cleanup policy path: ${p}`);
  }
  return rel;
}

function asSuffixArray(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x || '').trim()).filter(Boolean);
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function loadPolicy(profileId) {
  const raw = readJsonSafe(POLICY_PATH, {});
  const profiles = raw && typeof raw.profiles === 'object' ? raw.profiles : {};
  const id = String(profileId || raw.default_profile || 'runtime_churn').trim();
  const profile = profiles[id];
  if (!profile || typeof profile !== 'object') {
    throw new Error(`cleanup profile not found: ${id}`);
  }
  const rulesRaw = Array.isArray(profile.rules) ? profile.rules : [];
  if (!rulesRaw.length) {
    throw new Error(`cleanup profile has no rules: ${id}`);
  }
  const rules = rulesRaw.map((rule, idx) => {
    const rel = normalizeRelPath(rule && rule.path);
    const maxAge = Number(rule && rule.max_age_hours);
    if (!rel) throw new Error(`invalid rule path at index ${idx}`);
    if (!Number.isFinite(maxAge) || maxAge <= 0) {
      throw new Error(`invalid max_age_hours for rule ${rel}`);
    }
    return {
      path: rel,
      max_age_hours: maxAge,
      suffixes: asSuffixArray(rule && rule.suffixes)
    };
  });
  const maxDelete = Number(profile.max_delete_per_run);
  return {
    id,
    rules,
    max_delete_per_run: Number.isFinite(maxDelete) && maxDelete > 0 ? Math.round(maxDelete) : 200
  };
}

function loadTrackedSet() {
  if (String(process.env.STATE_CLEANUP_SKIP_GIT || '') === '1') return null;
  const r = spawnSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' });
  if (r.status !== 0) return null;
  const set = new Set();
  const lines = String(r.stdout || '').split('\n');
  for (const line of lines) {
    const rel = String(line || '').trim();
    if (rel) set.add(rel.replace(/\\/g, '/'));
  }
  return set;
}

function relPath(absPath) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function isInsideRoot(absPath) {
  const rel = relPath(absPath);
  return !!rel && !rel.startsWith('../') && !path.isAbsolute(rel);
}

function walkFiles(absDir) {
  const out = [];
  const stack = [absDir];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(cur, ent.name);
      if (ent.isDirectory()) {
        stack.push(full);
      } else if (ent.isFile()) {
        out.push(full);
      }
    }
  }
  return out;
}

function suffixAllowed(rel, suffixes) {
  if (!Array.isArray(suffixes) || suffixes.length === 0) return true;
  return suffixes.some((s) => rel.endsWith(String(s)));
}

function ageHours(nowMs, mtimeMs) {
  return Math.max(0, (nowMs - mtimeMs) / (1000 * 60 * 60));
}

function collectCandidates(profile, nowMs, trackedSet) {
  const all = [];
  const byRule = [];
  let protectedTracked = 0;

  for (const rule of profile.rules) {
    const abs = path.join(ROOT, rule.path);
    const stat = fs.existsSync(abs) ? fs.statSync(abs) : null;
    const ruleSummary = {
      path: rule.path,
      max_age_hours: rule.max_age_hours,
      suffixes: rule.suffixes.slice(0),
      scanned_files: 0,
      candidates: 0,
      protected_tracked: 0,
      missing: !stat
    };
    if (!stat) {
      byRule.push(ruleSummary);
      continue;
    }

    const files = stat.isFile() ? [abs] : stat.isDirectory() ? walkFiles(abs) : [];
    for (const filePath of files) {
      if (!isInsideRoot(filePath)) continue;
      const rel = relPath(filePath);
      ruleSummary.scanned_files += 1;
      if (!suffixAllowed(rel, rule.suffixes)) continue;
      let st = null;
      try {
        st = fs.statSync(filePath);
      } catch {
        continue;
      }
      const age = ageHours(nowMs, st.mtimeMs);
      if (age < rule.max_age_hours) continue;
      if (trackedSet && trackedSet.has(rel)) {
        protectedTracked += 1;
        ruleSummary.protected_tracked += 1;
        continue;
      }
      ruleSummary.candidates += 1;
      all.push({
        rel,
        abs: filePath,
        size_bytes: Number(st.size || 0),
        age_hours: Number(age.toFixed(3)),
        rule_path: rule.path,
        max_age_hours: rule.max_age_hours
      });
    }
    byRule.push(ruleSummary);
  }

  all.sort((a, b) => a.rel.localeCompare(b.rel));
  return { candidates: all, by_rule: byRule, protected_tracked: protectedTracked };
}

function cmdRun(args) {
  const profile = loadPolicy(args.profile);
  const explicitDryRun = args['dry-run'] === true || args.dry_run === true;
  const apply = args.apply === true && !explicitDryRun;
  const dryRun = !apply;
  const maxDeleteArg = Number(args['max-delete']);
  const maxDelete = Number.isFinite(maxDeleteArg) && maxDeleteArg > 0
    ? Math.round(maxDeleteArg)
    : profile.max_delete_per_run;
  const nowMs = Date.now();
  const trackedSet = loadTrackedSet();
  const scan = collectCandidates(profile, nowMs, trackedSet);
  const selected = scan.candidates.slice(0, Math.max(1, maxDelete));
  let deleted = 0;

  if (!dryRun) {
    for (const item of selected) {
      try {
        fs.rmSync(item.abs, { force: true });
        deleted += 1;
      } catch {
        // deterministic best effort; errors surfaced via deleted count mismatch.
      }
    }
  }

  const payload = {
    ok: true,
    type: 'state_cleanup_run',
    ts: new Date().toISOString(),
    root: ROOT,
    policy_path: POLICY_PATH,
    profile: profile.id,
    dry_run: dryRun,
    apply_requested: args.apply === true,
    limits: {
      max_delete_per_run: maxDelete,
      truncated: scan.candidates.length > selected.length
    },
    totals: {
      rule_count: profile.rules.length,
      candidates: scan.candidates.length,
      selected: selected.length,
      deleted,
      protected_tracked: scan.protected_tracked
    },
    by_rule: scan.by_rule,
    sample: selected.slice(0, 50).map((x) => ({
      path: x.rel,
      age_hours: x.age_hours,
      size_bytes: x.size_bytes,
      rule_path: x.rule_path,
      max_age_hours: x.max_age_hours
    }))
  };

  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function cmdProfiles(args) {
  const raw = readJsonSafe(POLICY_PATH, {});
  const profiles = raw && typeof raw.profiles === 'object' ? raw.profiles : {};
  const out = {
    ok: true,
    type: 'state_cleanup_profiles',
    policy_path: POLICY_PATH,
    default_profile: String(raw.default_profile || ''),
    profiles: Object.keys(profiles).sort().map((id) => {
      const p = profiles[id] || {};
      return {
        id,
        description: String(p.description || ''),
        rule_count: Array.isArray(p.rules) ? p.rules.length : 0,
        max_delete_per_run: Number(p.max_delete_per_run || 0) || 0
      };
    })
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '');
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') {
    usage();
    return;
  }
  if (cmd === 'run') {
    cmdRun(args);
    return;
  }
  if (cmd === 'profiles') {
    cmdProfiles(args);
    return;
  }
  console.error(`Unknown command: ${cmd}`);
  process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`${String(err && err.message || err || 'state_cleanup_failed')}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  collectCandidates,
  loadTrackedSet,
  parseArgs
};
export {};
