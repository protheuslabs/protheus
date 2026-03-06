#!/usr/bin/env node
'use strict';
export {};

/**
 * systems/spine/spine_safe_launcher.js
 *
 * Purpose:
 * - Run pre-spine integrity reseal status check (check-only by default).
 * - Optionally prompt/apply reseal with explicit operator approval.
 * - Neutralize risky env toggles so guard gate does not hard-block spine runs.
 *
 * Usage:
 *   node systems/spine/spine_safe_launcher.js run [daily|eyes] [YYYY-MM-DD] [--max-eyes=N]
 *   node systems/spine/spine_safe_launcher.js daily [YYYY-MM-DD] [--max-eyes=N]
 *   node systems/spine/spine_safe_launcher.js eyes [YYYY-MM-DD] [--max-eyes=N]
 *   node systems/spine/spine_safe_launcher.js status
 *   node systems/spine/spine_safe_launcher.js --help
 *
 * Flags:
 *   --apply-reseal=1|0      Apply reseal automatically when required (default: 0)
 *   --prompt-reseal=1|0     Prompt operator for reseal when required (default: 0)
 *   --approval-note="..."   Approval note used for reseal apply
 *   --allow-risky-env=1|0   Keep risky env toggles (default: 0 = neutralize)
 */

const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

function repoRoot() {
  if (process.env.OPENCLAW_WORKSPACE) return path.resolve(process.env.OPENCLAW_WORKSPACE);
  return path.resolve(__dirname, '..', '..');
}

const ROOT = repoRoot();

const RISKY_ENV_TOGGLE_RULES = [
  { key: 'AUTONOMY_ENABLED', mode: 'truthy' },
  { key: 'AUTONOMY_MODEL_CATALOG_AUTO_APPLY', mode: 'truthy' },
  { key: 'AUTONOMY_MODEL_CATALOG_AUTO_BREAK_GLASS', mode: 'truthy' },
  { key: 'REMOTE_DIRECT_OVERRIDE', mode: 'truthy' },
  { key: 'BREAK_GLASS', mode: 'truthy' },
  { key: 'ALLOW_MISSING_DIRECTIVES', mode: 'bool' },
  { key: 'ALLOW_WEAK_T1_DIRECTIVES', mode: 'bool' }
];

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 30).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
      continue;
    }
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/spine/spine_safe_launcher.js run [daily|eyes] [YYYY-MM-DD] [--max-eyes=N]');
  console.log('  node systems/spine/spine_safe_launcher.js daily [YYYY-MM-DD] [--max-eyes=N]');
  console.log('  node systems/spine/spine_safe_launcher.js eyes [YYYY-MM-DD] [--max-eyes=N]');
  console.log('  node systems/spine/spine_safe_launcher.js status');
  console.log('  node systems/spine/spine_safe_launcher.js --help');
}

function todayOr(dateStr: string | null) {
  const token = cleanText(dateStr || '', 20);
  if (/^\d{4}-\d{2}-\d{2}$/.test(token)) return token;
  return new Date().toISOString().slice(0, 10);
}

function normalizeMode(v: unknown) {
  const token = normalizeToken(v, 32);
  if (token === 'eyes') return 'eyes';
  return 'daily';
}

function resolveRunPlan(args: Record<string, any>) {
  const cmd = normalizeToken(args._[0] || 'run', 32) || 'run';
  if (cmd === 'status') {
    return {
      command: 'status',
      mode: normalizeMode(args.mode || 'daily'),
      date: todayOr(args.date || null),
      maxEyes: cleanText(args['max-eyes'] || args.max_eyes || '', 16)
    };
  }
  if (cmd === 'daily' || cmd === 'eyes') {
    return {
      command: 'run',
      mode: cmd,
      date: todayOr(args._[1] || args.date || null),
      maxEyes: cleanText(args['max-eyes'] || args.max_eyes || '', 16)
    };
  }
  return {
    command: 'run',
    mode: normalizeMode(args._[1] || args.mode || 'daily'),
    date: todayOr(args._[2] || args.date || null),
    maxEyes: cleanText(args['max-eyes'] || args.max_eyes || '', 16)
  };
}

function parseJsonLines(stdout: string) {
  const raw = String(stdout || '').trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const lines = String(stdout || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      return JSON.parse(lines[i]);
    } catch {}
  }
  return null;
}

function runNodeJson(scriptRelPath: string, scriptArgs: string[]) {
  const r = spawnSync('node', [scriptRelPath, ...scriptArgs], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  return {
    ok: r.status === 0,
    status: Number.isFinite(r.status) ? Number(r.status) : 1,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJsonLines(String(r.stdout || ''))
  };
}

function isTruthyEnv(v: unknown) {
  const token = cleanText(v, 20).toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(token);
}

function isBoolTrueEnv(v: unknown) {
  const token = cleanText(v, 20).toLowerCase();
  return token === '1' || token === 'true';
}

function collectActiveRiskyToggles(env: Record<string, string | undefined>) {
  const active: string[] = [];
  for (const rule of RISKY_ENV_TOGGLE_RULES) {
    const raw = env[rule.key];
    if (!cleanText(raw, 40)) continue;
    if (rule.mode === 'truthy' && isTruthyEnv(raw)) {
      active.push(rule.key);
      continue;
    }
    if (rule.mode === 'bool' && isBoolTrueEnv(raw)) {
      active.push(rule.key);
    }
  }
  return active;
}

function sanitizeEnvForSpine(env: Record<string, string | undefined>, allowRiskyEnv: boolean) {
  const childEnv = { ...env };
  const active = collectActiveRiskyToggles(env);
  const neutralized: string[] = [];
  if (!allowRiskyEnv) {
    for (const key of active) {
      if (Object.prototype.hasOwnProperty.call(childEnv, key)) {
        delete childEnv[key];
        neutralized.push(key);
      }
    }
  }
  return { childEnv, active, neutralized };
}

function promptYesNo(question: string) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return null;
  try {
    process.stdout.write(question);
    const buf = Buffer.alloc(1024);
    const bytes = fs.readSync(0, buf, 0, buf.length, null);
    if (!bytes) return false;
    const answer = buf.toString('utf8', 0, bytes).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } catch {
    return null;
  }
}

function buildResealApplyNote(args: Record<string, any>, statusPayload: any) {
  const explicit = cleanText(args['approval-note'] || args.approval_note || args.note || '', 300);
  if (explicit) return explicit;
  const count = Number(
    statusPayload
    && statusPayload.check
    && statusPayload.check.violation_counts
    && statusPayload.check.violation_counts.unsealed_file
    || 0
  );
  return `Operator-approved env_toggle-safe spine reseal preflight (unsealed=${count}) ${nowIso()}`;
}

function runIntegrityPrecheck(args: Record<string, any>) {
  const status = runNodeJson('systems/security/integrity_reseal_assistant.js', ['status']);
  if (!status.ok || !status.payload || typeof status.payload !== 'object') {
    return {
      ok: false,
      blocked: true,
      reason: 'integrity_reseal_status_unavailable',
      status_code: status.status,
      status_stdout: cleanText(status.stdout, 500),
      status_stderr: cleanText(status.stderr, 500)
    };
  }
  const resealRequired = status.payload.reseal_required === true;
  if (!resealRequired) {
    return {
      ok: true,
      reseal_required: false,
      status: status.payload,
      applied: false
    };
  }

  let shouldApply = toBool(args['apply-reseal'], false);
  let promptOutcome: string | null = null;
  if (!shouldApply && toBool(args['prompt-reseal'], false)) {
    const answer = promptYesNo('Integrity reseal required before spine run. Apply reseal now? [y/N] ');
    if (answer === null) promptOutcome = 'prompt_unavailable';
    else if (answer === true) {
      shouldApply = true;
      promptOutcome = 'approved';
    } else {
      promptOutcome = 'declined';
    }
    process.stdout.write('\n');
  }

  if (!shouldApply) {
    return {
      ok: false,
      blocked: true,
      reason: 'integrity_reseal_required',
      reseal_required: true,
      prompt_outcome: promptOutcome,
      status: status.payload
    };
  }

  const note = buildResealApplyNote(args, status.payload);
  const apply = runNodeJson('systems/security/integrity_reseal_assistant.js', [
    'run',
    '--apply=1',
    '--strict=1',
    `--note=${note}`
  ]);
  if (!apply.ok || !apply.payload || apply.payload.ok !== true) {
    return {
      ok: false,
      blocked: true,
      reason: 'integrity_reseal_apply_failed',
      reseal_required: true,
      status: status.payload,
      apply_status_code: apply.status,
      apply_payload: apply.payload || null,
      apply_stderr: cleanText(apply.stderr, 500)
    };
  }
  return {
    ok: true,
    reseal_required: true,
    status: status.payload,
    applied: true,
    apply: apply.payload
  };
}

function runSpine(plan: { mode: string, date: string, maxEyes: string }, env: Record<string, string | undefined>) {
  const args = ['systems/spine/spine.js', plan.mode, plan.date];
  if (cleanText(plan.maxEyes, 20)) args.push(`--max-eyes=${plan.maxEyes}`);
  const r = spawnSync('node', args, {
    cwd: ROOT,
    stdio: 'inherit',
    env
  });
  return Number.isFinite(r.status) ? Number(r.status) : 1;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'run', 32) || 'run';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }

  const plan = resolveRunPlan(args);
  const allowRiskyEnv = toBool(args['allow-risky-env'], false);
  const { childEnv, active, neutralized } = sanitizeEnvForSpine(process.env as any, allowRiskyEnv);
  const precheck = runIntegrityPrecheck(args);
  if (!precheck.ok) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      blocked: true,
      type: 'spine_safe_launcher',
      ts: nowIso(),
      command: plan.command,
      mode: plan.mode,
      date: plan.date,
      reason: precheck.reason,
      reseal_required: precheck.reseal_required === true,
      active_risky_toggles: active,
      neutralized_risky_toggles: neutralized,
      hint: 'Run with --apply-reseal=1 or --prompt-reseal=1 to proceed.',
      precheck
    })}\n`);
    process.exit(2);
  }

  const statusPayload = {
    ok: true,
    type: 'spine_safe_launcher',
    ts: nowIso(),
    command: plan.command,
    mode: plan.mode,
    date: plan.date,
    reseal_required: precheck.reseal_required === true,
    reseal_applied: precheck.applied === true,
    allow_risky_env: allowRiskyEnv,
    active_risky_toggles: active,
    neutralized_risky_toggles: neutralized
  };

  if (plan.command === 'status') {
    process.stdout.write(`${JSON.stringify(statusPayload, null, 2)}\n`);
    process.exit(0);
  }

  process.stdout.write(`${JSON.stringify(statusPayload)}\n`);
  const code = runSpine(plan, childEnv);
  process.exit(code);
}

if (require.main === module) {
  main();
}

module.exports = {
  runIntegrityPrecheck,
  sanitizeEnvForSpine,
  resolveRunPlan
};
