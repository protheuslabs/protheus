#!/usr/bin/env node
/**
 * habit_crystallizer.js - deterministic habit scaffold generation from repeat triggers
 *
 * Purpose:
 * - Convert repeated manual work into a candidate habit scaffold
 * - Keep mutation inside habits layer (routines + registry + optional trust pin)
 * - Preserve system-level guardrails by using restrictive default permissions
 *
 * Triggers (ANY):
 * A) repeats_14d >= 3 AND tokens_est >= 500
 * B) tokens_est >= 2000
 * C) errors_30d >= 2
 *
 * Usage:
 *   node habits/scripts/habit_crystallizer.js --from "task text" [--tokens_est N] [--repeats_14d N] [--errors_30d N] [--intent_key key]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ROUTINES_DIR = path.join(REPO_ROOT, 'habits', 'routines');
const REGISTRY_PATH = path.join(REPO_ROOT, 'habits', 'registry.json');
const TRUSTED_HABITS_PATH = path.join(REPO_ROOT, 'config', 'trusted_habits.json');
const EVENTS_PATH = path.join(REPO_ROOT, 'state', 'autonomy', 'habit_crystallizer', 'events.jsonl');

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function nowIso() {
  return new Date().toISOString();
}

function parseArg(name, fallback = null) {
  const pref = `--${name}=`;
  const eq = process.argv.find(a => a.startsWith(pref));
  if (eq) return eq.slice(pref.length);
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && idx + 1 < process.argv.length) {
    const nxt = process.argv[idx + 1];
    if (!String(nxt).startsWith('--')) return nxt;
    return '';
  }
  return fallback;
}

function hasFlag(name) {
  return process.argv.includes(`--${name}`);
}

function normalizeIntent(text) {
  if (!text) return '';
  return String(text)
    .toLowerCase()
    .replace(/\b\d{4}-\d{2}-\d{2}\b/g, '')
    .replace(/\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b/g, '')
    .replace(/\d{4}-\d{2}-\d{2}t\d{2}:\d{2}:\d{2}(\.\d+)?(z|[+-]\d{2}:\d{2})?/g, '')
    .replace(/["'][^"']*["']/g, '<str>')
    .replace(/[^a-z0-9_\s-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/\s+/)
    .slice(0, 12)
    .join('_');
}

function safeSlug(text) {
  const base = normalizeIntent(text) || 'habit';
  const slug = base
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
  return slug || 'habit';
}

function usage() {
  console.log('Usage:');
  console.log('  node habits/scripts/habit_crystallizer.js --from "task text" [--tokens_est N] [--repeats_14d N] [--errors_30d N] [--intent_key key] [--auto_trust=0|1]');
  console.log('');
  console.log('Trigger thresholds (ANY):');
  console.log('  A) repeats_14d >= 3 AND tokens_est >= 500');
  console.log('  B) tokens_est >= 2000');
  console.log('  C) errors_30d >= 2');
  console.log('Default: auto_trust=0 (manual trust approval required).');
}

function loadJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2) + '\n', 'utf8');
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}

function computeHash(filePath) {
  const data = fs.readFileSync(filePath, 'utf8');
  return crypto.createHash('sha256').update(data).digest('hex');
}

function evaluateTriggers(tokensEst, repeats14d, errors30d) {
  const triggerA = repeats14d >= 3 && tokensEst >= 500;
  const triggerB = tokensEst >= 2000;
  const triggerC = errors30d >= 2;
  return {
    any: triggerA || triggerB || triggerC,
    which_met: [triggerA ? 'A' : null, triggerB ? 'B' : null, triggerC ? 'C' : null].filter(Boolean),
    thresholds: {
      A: { repeats_14d_min: 3, tokens_min: 500, met: triggerA },
      B: { tokens_min: 2000, met: triggerB },
      C: { errors_30d_min: 2, met: triggerC }
    }
  };
}

function defaultRegistry() {
  return {
    version: 1.5,
    max_active: 25,
    gc: {
      inactive_days: 30,
      min_uses_30d: 1
    },
    habits: []
  };
}

function routineTemplate(habitId, description) {
  const safeId = JSON.stringify(String(habitId));
  const safeDesc = JSON.stringify(String(description || ''));
  return `#!/usr/bin/env node
"use strict";

/**
 * Auto-generated habit scaffold.
 * Replace this body with the repeated workflow once validated.
 */
async function run(inputs = {}, ctx = {}) {
  const summary = {
    habit_id: ${safeId},
    description: ${safeDesc},
    action: "scaffold_noop",
    received_keys: Object.keys(inputs || {}).sort()
  };

  if (ctx && typeof ctx.log === "function") {
    ctx.log("scaffold run", summary);
  }

  return {
    status: "success",
    summary,
    violations: { format: 0, bloat: 0, registry: 0 }
  };
}

module.exports = { run };
`;
}

function addHabit(registry, params) {
  const now = nowIso();
  const habitId = params.habit_id;
  const entrypoint = `habits/routines/${habitId}.js`;
  const record = {
    id: habitId,
    name: params.name,
    description: params.description,
    created_at: now,
    last_used_at: null,
    uses_30d: 0,
    lifetime_uses: 0,
    success_rate: 0,
    avg_tokens_in: null,
    avg_tokens_out: null,
    estimated_tokens_saved: params.estimated_tokens_saved,
    rollback_plan: 'Revert generated routine + registry entry in one commit.',
    test_plan: `Run node habits/scripts/run_habit.js --id ${habitId} --json '{}' and verify stable output.`,
    idempotent: true,
    inputs_schema: {
      type: 'object',
      required: [],
      properties: {
        task: { type: 'string', description: 'Source task text' },
        intent_key: { type: 'string', description: 'Normalized intent key' },
        source: { type: 'string', description: 'Route source marker' },
        notes: { type: 'string', description: 'Optional free-form notes' }
      }
    },
    entrypoint,
    permissions: {
      network: 'deny',
      write_paths_allowlist: ['habits/logs/*'],
      exec_allowlist: []
    },
    status: 'candidate',
    outcome: {
      last_outcome_score: null,
      last_delta_value: null,
      outcome_unit: null
    },
    governance: {
      state: 'candidate',
      promote: {
        min_success_runs: 3,
        min_outcome_score: 0.7
      },
      demote: {
        max_consecutive_errors: 2,
        min_outcome_score: 0.4,
        cooldown_minutes: 1440
      },
      pinned: false,
      consecutive_errors: 0
    },
    metrics: {
      baseline: {
        avg_duration_ms: null,
        avg_tokens_est: null,
        avg_error_rate: null
      },
      rolling: {
        avg_duration_ms_30d: null,
        avg_tokens_est_30d: null,
        error_rate_30d: null,
        window_runs: []
      }
    }
  };
  registry.habits.push(record);
  return record;
}

function ensureTrustedDefaults() {
  return {
    allowlist_roots: [path.resolve(ROUTINES_DIR)],
    trusted_files: {},
    break_glass: { enabled: false }
  };
}

function autoTrustRoutine(routinePathAbs, enabled) {
  if (!enabled) return { enabled: false, trusted: false, reason: 'disabled' };

  const trusted = loadJson(TRUSTED_HABITS_PATH, ensureTrustedDefaults()) || ensureTrustedDefaults();
  if (!Array.isArray(trusted.allowlist_roots)) trusted.allowlist_roots = [];
  if (!trusted.trusted_files || typeof trusted.trusted_files !== 'object') trusted.trusted_files = {};

  const routinesRoot = path.resolve(ROUTINES_DIR);
  if (!trusted.allowlist_roots.includes(routinesRoot)) {
    trusted.allowlist_roots.push(routinesRoot);
  }

  const sha = computeHash(routinePathAbs);
  trusted.trusted_files[routinePathAbs] = {
    sha256: sha,
    approved_by: 'habit_crystallizer',
    approved_at: nowIso().slice(0, 10),
    note: 'Auto-trusted deterministic scaffold'
  };

  saveJson(TRUSTED_HABITS_PATH, trusted);
  return { enabled: true, trusted: true, sha256: sha };
}

function main() {
  const args = process.argv.slice(2);
  if (!args.length || hasFlag('help') || process.argv.includes('help') || process.argv.includes('-h')) {
    usage();
    process.exit(0);
  }

  const from = String(parseArg('from', '') || '').trim();
  if (!from) {
    usage();
    process.exit(2);
  }

  const tokensEst = Number(parseArg('tokens_est', '0')) || 0;
  const repeats14d = Number(parseArg('repeats_14d', '0')) || 0;
  const errors30d = Number(parseArg('errors_30d', '0')) || 0;
  const intentKey = String(parseArg('intent_key', '') || normalizeIntent(from));
  const autoTrustEnabled = String(parseArg('auto_trust', process.env.HABIT_CRYSTALLIZER_AUTO_TRUST || '0')) !== '0';

  const triggers = evaluateTriggers(tokensEst, repeats14d, errors30d);
  const habitId = safeSlug(intentKey || from);

  if (!triggers.any) {
    const out = {
      ok: true,
      decision: 'NO_PROPOSAL',
      habit_id: habitId,
      intent_key: intentKey,
      triggers
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    appendJsonl(EVENTS_PATH, { ts: nowIso(), type: 'crystallize_skip', reason: 'thresholds_not_met', ...out });
    process.exit(0);
  }

  const registry = loadJson(REGISTRY_PATH, defaultRegistry()) || defaultRegistry();
  if (!Array.isArray(registry.habits)) registry.habits = [];

  const existing = registry.habits.find(h => String(h && h.id) === habitId);
  if (existing) {
    const out = {
      ok: true,
      decision: 'EXISTS',
      habit_id: habitId,
      state: (existing.governance && existing.governance.state) || existing.status || 'unknown',
      entrypoint: existing.entrypoint || null,
      triggers
    };
    process.stdout.write(JSON.stringify(out) + '\n');
    appendJsonl(EVENTS_PATH, { ts: nowIso(), type: 'crystallize_exists', ...out });
    process.exit(0);
  }

  ensureDir(ROUTINES_DIR);
  const routinePathAbs = path.join(ROUTINES_DIR, `${habitId}.js`);
  if (!fs.existsSync(routinePathAbs)) {
    fs.writeFileSync(routinePathAbs, routineTemplate(habitId, from), 'utf8');
  }

  const habit = addHabit(registry, {
    habit_id: habitId,
    name: from.slice(0, 80),
    description: `Auto-crystallized from repeated task: ${from.slice(0, 160)}`,
    estimated_tokens_saved: Math.max(0, Math.round(tokensEst * 0.5))
  });
  saveJson(REGISTRY_PATH, registry);

  const trust = autoTrustRoutine(routinePathAbs, autoTrustEnabled);
  const out = {
    ok: true,
    decision: 'CREATED_CANDIDATE',
    habit_id: habit.id,
    state: habit.governance.state,
    entrypoint: habit.entrypoint,
    auto_trust: trust,
    triggers
  };

  appendJsonl(EVENTS_PATH, { ts: nowIso(), type: 'crystallize_created', ...out });
  process.stdout.write(JSON.stringify(out) + '\n');
}

if (require.main === module) main();
