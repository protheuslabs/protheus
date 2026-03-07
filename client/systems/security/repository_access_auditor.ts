#!/usr/bin/env node
'use strict';
export {};

/**
 * repository_access_auditor.js
 *
 * SEC-M01: repository visibility + collaborator access policy checks.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.REPOSITORY_ACCESS_POLICY_PATH
  ? path.resolve(String(process.env.REPOSITORY_ACCESS_POLICY_PATH))
  : path.join(ROOT, 'config', 'repository_access_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
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

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(absDir: string) {
  fs.mkdirSync(absDir, { recursive: true });
}

function readJson(absPath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(absPath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(absPath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(absPath: string, payload: AnyObj) {
  ensureDir(path.dirname(absPath));
  const tmpPath = `${absPath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, absPath);
}

function appendJsonl(absPath: string, row: AnyObj) {
  ensureDir(path.dirname(absPath));
  fs.appendFileSync(absPath, `${JSON.stringify(row)}\n`, 'utf8');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const token = cleanText(raw || fallbackRel, 360);
  return path.isAbsolute(token) ? path.resolve(token) : path.join(ROOT, token);
}

function rel(absPath: string) {
  return path.relative(ROOT, absPath).replace(/\\/g, '/');
}

function defaultPolicy() {
  return {
    schema_id: 'repository_access_policy',
    schema_version: '1.0',
    enabled: true,
    repo: {
      owner: 'jakerslam',
      name: 'protheus',
      visibility_expected: 'private'
    },
    least_privilege: {
      default_role: 'read',
      max_admins: 2,
      restricted_admin_users: ['jay'],
      allowed_roles: ['read', 'triage', 'write', 'maintain', 'admin']
    },
    review: {
      interval_days: 90,
      next_review_due: '2026-05-27',
      artifact_path: 'state/security/repo_access_review/latest.json',
      history_path: 'state/security/repo_access_review/history.jsonl'
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const raw = readJson(policyPath, {});
  const repo = raw.repo && typeof raw.repo === 'object' ? raw.repo : {};
  const least = raw.least_privilege && typeof raw.least_privilege === 'object' ? raw.least_privilege : {};
  const review = raw.review && typeof raw.review === 'object' ? raw.review : {};
  return {
    schema_id: 'repository_access_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: raw.enabled !== false,
    repo: {
      owner: normalizeToken(repo.owner || base.repo.owner, 120) || base.repo.owner,
      name: normalizeToken(repo.name || base.repo.name, 120) || base.repo.name,
      visibility_expected: normalizeToken(repo.visibility_expected || base.repo.visibility_expected, 40) || base.repo.visibility_expected
    },
    least_privilege: {
      default_role: normalizeToken(least.default_role || base.least_privilege.default_role, 40) || base.least_privilege.default_role,
      max_admins: clampInt(least.max_admins, 1, 100, base.least_privilege.max_admins),
      restricted_admin_users: Array.isArray(least.restricted_admin_users)
        ? least.restricted_admin_users.map((v: unknown) => normalizeToken(v, 120)).filter(Boolean).slice(0, 512)
        : base.least_privilege.restricted_admin_users.slice(0),
      allowed_roles: Array.isArray(least.allowed_roles)
        ? least.allowed_roles.map((v: unknown) => normalizeToken(v, 40)).filter(Boolean).slice(0, 32)
        : base.least_privilege.allowed_roles.slice(0)
    },
    review: {
      interval_days: clampInt(review.interval_days, 1, 365, base.review.interval_days),
      next_review_due: cleanText(review.next_review_due || base.review.next_review_due, 40) || base.review.next_review_due,
      artifact_path: resolvePath(review.artifact_path, base.review.artifact_path),
      history_path: resolvePath(review.history_path, base.review.history_path)
    },
    policy_path: path.resolve(policyPath)
  };
}

function runGh(args: string[]) {
  const timeoutMs = clampInt(process.env.REPO_ACCESS_AUDITOR_CMD_TIMEOUT_MS, 500, 60000, 5000);
  const proc = spawnSync('gh', args, {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs,
    env: {
      ...process.env,
      GH_PROMPT_DISABLED: '1',
      GH_PAGER: 'cat'
    }
  });
  return {
    ok: proc.status === 0,
    status: Number(proc.status || 0),
    stdout: String(proc.stdout || ''),
    stderr: String(proc.stderr || '')
  };
}

function queryRemote(policy: AnyObj, remoteEnabled = false) {
  if (!remoteEnabled) {
    return { mode: 'local_only', available: false, reason: 'remote_disabled_default' };
  }
  if (toBool(process.env.REPO_ACCESS_AUDITOR_SKIP_REMOTE, false)) {
    return { mode: 'local_only', available: false, reason: 'remote_skip_env' };
  }
  const probe = runGh(['--version']);
  if (!probe.ok) {
    return { mode: 'local_only', available: false, reason: 'gh_cli_unavailable' };
  }
  const repoSlug = `${policy.repo.owner}/${policy.repo.name}`;
  const repoInfo = runGh(['api', `repos/${repoSlug}`]);
  if (!repoInfo.ok) {
    return { mode: 'local_only', available: false, reason: 'repo_api_unavailable' };
  }
  let repoJson: AnyObj = {};
  try { repoJson = JSON.parse(repoInfo.stdout || '{}'); } catch {}
  const collab = runGh(['api', `repos/${repoSlug}/collaborators?affiliation=direct`]);
  let collaborators: AnyObj[] = [];
  if (collab.ok) {
    try {
      const parsed = JSON.parse(collab.stdout || '[]');
      collaborators = Array.isArray(parsed) ? parsed : [];
    } catch {}
  }
  return {
    mode: 'remote_live',
    available: true,
    repo: repoJson,
    collaborators
  };
}

function evaluatePolicy(policy: AnyObj, remote: AnyObj) {
  const checks: AnyObj[] = [];
  const add = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok: ok === true, detail: cleanText(detail, 260) });
  };
  add(
    'policy:enabled',
    policy.enabled === true,
    `enabled=${policy.enabled ? '1' : '0'}`
  );
  add(
    'policy:review_interval',
    Number(policy.review.interval_days || 0) >= 90,
    `interval_days=${Number(policy.review.interval_days || 0)}`
  );
  add(
    'policy:least_privilege_defaults',
    policy.least_privilege.default_role === 'read'
      && Array.isArray(policy.least_privilege.allowed_roles)
      && policy.least_privilege.allowed_roles.includes('admin')
      && policy.least_privilege.allowed_roles.includes('read'),
    `default_role=${policy.least_privilege.default_role} allowed_roles=${(policy.least_privilege.allowed_roles || []).join(',')}`
  );
  if (remote && remote.available) {
    const privateFlag = remote.repo && remote.repo.private === true;
    add(
      'remote:visibility_private',
      policy.repo.visibility_expected !== 'private' ? true : privateFlag,
      `expected=${policy.repo.visibility_expected} actual_private=${privateFlag ? '1' : '0'}`
    );
    const collaborators = Array.isArray(remote.collaborators) ? remote.collaborators : [];
    const adminUsers = collaborators
      .filter((row: AnyObj) => row && row.permissions && row.permissions.admin === true)
      .map((row: AnyObj) => normalizeToken(row.login || '', 120))
      .filter(Boolean);
    add(
      'remote:admin_count_cap',
      adminUsers.length <= Number(policy.least_privilege.max_admins || 2),
      `admins=${adminUsers.join(',') || 'none'} max_admins=${Number(policy.least_privilege.max_admins || 0)}`
    );
    const restricted = Array.isArray(policy.least_privilege.restricted_admin_users)
      ? policy.least_privilege.restricted_admin_users
      : [];
    const disallowedAdmins = adminUsers.filter((u: string) => restricted.length > 0 && !restricted.includes(u));
    add(
      'remote:restricted_admins',
      disallowedAdmins.length === 0,
      `disallowed_admins=${disallowedAdmins.join(',') || 'none'}`
    );
  } else {
    add('remote:availability', true, `mode=${remote && remote.mode ? remote.mode : 'unknown'} reason=${remote && remote.reason ? remote.reason : 'none'}`);
  }
  return checks;
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const strict = toBool(args.strict, false);
  const remote = queryRemote(policy, toBool(args.remote, false));
  const checks = evaluatePolicy(policy, remote);
  const ok = checks.every((row) => row.ok === true);
  const out = {
    ok,
    type: 'repository_access_auditor_status',
    ts: nowIso(),
    policy: {
      path: rel(policy.policy_path),
      repo: policy.repo,
      interval_days: policy.review.interval_days
    },
    remote_mode: remote && remote.mode ? remote.mode : 'unknown',
    checks
  };
  if (strict && !ok) process.exitCode = 1;
  return out;
}

function cmdReviewPlan(args: AnyObj) {
  const policy = loadPolicy(args.policy);
  const apply = toBool(args.apply, true);
  const now = new Date();
  const next = new Date(now.getTime() + Number(policy.review.interval_days || 90) * 24 * 3600 * 1000);
  const out = {
    ok: true,
    type: 'repository_access_review_plan',
    ts: nowIso(),
    applied: apply,
    repo: `${policy.repo.owner}/${policy.repo.name}`,
    review_interval_days: policy.review.interval_days,
    previous_due: policy.review.next_review_due,
    next_review_due: next.toISOString().slice(0, 10)
  };
  if (apply) {
    writeJsonAtomic(policy.review.artifact_path, out);
    appendJsonl(policy.review.history_path, out);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/repository_access_auditor.js status [--strict=1|0] [--remote=1|0]');
  console.log('  node systems/security/repository_access_auditor.js review-plan [--apply=1|0]');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || '', 40);
  let out: AnyObj;
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    return;
  }
  if (cmd === 'status') out = cmdStatus(args);
  else if (cmd === 'review-plan') out = cmdReviewPlan(args);
  else out = { ok: false, type: 'repository_access_auditor', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  const strictStatus = cmd === 'status' && toBool(args.strict, false);
  if (out && out.ok === false && (cmd !== 'status' || strictStatus)) process.exitCode = 1;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'repository_access_auditor',
      error: cleanText((err as AnyObj)?.message || err || 'repository_access_auditor_failed', 260)
    })}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  cmdStatus,
  cmdReviewPlan
};
