#!/usr/bin/env node
/**
 * habits/scripts/git_outcomes.js — deterministic git→outcome bridge
 *
 * Purpose:
 * - Close the loop automatically by recording shipped outcomes when commits
 *   explicitly reference proposals.
 *
 * Design rules:
 * - Deterministic: no LLM, no heuristics from diffs.
 * - Trust only explicit commit tags in the commit message body:
 *     proposal:<ID>
 *   Example:
 *     proposal:EYE-31c2031a0f27833c
 *
 * Commands:
 *   node habits/scripts/git_outcomes.js run [YYYY-MM-DD]
 *
 * State:
 *   - Cursor: state/git/outcomes_cursor.json
 *   - Log: state/git/outcomes/YYYY-MM-DD.jsonl
 *
 * Behavior:
 *   - Scans commits since cursor (or last N commits if no cursor).
 *   - For each unique proposal:<ID> tag found, records:
 *       proposal_queue.js outcome <ID> shipped "commit:<sha>"
 *   - Advances cursor to the latest scanned commit.
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

function repoRoot() {
  return path.resolve(__dirname, "..", "..");
}

function nowIso() {
  return new Date().toISOString();
}

function todayOr(dateStr) {
  if (dateStr && /^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return dateStr;
  return new Date().toISOString().slice(0, 10);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

function appendJsonl(filePath, obj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(obj) + "\n");
}

function runGit(args) {
  const r = spawnSync("git", args, { cwd: repoRoot(), encoding: "utf8" });
  if (r.status !== 0) {
    const msg = (r.stderr || r.stdout || "").trim();
    throw new Error(`git failed: ${args.join(" ")}${msg ? ` :: ${msg}` : ""}`);
  }
  return (r.stdout || "").trim();
}

function runNode(args) {
  const r = spawnSync("node", args, { cwd: repoRoot(), encoding: "utf8" });
  return {
    status: r.status || 0,
    stdout: (r.stdout || "").toString(),
    stderr: (r.stderr || "").toString()
  };
}

function parseProposalTags(commitBody) {
  // Accept uppercase/lowercase letters, digits, dashes/underscores.
  // Example: proposal:EYE-abcdef1234567890
  const re = /(?:^|\s)proposal:([A-Za-z0-9_-]+)\b/gm;
  const ids = [];
  let m;
  while ((m = re.exec(commitBody)) !== null) {
    const id = String(m[1] || "").trim();
    if (id) ids.push(id);
  }
  return ids;
}

function unique(arr) {
  return Array.from(new Set(arr));
}

function main() {
  const cmd = process.argv[2];
  const dateStr = todayOr(process.argv[3]);

  if (!cmd || cmd !== "run") {
    console.error("Usage:");
    console.error("  node habits/scripts/git_outcomes.js run [YYYY-MM-DD]");
    process.exit(2);
  }

  const root = repoRoot();
  const stateDir = path.join(root, "state", "git");
  const cursorPath = path.join(stateDir, "outcomes_cursor.json");
  const logPath = path.join(stateDir, "outcomes", `${dateStr}.jsonl`);

  const cursor = readJson(cursorPath, { last_sha: null, updated_at: null });
  const lastSha = cursor && cursor.last_sha ? String(cursor.last_sha) : null;

  // Determine commit range:
  //   - If we have a cursor sha: scan cursor..HEAD (excluding cursor)
  //   - Else: scan last 200 commits (reverse order for determinism)
  let shas = [];
  try {
    if (lastSha) {
      const out = runGit(["rev-list", "--reverse", `${lastSha}..HEAD`]);
      shas = out ? out.split("\n").filter(Boolean) : [];
    } else {
      const out = runGit(["rev-list", "--reverse", "--max-count=200", "HEAD"]);
      shas = out ? out.split("\n").filter(Boolean) : [];
    }
  } catch (e) {
    appendJsonl(logPath, {
      ts: nowIso(),
      type: "git_outcomes_error",
      date: dateStr,
      error: String(e.message || e).slice(0, 240)
    });
    console.error(String(e.message || e));
    process.exit(1);
  }

  appendJsonl(logPath, {
    ts: nowIso(),
    type: "git_outcomes_started",
    date: dateStr,
    cursor_last_sha: lastSha,
    commits_scanned: shas.length
  });

  // Collect tags
  const found = []; // { sha, id }
  for (const sha of shas) {
    let body = "";
    try {
      body = runGit(["show", "-s", "--format=%B", sha]);
    } catch (e) {
      appendJsonl(logPath, {
        ts: nowIso(),
        type: "git_outcomes_commit_read_failed",
        date: dateStr,
        sha,
        error: String(e.message || e).slice(0, 240)
      });
      continue;
    }

    const ids = parseProposalTags(body);
    for (const id of ids) {
      found.push({ sha, id });
    }
  }

  const uniquePairs = unique(found.map(x => `${x.id}@@${x.sha}`))
    .map(k => {
      const [id, sha] = k.split("@@");
      return { id, sha };
    });

  // Record outcomes
  let recorded = 0;
  let skipped = 0;
  for (const { id, sha } of uniquePairs) {
    const evidence = `commit:${sha}`;
    const res = runNode([
      "habits/scripts/proposal_queue.js",
      "outcome",
      id,
      "shipped",
      evidence
    ]);

    if (res.status === 0) {
      recorded++;
      appendJsonl(logPath, {
        ts: nowIso(),
        type: "git_outcomes_recorded",
        date: dateStr,
        proposal_id: id,
        outcome: "shipped",
        evidence_ref: evidence
      });
      continue;
    }

    // If outcome already exists or proposal missing, don't fail the run.
    const err = `${res.stderr} ${res.stdout}`.toLowerCase();
    const benign =
      err.includes("already") ||
      err.includes("exists") ||
      err.includes("no change") ||
      err.includes("unknown proposal") ||
      err.includes("not found");

    skipped++;
    appendJsonl(logPath, {
      ts: nowIso(),
      type: "git_outcomes_skipped",
      date: dateStr,
      proposal_id: id,
      evidence_ref: evidence,
      reason: benign ? "benign_error" : "nonzero_exit",
      status: res.status
    });

    if (!benign) {
      // Surface the failure, but keep deterministic behavior: exit nonzero.
      console.error(`git_outcomes: failed to record outcome for ${id} (${evidence})`);
      process.stderr.write(res.stderr || "");
      process.stdout.write(res.stdout || "");
      process.exit(1);
    }
  }

  // Advance cursor to the latest scanned commit (even if no proposal tags)
  const newCursorSha = shas.length ? shas[shas.length - 1] : lastSha;
  writeJson(cursorPath, { last_sha: newCursorSha, updated_at: nowIso() });

  appendJsonl(logPath, {
    ts: nowIso(),
    type: "git_outcomes_ok",
    date: dateStr,
    tags_found: found.length,
    outcomes_recorded: recorded,
    outcomes_skipped: skipped,
    cursor_new_sha: newCursorSha
  });

  console.log(
    `git_outcomes: scanned=${shas.length} tags=${found.length} recorded=${recorded} skipped=${skipped} cursor=${newCursorSha || "null"}`
  );
}

main();
