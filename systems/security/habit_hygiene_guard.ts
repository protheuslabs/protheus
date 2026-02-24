#!/usr/bin/env node
'use strict';

/**
 * habit_hygiene_guard.js
 *
 * Purpose:
 * - Prevent habits from becoming a dump for arbitrary scripts.
 * - Enforce that routines are registry-backed and provenance-tagged.
 *
 * Usage:
 *   node systems/security/habit_hygiene_guard.js run [--strict]
 *   node systems/security/habit_hygiene_guard.js --help
 */

const fs = require('fs');
const path = require('path');
const { isAlnum } = require('../../lib/uid');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const REGISTRY_PATH = process.env.HABIT_HYGIENE_REGISTRY_PATH
  ? path.resolve(process.env.HABIT_HYGIENE_REGISTRY_PATH)
  : path.join(REPO_ROOT, 'habits', 'registry.json');
const ROUTINES_DIR = process.env.HABIT_HYGIENE_ROUTINES_DIR
  ? path.resolve(process.env.HABIT_HYGIENE_ROUTINES_DIR)
  : path.join(REPO_ROOT, 'habits', 'routines');
const FORBIDDEN_EYES_COLLECTORS_DIR = process.env.HABIT_HYGIENE_FORBIDDEN_EYES_COLLECTORS_DIR
  ? path.resolve(process.env.HABIT_HYGIENE_FORBIDDEN_EYES_COLLECTORS_DIR)
  : path.join(REPO_ROOT, 'habits', 'scripts', 'eyes_collectors');

const ALLOWED_PROVENANCE_SOURCES = new Set([
  'repeat_trigger',
  'manual_proposal',
  'migration'
]);

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/habit_hygiene_guard.js run [--strict]');
  console.log('  node systems/security/habit_hygiene_guard.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const arg of argv) {
    if (arg === '--strict') out.strict = true;
    else if (!arg.startsWith('--')) out._.push(arg);
    else if (arg === '--help' || arg === '-h') out.help = true;
  }
  return out;
}

function safeReadJson(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeRel(p) {
  return String(p || '').replace(/\\/g, '/');
}

function absEntrypoint(entrypoint) {
  const raw = String(entrypoint || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return path.resolve(raw);
  const norm = normalizeRel(raw);
  if (norm.startsWith('habits/routines/')) {
    const rel = norm.slice('habits/routines/'.length);
    return path.resolve(ROUTINES_DIR, rel);
  }
  return path.resolve(REPO_ROOT, norm);
}

function displayPath(absPath) {
  const abs = String(absPath || '');
  if (!abs) return null;
  const rel = normalizeRel(path.relative(REPO_ROOT, abs));
  return rel.startsWith('..') ? abs : rel;
}

function listRoutineFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs.readdirSync(dirPath)
    .filter((f) => f.endsWith('.js'))
    .sort((a, b) => a.localeCompare(b))
    .map((f) => path.join(dirPath, f));
}

function listJsFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const out = [];
  for (const e of entries) {
    const abs = path.join(dirPath, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) {
      out.push(...listJsFiles(abs));
      continue;
    }
    if (e.isFile() && e.name.endsWith('.js')) out.push(abs);
  }
  return out.sort((a, b) => a.localeCompare(b));
}

function evaluate() {
  const violations = [];
  const warnings = [];

  const registry = safeReadJson(REGISTRY_PATH, null);
  if (!registry || !Array.isArray(registry.habits)) {
    violations.push({
      type: 'registry_invalid',
      path: REGISTRY_PATH,
      reason: 'registry_missing_or_invalid'
    });
    return { ok: false, violations, warnings, checked: { habits: 0, routines: 0 } };
  }

  const routines = listRoutineFiles(ROUTINES_DIR);
  const routineAbsSet = new Set(routines.map((abs) => path.resolve(abs)));

  const byEntrypoint = new Map();
  const seenUids = new Set();
  for (const h of registry.habits) {
    const entry = absEntrypoint(h && h.entrypoint);
    if (!entry) continue;
    byEntrypoint.set(entry, h);
  }

  for (const h of registry.habits) {
    const habitId = String((h && h.id) || '');
    const state = String((h && h.governance && h.governance.state) || h.status || '').toLowerCase();
    const entryRel = normalizeRel(h && h.entrypoint);
    if (!habitId) {
      violations.push({ type: 'habit_missing_id', habit_id: null });
      continue;
    }
    const uid = String((h && h.uid) || '').trim();
    if (!uid) {
      violations.push({
        type: 'habit_missing_uid',
        habit_id: habitId
      });
    } else if (!isAlnum(uid)) {
      violations.push({
        type: 'habit_uid_not_alnum',
        habit_id: habitId,
        uid
      });
    } else if (seenUids.has(uid)) {
      violations.push({
        type: 'habit_uid_duplicate',
        habit_id: habitId,
        uid
      });
    } else {
      seenUids.add(uid);
    }
    if (!entryRel) {
      violations.push({
        type: 'habit_entrypoint_invalid',
        habit_id: habitId,
        entrypoint: entryRel || null
      });
      continue;
    }
    if (!path.isAbsolute(entryRel) && !entryRel.startsWith('habits/routines/')) {
      violations.push({
        type: 'habit_entrypoint_invalid',
        habit_id: habitId,
        entrypoint: entryRel || null
      });
      continue;
    }
    const entryAbs = absEntrypoint(entryRel);
    if (state !== 'archived' && !fs.existsSync(entryAbs)) {
      violations.push({
        type: 'habit_entrypoint_missing',
        habit_id: habitId,
        entrypoint: displayPath(entryAbs)
      });
    }

    const provenance = h && h.provenance && typeof h.provenance === 'object' ? h.provenance : null;
    if (!provenance) {
      warnings.push({
        type: 'habit_missing_provenance',
        habit_id: habitId
      });
      continue;
    }
    const source = String(provenance.source || '').trim();
    if (!ALLOWED_PROVENANCE_SOURCES.has(source)) {
      violations.push({
        type: 'habit_provenance_source_invalid',
        habit_id: habitId,
        source: source || null
      });
    }
    if (source === 'repeat_trigger') {
      const triggers = provenance.trigger_metrics && typeof provenance.trigger_metrics === 'object'
        ? provenance.trigger_metrics
        : null;
      const hasRepeatSignals = !!(
        triggers && (
          Number.isFinite(Number(triggers.repeats_14d)) ||
          Number.isFinite(Number(triggers.tokens_est)) ||
          Number.isFinite(Number(triggers.errors_30d))
        )
      );
      if (!hasRepeatSignals) {
        violations.push({
          type: 'habit_repeat_trigger_missing_metrics',
          habit_id: habitId
        });
      }
    }
  }

  for (const routineAbs of Array.from(routineAbsSet)) {
    if (!byEntrypoint.has(routineAbs)) {
      violations.push({
        type: 'orphan_routine_file',
        entrypoint: displayPath(routineAbs)
      });
    }
  }

  const misplacedCollectors = listJsFiles(FORBIDDEN_EYES_COLLECTORS_DIR);
  for (const abs of misplacedCollectors) {
    violations.push({
      type: 'forbidden_eyes_collector_path',
      entrypoint: displayPath(abs)
    });
  }

  return {
    ok: violations.length === 0,
    violations,
    warnings,
    checked: {
      habits: registry.habits.length,
      routines: routines.length
    }
  };
}

function summarizeCounts(items) {
  const out = {};
  for (const it of items || []) {
    const t = String((it && it.type) || 'unknown');
    out[t] = Number(out[t] || 0) + 1;
  }
  return out;
}

function run(strict = false) {
  const evalRes = evaluate();
  const summary = {
    ok: evalRes.ok && (!strict || (evalRes.warnings || []).length === 0),
    strict: strict === true,
    checked: evalRes.checked || { habits: 0, routines: 0 },
    violation_counts: summarizeCounts(evalRes.violations || []),
    warning_counts: summarizeCounts(evalRes.warnings || []),
    violations: evalRes.violations || [],
    warnings: evalRes.warnings || []
  };
  process.stdout.write(JSON.stringify(summary, null, 2) + '\n');
  if (!summary.ok) process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd !== 'run') {
    usage();
    process.exit(2);
  }
  run(args.strict === true);
}

if (require.main === module) {
  main();
}

module.exports = {
  evaluate
};
export {};
