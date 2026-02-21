/**
 * adaptive/sensory/eyes/collectors/ollama_search.js
 *
 * Deterministic Ollama search collector.
 * - Fetches ollama.com/search?o=newest
 * - Emits items with: collected_at, id, url, title, description, tags, bytes
 * - NO LLM usage, minimal dependencies (regex-based HTML parsing)
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

function fetchText(url, timeoutMs = 10000) {
  return (async () => {
    try {
      const host = new URL(url).hostname;
      const res = await egressFetchText(url, {
        method: "GET",
        headers: {
          "User-Agent": "openclaw-eyes/1.0",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
          "Accept-Encoding": "identity"
        }
      }, {
        scope: "sensory.collector.ollama_search",
        caller: "adaptive/sensory/eyes/collectors/ollama_search",
        runtime_allowlist: [host],
        timeout_ms: timeoutMs,
        meta: { collector: "ollama_search" }
      });
      if (res.status >= 400) {
        throw makeCollectorError(
          httpStatusToCode(res.status),
          `HTTP ${res.status} for ${url}`,
          { http_status: Number(res.status), url }
        );
      }
      return {
        text: String(res.text || ""),
        bytes: Buffer.byteLength(String(res.text || ""), "utf8")
      };
    } catch (err) {
      if (err instanceof EgressGatewayError) {
        throw makeCollectorError(
          "env_blocked",
          `egress_denied:${String(err.details && err.details.code || "policy")} for ${url}`.slice(0, 220),
          { url }
        );
      }
      const c = classifyCollectorError(err);
      throw makeCollectorError(
        c.code,
        `${c.message} for ${url}`.slice(0, 200),
        { http_status: c.http_status, url }
      );
    }
  })();
}

/**
 * Extract model entries from Ollama search HTML
 * Looking for patterns like:
 * <a href="/library/llama3.3" ...>
 *   <h2>llama3.3</h2>
 *   <p class="...">description...</p>
 *   <div class="...">tags...</div>
 * </a>
 */
function extractModels(html) {
  const models = [];
  
  // Find model cards - they're in anchor tags linking to /library/{name}
  // Pattern: data-testid="model-card" or similar structure
  const modelCardRegex = /<a[^>]*href="\/library\/([^"]+)"[^>]*data-testid="model-card"[^>]*>([\s\S]*?)<\/a>/gi;
  
  let match;
  while ((match = modelCardRegex.exec(html)) !== null) {
    const modelName = match[1];
    const cardHtml = match[2];
    
    // Extract title (usually in h2)
    const titleMatch = cardHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
    const title = titleMatch ? stripHtml(titleMatch[1]).trim() : modelName;
    
    // Extract description (usually in a paragraph)
    const descMatch = cardHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    const description = descMatch ? stripHtml(descMatch[1]).trim() : "";
    
    // Extract tags (usually in spans with specific classes)
    const tags = [];
    const tagRegex = /<span[^>]*>([\s\S]*?)<\/span>/gi;
    let tagMatch;
    while ((tagMatch = tagRegex.exec(cardHtml)) !== null) {
      const tagText = stripHtml(tagMatch[1]).trim();
      if (tagText && tagText.length < 30 && !tagText.includes('\n')) {
        tags.push(tagText.toLowerCase());
      }
    }
    
    // Extract capability tags, sizes, etc.
    const capabilityTags = extractCapabilityTags(cardHtml);
    
    models.push({
      id: sha16(modelName + title),
      name: modelName,
      title: title,
      description: description,
      url: `https://ollama.com/library/${modelName}`,
      tags: [...new Set([...tags, ...capabilityTags])].slice(0, 8),
      source: "ollama_search"
    });
  }
  
  // Fallback: if no data-testid found, try alternative pattern
  if (models.length === 0) {
    const fallbackRegex = /<a[^>]*href="\/library\/([^"]+)"[^>]*class="[^"]*group[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;
    while ((match = fallbackRegex.exec(html)) !== null) {
      const modelName = match[1];
      const cardHtml = match[2];
      
      const titleMatch = cardHtml.match(/<h2[^>]*>([\s\S]*?)<\/h2>/i);
      const title = titleMatch ? stripHtml(titleMatch[1]).trim() : modelName;
      
      const descMatch = cardHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
      const description = descMatch ? stripHtml(descMatch[1]).trim() : "";
      
      models.push({
        id: sha16(modelName + title + Date.now()),
        name: modelName,
        title: title,
        description: description,
        url: `https://ollama.com/library/${modelName}`,
        tags: extractCapabilityTags(cardHtml),
        source: "ollama_search_fallback"
      });
    }
  }
  
  return models;
}

function stripHtml(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractCapabilityTags(html) {
  const tags = [];
  
  // Look for common model capability indicators
  const patterns = [
    { regex: /\b(\d+\.?\d*\s*[BM]?)\s*(?:parameters?|params?)/i, tag: (m) => `${m[1].toLowerCase().replace(/\s+/g, '')}` },
    { regex: /\b(vision|multimodal|image|code|tools|embedding)/i, tag: (m) => m[1].toLowerCase() },
    { regex: /\b(llama|qwen|mistral|gemma|phi|deepseek|mixtral)/i, tag: (m) => m[1].toLowerCase() },
    { regex: /\b(instruct|chat|base|pretrained|fine-tuned)/i, tag: (m) => m[1].toLowerCase() }
  ];
  
  for (const { regex, tag } of patterns) {
    const match = html.match(regex);
    if (match) {
      const t = tag(match);
      if (t && !tags.includes(t)) tags.push(t);
    }
  }
  
  return tags;
}

async function collectOllamaSearchNewest(options = {}) {
  const searchUrl = "https://ollama.com/search?o=newest";
  const cacheRaw = loadCollectorCache("ollama_search");
  const cache = {
    seen: new Set(cacheRaw?.items?.map(i => i.id) || [])
  };
  const startTime = Date.now();
  
  try {
    const { text, bytes } = await fetchText(searchUrl, options.timeoutMs || 10000);
    const models = extractModels(text);
    
    if (models.length === 0) {
      return {
        ok: false,
        success: false,
        error: makeCollectorError("parse_failed", "No models extracted from Ollama search page", { url: searchUrl }),
        items: [],
        bytes: 0,
        duration_ms: Date.now() - startTime,
        requests: 1
      };
    }
    
    // Deduplicate by ID using cache
    const newItems = [];
    for (const model of models) {
      if (!cache.seen.has(model.id)) {
        cache.seen.add(model.id);
        newItems.push({
          collected_at: nowIso(),
          eye_id: "ollama_search",
          id: model.id,
          title: model.title,
          description: model.description,
          url: model.url,
          tags: model.tags,
          topics: inferTopics(model),
          bytes: Math.floor(bytes / models.length) // Approximate per-item bytes
        });
      }
    }
    
    saveCollectorCache("ollama_search", newItems);
    
    return {
      ok: true,
      success: true,
      items: newItems,
      bytes,
      duration_ms: Date.now() - startTime,
      requests: 1
    };
    
  } catch (err) {
    return {
      ok: false,
      success: false,
      error: err.code ? err : makeCollectorError("network_error", String(err.message || err), { url: searchUrl }),
      items: [],
      bytes: 0,
      duration_ms: Date.now() - startTime,
      requests: 1
    };
  }
}

function inferTopics(model) {
  const topics = ["ai", "llm", "local_models"];
  
  const titleDesc = (model.title + " " + model.description).toLowerCase();
  
  if (/vision|image|multimodal/.test(titleDesc)) topics.push("vision");
  if (/code|programming|developer/.test(titleDesc)) topics.push("code");
  if (/embedding|vector|retrieval/.test(titleDesc)) topics.push("embeddings");
  if (/tool|agent|autonomous/.test(titleDesc)) topics.push("agents");
  if (/small|tiny|mini|lightweight/.test(titleDesc)) topics.push("edge");
  if (/70b|40b|30b/.test(titleDesc)) topics.push("large_models");
  
  return [...new Set(topics)];
}

async function preflightOllamaSearch() {
  try {
    const result = await collectOllamaSearchNewest({ timeoutMs: 5000 });
    return {
      ok: result.ok,
      reachable: result.ok,
      items_sample: result.items?.length || 0,
      error: result.error?.code || null
    };
  } catch (err) {
    return {
      ok: false,
      reachable: false,
      items_sample: 0,
      error: err.code || "preflight_failed"
    };
  }
}

module.exports = {
  collectOllamaSearchNewest,
  preflightOllamaSearch
};
