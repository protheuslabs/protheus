/**
 * adaptive/sensory/eyes/collectors/bird_x.js
 *
 * Deterministic X/Twitter collector using bird CLI.
 * - Searches X for agent/AI related posts
 * - Emits items with: collected_at, id, url, title, content, author, topics
 * - NO LLM usage, uses bird CLI for access
 */

const { execSync } = require("child_process");
const crypto = require("crypto");
const { classifyCollectorError, makeCollectorError } = require("./collector_errors");
const { loadCollectorCache, saveCollectorCache } = require("./cache_store");

function sha16(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function birdCliAvailable() {
  try {
    execSync('command -v bird >/dev/null 2>&1', { stdio: 'ignore', timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run bird CLI and return parsed JSON
 */
function runBird(args, timeoutMs = 15000) {
  try {
    const cmd = `bird ${args} --json 2>/dev/null`;
    const result = execSync(cmd, { 
      encoding: "utf8", 
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 // 1MB
    });
    return JSON.parse(result);
  } catch (err) {
    if (err.code === "ETIMEDOUT") {
      throw makeCollectorError("timeout", `bird command timed out after ${timeoutMs}ms`, { args });
    }
    if (err.status === 127 || err.message.includes("command not found")) {
      throw makeCollectorError("env_blocked", "bird CLI not found in PATH", { args });
    }
    throw makeCollectorError("parse_failed", String(err.message || err), { args });
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms) || 0)));
}

async function runBirdWithRetry(args, timeoutMs = 15000, maxAttempts = 2) {
  const attempts = Math.max(1, Number(maxAttempts || 1));
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return runBird(args, timeoutMs);
    } catch (err) {
      lastErr = err;
      const classified = classifyCollectorError(err);
      const retryable = classified.retryable || String(classified.code || '') === 'parse_failed';
      if (!retryable || i >= attempts - 1) break;
      await sleep(120 * (i + 1));
    }
  }
  throw lastErr || makeCollectorError('collector_error', 'bird_command_failed', { args });
}

/**
 * Extract posts from bird search results
 */
function extractPosts(birdResults) {
  const posts = [];
  
  if (!Array.isArray(birdResults)) return posts;
  
  for (const item of birdResults) {
    if (!item || !item.id) continue;
    
    const content = item.text || item.content || "";
    const author = item.author || item.user || {};
    const authorHandle = author.handle || author.username || "unknown";
    
    // Build a title from first line or truncated content
    const firstLine = content.split('\n')[0].slice(0, 100);
    const title = firstLine || `Post by @${authorHandle}`;
    
    posts.push({
      id: sha16(item.id + content.slice(0, 200)),
      tweet_id: item.id,
      title: title,
      content: content,
      url: `https://x.com/${authorHandle}/status/${item.id}`,
      author: authorHandle,
      author_name: author.name || author.displayName || authorHandle,
      likes: item.likes || item.favorite_count || 0,
      retweets: item.retweets || item.retweet_count || 0,
      replies: item.replies || item.reply_count || 0,
      posted_at: item.created_at || item.date,
      topics: inferTopics(content),
      source: "bird_x"
    });
  }
  
  return posts;
}

function inferTopics(content) {
  const topics = ["social"];
  const text = content.toLowerCase();
  
  if (/\b(ai|llm|model|gpt|claude|agent|autonomous)\b/.test(text)) topics.push("ai");
  if (/\b(startup|venture|founder|ceo|business|revenue|mrr)\b/.test(text)) topics.push("business");
  if (/\b(code|dev|engineering|software|github|api)\b/.test(text)) topics.push("dev");
  if (/\b(moltbook|openclaw|clawhub|agent)\b/.test(text)) topics.push("agent_community");
  if (/\b(news|breaking|update|announced|launch)\b/.test(text)) topics.push("news");
  
  return [...new Set(topics)];
}

/**
 * Main collector function
 */
async function collectBirdX(options = {}) {
  const searchQueries = options.queries || [
    "AI agent",
    "moltbook OR openclaw",
    "local LLM ollama"
  ];
  
  const cacheRaw = loadCollectorCache("bird_x");
  const cachedItems = Array.isArray(cacheRaw && cacheRaw.items) ? cacheRaw.items : [];
  const seenIds = new Set(cachedItems.map(i => i && (i.tweet_id || i.id)).filter(Boolean));
  const startTime = Date.now();
  const queryTimeoutMs = Math.max(5000, Number(options.timeoutMs || 15000));
  const retryAttempts = Math.max(1, Math.min(
    Number(options.retryAttempts || process.env.EYES_COLLECTOR_FETCH_RETRY_ATTEMPTS || 2) || 2,
    4
  ));
  
  const allPosts = [];
  const queryFailures = [];
  let totalBytes = 0;
  let requests = 0;
  
  for (const query of searchQueries.slice(0, 3)) {
    try {
      const results = await runBirdWithRetry(
        `search "${query}" -n ${options.maxItemsPerQuery || 10}`,
        queryTimeoutMs,
        retryAttempts
      );
      requests++;
      
      const posts = extractPosts(results);
      totalBytes += JSON.stringify(results).length;
      
      for (const post of posts) {
        if (!seenIds.has(post.tweet_id)) {
          seenIds.add(post.tweet_id);
          allPosts.push({
            collected_at: nowIso(),
            eye_id: "bird_x",
            id: post.id,
            title: post.title,
            description: post.content,
            url: post.url,
            author: post.author,
            tags: [post.author_name, `likes:${post.likes}`, `rt:${post.retweets}`].filter(Boolean),
            topics: post.topics,
            bytes: Math.floor(totalBytes / Math.max(posts.length, 1))
          });
        }
      }
    } catch (err) {
      const classified = classifyCollectorError(err);
      queryFailures.push({
        code: classified.code,
        message: classified.message,
        http_status: classified.http_status
      });
      // Continue with other queries if one fails
      console.error(`   ⚠️  Query failed: ${query} - ${err.message || err.code}`);
    }
  }
  
  if (allPosts.length === 0 && queryFailures.length > 0) {
    const fallbackCodes = new Set([
      'dns_unreachable',
      'connection_refused',
      'connection_reset',
      'timeout',
      'tls_error',
      'network_error',
      'http_5xx',
      'rate_limited',
      'env_blocked',
      'parse_failed',
      'collector_error'
    ]);
    const allFallbackEligible = queryFailures.every((f) => fallbackCodes.has(String(f.code || '')));
    if (allFallbackEligible && cachedItems.length > 0) {
      const maxItems = Math.max(1, Number(options.maxItems || 15));
      return {
        ok: true,
        success: true,
        items: cachedItems.slice(0, maxItems),
        bytes: cachedItems.reduce((s, it) => s + Number((it && it.bytes) || 0), 0),
        duration_ms: Date.now() - startTime,
        requests,
        cache_hit: true,
        failure_count: queryFailures.length,
        failures: queryFailures.slice(0, 3)
      };
    }
    const primary = queryFailures[0];
    return {
      ok: false,
      success: false,
      items: [],
      bytes: totalBytes,
      duration_ms: Date.now() - startTime,
      requests,
      error: primary.message || 'bird_x_all_queries_failed',
      error_code: primary.code || 'collector_error',
      error_http_status: primary.http_status == null ? null : Number(primary.http_status),
      failure_count: queryFailures.length,
      failures: queryFailures.slice(0, 3)
    };
  }

  if (allPosts.length > 0) {
    saveCollectorCache("bird_x", allPosts.slice(0, 120));
  }

  return {
    ok: allPosts.length > 0,
    success: allPosts.length > 0,
    items: allPosts.slice(0, options.maxItems || 15),
    bytes: totalBytes,
    duration_ms: Date.now() - startTime,
    requests
  };
}

async function preflightBirdX() {
  const cliPresent = birdCliAvailable();
  if (!cliPresent) {
    return {
      ok: false,
      parser_type: "bird_x",
      reachable: false,
      authenticated: false,
      items_sample: 0,
      checks: [{ name: "bird_cli_present", ok: false }],
      failures: [{ code: "env_blocked", message: "bird CLI not found in PATH" }],
      error: "env_blocked"
    };
  }

  // Keep preflight lightweight and deterministic: verify local capability only.
  return {
    ok: true,
    parser_type: "bird_x",
    reachable: true,
    authenticated: null,
    items_sample: 0,
    checks: [{ name: "bird_cli_present", ok: true }],
    failures: [],
    error: null
  };
}

module.exports = {
  collectBirdX,
  preflightBirdX
};
