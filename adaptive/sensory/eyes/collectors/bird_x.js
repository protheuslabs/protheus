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
const { makeCollectorError } = require("./collector_errors");
const { loadCollectorCache, saveCollectorCache } = require("./cache_store");

function sha16(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
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
  const seenIds = new Set(cacheRaw?.items?.map(i => i.tweet_id) || []);
  const startTime = Date.now();
  
  const allPosts = [];
  let totalBytes = 0;
  let requests = 0;
  
  for (const query of searchQueries.slice(0, 3)) {
    try {
      const results = runBird(`search "${query}" -n ${options.maxItemsPerQuery || 10}`, options.timeoutMs);
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
      // Continue with other queries if one fails
      console.error(`   ⚠️  Query failed: ${query} - ${err.message || err.code}`);
    }
  }
  
  // Save cache with seen tweet IDs
  const cacheItems = Array.from(seenIds).slice(-100).map(id => ({ tweet_id: id }));
  saveCollectorCache("bird_x", cacheItems);
  
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
  try {
    // Check if bird CLI is available and authenticated by doing a test search
    const result = runBird('search "test" -n 1', 8000);
    const ready = Array.isArray(result);
    
    return {
      ok: !!ready,
      reachable: !!ready,
      authenticated: !!ready,
      items_sample: ready ? result.length : 0,
      error: ready ? null : "auth_or_connect_failed"
    };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      authenticated: false,
      items_sample: 0,
      error: err.code || "preflight_failed"
    };
  }
}

module.exports = {
  collectBirdX,
  preflightBirdX
};
