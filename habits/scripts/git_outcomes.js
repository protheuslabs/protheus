#!/usr/bin/env node
/**
 * git_outcomes.js v1.0
 * Deterministic "semi-auto outcomes" from git commits → proposal_queue outcomes JSONL.
 *
 * Goal:
 * - Remove manual `proposal_queue.js outcome ...` for common "shipped" cases.
 * - Preserve eye attribution deterministically via commit message tokens.
 *
 * Conventions (commit subject or body, but we parse subject by default):
 * - eye:<eye_id> (required for attribution; can appear multiple times)
 * - proposal:<proposal_id> (optional; can appear multiple times)
 * - outcome:shipped|reverted|no_change (optional; default shipped)
 *
 * Output:
 * - Appends outcome events into: state/queue/decisions/YYYY-MM-DD.jsonl
 * - Idempotent: will not re-add identical outcome events.
 *
 * Usage:
 * node habits/scripts/git_outcomes.js run [YYYY-MM-DD] [--repo=PATH] [--branch=main] [--outcome=shipped]
 * node habits/scripts/git_outcomes.js dry-run [YYYY-MM-DD] [--repo=PATH] [--branch=main] [--outcome=shipped]
 * node habits/scripts/git_outcomes.js help
 *
 * Notes:
 * - We intentionally keep `evidence_ref` strictly machine-parseable as ONLY "eye:<id>".
 * - Commit SHA / subject are stored in separate fields (evidence_commit, evidence_subject).
 * - If no proposal:<id> token exists, we generate a stable proposal_id = "GIT-<sha8>".
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Repo/workspace root defaults to current working directory
function repoRoot(p) {
  return p ? path.resolve(p) : process.cwd();
}

function getTodayUTC() {
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonlSafe(filePath) {
  const out = [];
  try {
    if (!fs.existsSync(filePath)) return out;
    const raw = fs.readFileSync(filePath, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    for (const line of lines) {
      try { out.push(JSON.parse(line)); } catch (_) { /* ignore */ }
    }
  } catch (_) {
    // ignore
  }
  return out;
}

function stableKeyForOutcomeEvent(e) {
  // Deterministic key for idempotence (do not include ts)
  const p = String(e.proposal_id ?? '');
  const o = String(e.outcome ?? '');
  const r = String(e.evidence_ref ?? '');
  const c = String(e.evidence_commit ?? '');
  return `${p}||${o}||${r}||${c}`;
}

function extractTokens(text) {
  // Parse tokens like: eye:moltbook_feed, proposal:EYE-abc..., outcome:shipped
  // We allow punctuation around tokens; stop at whitespace.
  const t = String(text || '');
  const eyes = [];
  const proposals = [];
  let outcome = null;

  const re = /\b(eye|proposal|outcome):([A-Za-z0-9_\-\.]+)\b/g;
  let m;
  while ((m = re.exec(t)) !== null) {
    const k = m[1];
    const v = m[2];
    if (k === 'eye') eyes.push(v);
    if (k === 'proposal') proposals.push(v);
    if (k === 'outcome') outcome = v;
  }
  return { eyes, proposals, outcome };
}

function parseGitLogLines(raw) {
  // Expected format: "<sha>\t<subject>"
  const commits = [];
  const lines = String(raw || '').split('\n').filter(Boolean);
  for (const line of lines) {
    const parts = line.split('\t');
    if (parts.length < 2) continue;
    const sha = parts[0].trim();
    const subject = parts.slice(1).join('\t').trim();
    if (!sha || !subject) continue;
    commits.push({ sha, subject });
  }
  return commits;
}

function gitLogForDate({ repo, branch, dateStr }) {
  const date = dateStr || getTodayUTC();
  // Use ISO-like boundaries; deterministic for that date in UTC
  const since = `${date}T00:00:00Z`;
  const until = `${date}T23:59:59Z`;

  // Format: sha<TAB>subject
  const cmd = [
    'git',
    '-C', repo,
    'log',
    branch || 'HEAD',
    `--since=${since}`,
    `--until=${until}`,
    '--pretty=format:%H%x09%s'
  ];

  try {
    return execSync(cmd.join(' '), { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    // If repo has no commits in range, git exits 0 with empty output.
    // But some setups may throw; treat as empty.
    return '';
  }
}

function buildOutcomeEventsFromCommits({ commits, defaultOutcome, dateStr }) {
  const date = dateStr || getTodayUTC();
  const events = [];

  for (const c of commits) {
    const toks = extractTokens(c.subject);
    const eyeIds = toks.eyes;
    if (!eyeIds || eyeIds.length === 0) continue; // Only record outcomes when we have attribution

    const outcome = toks.outcome || defaultOutcome || 'shipped';
    const proposalIds = toks.proposals && toks.proposals.length ? toks.proposals : [`GIT-${c.sha.slice(0, 8)}`];

    for (const eyeId of eyeIds) {
      for (const proposalId of proposalIds) {
        events.push({
          ts: new Date().toISOString(),
          type: 'outcome',
          date,
          proposal_id: proposalId,
          outcome,
          // IMPORTANT: machine-parseable first token ONLY
          evidence_ref: `eye:${eyeId}`,
          // Extra evidence fields (safe, deterministic data)
          evidence_commit: c.sha,
          evidence_subject: c.subject
        });
      }
    }
  }

  return events;
}

function appendOutcomesIdempotent({ repo, dateStr, newEvents, dryRun }) {
  const date = dateStr || getTodayUTC();
  const decisionsDir = path.join(repo, 'state', 'queue', 'decisions');
  ensureDir(decisionsDir);
  const decisionsPath = path.join(decisionsDir, `${date}.jsonl`);

  const existing = readJsonlSafe(decisionsPath).filter(e => e && e.type === 'outcome');
  const seen = new Set(existing.map(stableKeyForOutcomeEvent));

  const toAdd = [];
  for (const e of newEvents) {
    const key = stableKeyForOutcomeEvent(e);
    if (seen.has(key)) continue;
    seen.add(key);
    toAdd.push(e);
  }

  if (!dryRun && toAdd.length > 0) {
    const chunk = toAdd.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.appendFileSync(decisionsPath, chunk);
  }

  return { decisionsPath, added: toAdd.length, skipped: newEvents.length - toAdd.length };
}

function parseArgs() {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'help';
  const opts = {};
  const positional = [];

  for (const a of args.slice(1)) {
    if (a.startsWith('--repo=')) opts.repo = a.slice(7);
    else if (a.startsWith('--branch=')) opts.branch = a.slice(9);
    else if (a.startsWith('--outcome=')) opts.outcome = a.slice(10);
    else if (!a.startsWith('--')) positional.push(a);
  }

  return { cmd, opts, positional };
}

function printHelp() {
  console.log('git_outcomes.js v1.0 — auto outcomes from git commits');
  console.log('');
  console.log('Usage:');
  console.log('  node habits/scripts/git_outcomes.js run [YYYY-MM-DD] [--repo=PATH] [--branch=main] [--outcome=shipped]');
  console.log('  node habits/scripts/git_outcomes.js dry-run [YYYY-MM-DD] [--repo=PATH] [--branch=main] [--outcome=shipped]');
  console.log('');
  console.log('Commit tokens (in subject):');
  console.log('  eye:<eye_id>            required (can repeat)');
  console.log('  proposal:<proposal_id>   optional (can repeat)');
  console.log('  outcome:shipped|reverted|no_change  optional');
  console.log('');
  console.log('Writes: state/queue/decisions/YYYY-MM-DD.jsonl (type="outcome")');
}

function run({ dateStr, repo, branch, outcome, dryRun }) {
  const root = repoRoot(repo);
  const date = dateStr || getTodayUTC();
  const defaultOutcome = outcome || 'shipped';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(`GIT OUTCOMES - ${dryRun ? 'DRY RUN' : 'RUN'}`);
  console.log('═══════════════════════════════════════════════════════════');
  console.log(`Repo: ${root}`);
  console.log(`Date: ${date}`);
  console.log(`Branch: ${branch || 'HEAD'}`);
  console.log(`Default outcome: ${defaultOutcome}`);
  console.log('');

  const raw = gitLogForDate({ repo: root, branch, dateStr: date });
  const commits = parseGitLogLines(raw);

  const events = buildOutcomeEventsFromCommits({
    commits,
    defaultOutcome,
    dateStr: date
  });

  const res = appendOutcomesIdempotent({
    repo: root,
    dateStr: date,
    newEvents: events,
    dryRun: !!dryRun
  });

  // Simple summary
  const commitsWithEyes = commits.filter(c => extractTokens(c.subject).eyes.length > 0).length;
  console.log(`Commits scanned: ${commits.length}`);
  console.log(`Commits with eye:<id>: ${commitsWithEyes}`);
  console.log(`Outcome events built: ${events.length}`);
  console.log(`Added: ${res.added} Skipped (idempotent): ${res.skipped}`);
  console.log(`Decisions file: ${res.decisionsPath}`);
  console.log('═══════════════════════════════════════════════════════════');

  return res;
}

function main() {
  const { cmd, opts, positional } = parseArgs();
  const dateStr = positional[0] || null;

  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    printHelp();
    return;
  }

  if (cmd === 'run') {
    run({ dateStr, repo: opts.repo, branch: opts.branch, outcome: opts.outcome, dryRun: false });
    return;
  }

  if (cmd === 'dry-run') {
    run({ dateStr, repo: opts.repo, branch: opts.branch, outcome: opts.outcome, dryRun: true });
    return;
  }

  console.error(`Unknown command: ${cmd}`);
  printHelp();
  process.exit(1);
}

// Exports for tests
module.exports = {
  extractTokens,
  parseGitLogLines,
  buildOutcomeEventsFromCommits,
  stableKeyForOutcomeEvent,
  appendOutcomesIdempotent
};

if (require.main === module) {
  main();
}
