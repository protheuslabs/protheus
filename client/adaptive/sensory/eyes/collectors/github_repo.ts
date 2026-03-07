/**
 * adaptive/sensory/eyes/collectors/github_repo.ts
 *
 * GitHub repo eye - watches repos for releases, commits, issues, activity.
 * - Fetches latest release, recent commits, open issues
 * - Emits items with: collected_at, id, type (release/commit/issue), url, title
 * - NO LLM usage, uses GitHub API (no auth required for public repos)
 */

const crypto = require("crypto");
const { classifyCollectorError, httpStatusToCode, makeCollectorError } = require("./collector_errors");
const { loadCollectorCache, saveCollectorCache } = require("./cache_store");
const { egressFetchText, EgressGatewayError } = require("../../../../lib/egress_gateway");

function sha16(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function fetchJson(url, timeoutMs = 15000) {
  return (async () => {
    try {
      const host = new URL(url).hostname;
      const res = await egressFetchText(url, {
        method: "GET",
        headers: {
          "User-Agent": "OpenClaw-Eyes/1.0",
          "Accept": "application/vnd.github+json",
        }
      }, {
        scope: "sensory.collector.github_repo",
        caller: "adaptive/sensory/eyes/collectors/github_repo",
        runtime_allowlist: [host],
        timeout_ms: timeoutMs,
        meta: { collector: "github_repo" }
      });
      if (res.status >= 400) {
        throw makeCollectorError(
          httpStatusToCode(res.status),
          `HTTP ${res.status} for ${url}`,
          { http_status: Number(res.status), url }
        );
      }
      const text = String(res.text || "");
      try {
        return { json: JSON.parse(text), bytes: Buffer.byteLength(text, "utf8") };
      } catch {
        return { text, bytes: Buffer.byteLength(text, "utf8"), json: null };
      }
    } catch (err) {
      if (err instanceof EgressGatewayError) {
        throw makeCollectorError(
          "env_blocked",
          `egress_denied:${String(err.details && err.details.code || "policy")} for ${url}`.slice(0, 220),
          { url }
        );
      }
      const c = classifyCollectorError(err);
      throw makeCollectorError(c.code, c.message, { url, http_status: c.http_status });
    }
  })();
}

async function run({ owner, repo, maxItems = 10, minHours = 4, force = false } = {}) {
  const cacheKey = `github_repo_${owner}_${repo}`;
  const cache = loadCollectorCache(cacheKey) || { last_run: null, seen_ids: [] };
  const lastRun = cache.last_run ? new Date(cache.last_run) : null;
  const hoursSince = lastRun ? (Date.now() - lastRun.getTime()) / (1000 * 60 * 60) : Infinity;
  
  if (!force && hoursSince < minHours) {
    return {
      ok: true,
      skipped: true,
      reason: "cadence",
      hours_since_last: Number(hoursSince.toFixed(2)),
      min_hours: minHours,
    };
  }
  
  const items = [];
  let error = null;
  let bytes = 0;
  
  try {
    const baseUrl = `https://api.github.com/repos/${owner}/${repo}`;
    
    // Fetch latest release
    try {
      const { json: release, bytes: rb } = await fetchJson(`${baseUrl}/releases/latest`);
      bytes += rb;
      
      if (release && release.tag_name) {
        const id = sha16(`release-${owner}-${repo}-${release.tag_name}`);
        if (!cache.seen_ids?.includes(id)) {
          items.push({
            id,
            collected_at: nowIso(),
            url: release.html_url,
            title: `${owner}/${repo}: ${release.tag_name}`,
            description: `Release: ${release.name || release.tag_name}. ${release.body?.slice(0, 200) || ''}`,
            type: "release",
            tag_name: release.tag_name,
            published_at: release.published_at,
            author: release.author?.login,
            signal_type: "repo_release",
            signal: true,
            source: "github_repo",
            repo: `${owner}/${repo}`,
            tags: ["github", "release", "software"],
            topics: ["repo_activity", "releases"],
            bytes: rb,
          });
        }
      }
    } catch (e) {
      // No release is OK, continue
    }
    
    // Fetch recent commits
    try {
      const { json: commits, bytes: cb } = await fetchJson(`${baseUrl}/commits?per_page=5`);
      bytes += cb;
      
      if (Array.isArray(commits)) {
        for (const commit of commits.slice(0, 3)) {
          const commitSha = commit.sha?.slice(0, 7);
          const id = sha16(`commit-${owner}-${repo}-${commit.sha}`);
          
          if (!cache.seen_ids?.includes(id)) {
            items.push({
              id,
              collected_at: nowIso(),
              url: commit.html_url,
              title: `${owner}/${repo}: ${commit.commit?.message?.split('\n')[0]?.slice(0, 60)}`,
              description: `Commit by ${commit.commit?.author?.name}: ${commit.commit?.message?.slice(0, 150)}`,
              type: "commit",
              sha: commitSha,
              author: commit.commit?.author?.name,
              date: commit.commit?.author?.date,
              signal_type: "repo_commit",
              signal: false, // Commits are normal activity
              source: "github_repo",
              repo: `${owner}/${repo}`,
              tags: ["github", "commit", "development"],
              topics: ["repo_activity", "development"],
              bytes: 0,
            });
          }
        }
      }
    } catch (e) {
      // Continue without commits
    }
    
    // Update cache
    cache.last_run = nowIso();
    cache.seen_ids = [...(cache.seen_ids || []).slice(-500), ...items.map(i => i.id)];
    saveCollectorCache(cacheKey, cache);
    
    return {
      ok: true,
      success: true,
      eye: "github_repo",
      owner,
      repo,
      items,
      bytes,
      duration_ms: 0,
      requests: 3,
      cadence_hours: minHours,
      sample: items[0]?.type || null,
    };
    
  } catch (err) {
    return {
      ok: false,
      success: false,
      eye: "github_repo",
      owner,
      repo,
      items: [],
      bytes,
      duration_ms: 0,
      requests: 1,
      cadence_hours: minHours,
      error: err.code || err.message,
    };
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const owner = args.find(a => a.startsWith("--owner="))?.split("=")[1];
  const repo = args.find(a => a.startsWith("--repo="))?.split("=")[1];
  const maxItems = Number(args.find(a => a.startsWith("--max="))?.split("=")[1] || 10);
  const minHours = Number(args.find(a => a.startsWith("--min-hours="))?.split("=")[1] || 4);
  const force = args.includes("--force");
  
  if (!owner || !repo) {
    console.error(JSON.stringify({ ok: false, error: "Missing --owner or --repo" }));
    process.exit(1);
  }
  
  run({ owner, repo, maxItems, minHours, force }).then(r => {
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }).catch(e => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}

module.exports = { run };
