#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const out = {
    apply: false,
    policy: 'client/runtime/config/empty_fort_pulse_policy.json',
    audit: 'client/local/artifacts/empty-fort/pulse_audit.json',
    actor: process.env.GITHUB_ACTOR || 'local',
    now: new Date().toISOString()
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--apply=1' || token === '--apply') out.apply = true;
    else if (token.startsWith('--policy=')) out.policy = token.slice('--policy='.length);
    else if (token.startsWith('--audit=')) out.audit = token.slice('--audit='.length);
    else if (token.startsWith('--actor=')) out.actor = token.slice('--actor='.length);
    else if (token.startsWith('--now=')) out.now = token.slice('--now='.length);
  }
  return out;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readJsonMaybe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function main() {
  const args = parseArgs(process.argv);
  const policyPath = path.resolve(args.policy);
  const auditPath = path.resolve(args.audit);
  const policy = readJsonMaybe(policyPath, null);
  if (!policy) {
    throw new Error(`missing policy: ${policyPath}`);
  }

  const now = new Date(args.now);
  if (Number.isNaN(now.getTime())) {
    throw new Error(`invalid --now value: ${args.now}`);
  }
  const day = now.toISOString().slice(0, 10);

  const existing = readJsonMaybe(auditPath, { history: [] });
  const todays = (existing.history || []).filter((e) => e.day === day && e.apply === true);
  const maxPerDay = Number(policy.max_prs_per_day || 1);

  const result = {
    ok: true,
    day,
    apply: args.apply,
    actor: args.actor,
    service_account: policy.service_account,
    max_prs_per_day: maxPerDay,
    applied_count_today: todays.length,
    allowed: true,
    reason: 'scheduled'
  };

  if (args.apply) {
    if (!policy.allow_apply) {
      result.allowed = false;
      result.reason = 'policy_disables_apply';
    } else if (args.actor !== policy.service_account) {
      result.allowed = false;
      result.reason = 'actor_not_service_account';
    } else if (todays.length >= maxPerDay) {
      result.allowed = false;
      result.reason = 'daily_cap_reached';
    }

    if (!result.allowed) {
      throw new Error(`pulse apply denied: ${result.reason}`);
    }

    const targetFile = path.resolve(policy.target_file || 'docs/client/ops/empty_fort_pulse_log.md');
    ensureDir(targetFile);
    const line = `- ${now.toISOString()} | actor=${args.actor} | labels=${(policy.labels || []).join(',')}\n`;
    fs.appendFileSync(targetFile, fs.existsSync(targetFile) ? line : `# Empty Fort Pulse Log\n\n${line}`);
  }

  const entry = {
    ts: now.toISOString(),
    day,
    apply: args.apply,
    actor: args.actor,
    allowed: result.allowed,
    reason: result.reason,
    max_prs_per_day: maxPerDay,
    labels: policy.labels || []
  };

  const nextAudit = {
    history: [...(existing.history || []), entry].slice(-2000)
  };

  ensureDir(auditPath);
  fs.writeFileSync(auditPath, JSON.stringify(nextAudit, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  }
}
