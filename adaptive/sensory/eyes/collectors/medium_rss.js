/**
 * adaptive/sensory/eyes/collectors/medium_rss.js
 *
 * Deterministic Medium RSS collector.
 * - Fetches RSS feeds for relevant tags/topics
 * - Emits items with: collected_at, id(item_hash), url, title, topics, bytes
 * - NO LLM usage, NO HTML parsing, minimal dependencies
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

function fetchText(url, timeoutMs = 8000) {
  return (async () => {
    try {
      const host = new URL(url).hostname;
      const res = await egressFetchText(url, {
        method: "GET",
        headers: { "User-Agent": "openclaw-eyes/1.0" }
      }, {
        scope: "sensory.collector.medium_rss",
        caller: "adaptive/sensory/eyes/collectors/medium_rss",
        runtime_allowlist: [host],
        timeout_ms: timeoutMs,
        meta: { collector: "medium_rss" }
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

function stripCdata(s) {
  return String(s || "").replace("<![CDATA[", "").replace("]]>", "").trim();
}

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractTag(xml, tag) {
  const re = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "i");
  const m = xml.match(re);
  return m ? decodeXmlEntities(stripCdata(m[1])) : "";
}

function splitItems(rssXml) {
  return String(rssXml).split(/<item>/i).slice(1).map((chunk) => chunk.split(/<\/item>/i)[0]);
}

function keywordTopics(title, configuredTopics = []) {
  const t = String(title || "").toLowerCase();
  const out = new Set(configuredTopics);

  // Revenue/business signals
  if (t.includes("startup") || t.includes("founder") || t.includes("venture")) out.add("startups");
  if (t.includes("revenue") || t.includes("monetiz") || t.includes("profit")) out.add("revenue");
  if (t.includes("ai") || t.includes("artificial intelligence") || t.includes("machine learning")) out.add("ai");
  if (t.includes("agent") || t.includes("autonomous")) out.add("ai_agents");
  if (t.includes("automation") || t.includes("workflow") || t.includes("orchestration")) out.add("automation");
  if (t.includes("saas") || t.includes("b2b") || t.includes("product")) out.add("saas");
  if (t.includes("scaling") || t.includes("growth")) out.add("growth");
  if (t.includes("build") || t.includes("engineering")) out.add("engineering");
  if (t.includes("strategy") || t.includes("business")) out.add("business");

  return Array.from(out).slice(0, 5);
}

// Medium tags aligned with T1 northstar (making Jay a billionaire)
const MEDIUM_TAGS = [
  "artificial-intelligence",
  "machine-learning",
  "startups",
  "entrepreneurship",
  "saastartups",
  "product-management",
  "business-strategy",
  "automation",
  "chatgpt",
  "llm"
];

function candidateFeedUrls(eyeConfig) {
  const out = [];
  // Generate tag-based feeds
  const tags = eyeConfig?.parser_options?.tags || MEDIUM_TAGS;
  for (const tag of tags) {
    out.push(`https://medium.com/feed/tag/${tag}`);
  }
  // Add any configured custom feeds
  if (Array.isArray(eyeConfig?.feed_candidates)) {
    for (const u of eyeConfig.feed_candidates) {
      if (u) out.push(String(u));
    }
  }
  if (eyeConfig?.feed_url) out.push(String(eyeConfig.feed_url));
  return Array.from(new Set(out.filter(Boolean)));
}

function preflightMediumRss(eyeConfig, budgets) {
  const failures = [];
  const checks = [];
  const uniqueCandidates = candidateFeedUrls(eyeConfig);

  if (!uniqueCandidates.length) {
    failures.push({ code: "invalid_config", message: "No Medium RSS feed candidates configured" });
  }

  const allowlist = Array.isArray(eyeConfig?.allowed_domains) ? eyeConfig.allowed_domains : ["medium.com", "www.medium.com"];
  for (const feedUrl of uniqueCandidates) {
    try {
      const u = new URL(feedUrl);
      if (u.protocol !== "https:") {
        failures.push({ code: "invalid_config", message: `Feed URL must use https: ${feedUrl}` });
        continue;
      }
      const allowed = allowlist.some(d => u.hostname === d || u.hostname.endsWith(`.${d}`));
      if (!allowed) {
        failures.push({ code: "domain_not_allowlisted", message: `Feed host not allowlisted: ${u.hostname}` });
      } else {
        checks.push({ name: "allowlisted_feed_url", ok: true, url: feedUrl, host: u.hostname });
      }
    } catch {
      failures.push({ code: "invalid_config", message: `Invalid feed URL: ${feedUrl}` });
    }
  }

  const maxSeconds = Number(budgets && budgets.max_seconds);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    failures.push({ code: "invalid_budget", message: "budgets.max_seconds must be > 0" });
  } else {
    checks.push({ name: "max_seconds_valid", ok: true, value: maxSeconds });
  }

  return {
    ok: failures.length === 0,
    parser_type: "medium_rss",
    checks,
    failures,
    candidates: uniqueCandidates
  };
}

async function collectMediumRss(eyeConfig, budgets) {
  const started = Date.now();

  const pf = preflightMediumRss(eyeConfig, budgets);
  if (!pf.ok) {
    const first = pf.failures[0] || {};
    throw makeCollectorError(
      String(first.code || "invalid_config"),
      `medium_rss_preflight_failed (${String(first.message || "unknown").slice(0, 160)})`,
      { failures: pf.failures.slice(0, 8) }
    );
  }

  const uniqueCandidates = Array.isArray(pf.candidates) ? pf.candidates : [];
  const maxCandidates = Math.min(uniqueCandidates.length, 5); // Limit to avoid hammering
  const maxItemsPerFeed = Math.max(1, Math.floor((budgets?.max_items || 15) / maxCandidates));
  const maxTotalItems = budgets?.max_items || 15;

  const allItems = [];
  const failures = [];
  let totalBytes = 0;
  let totalRequests = 0;

  for (const feedUrl of uniqueCandidates.slice(0, maxCandidates)) {
    if (allItems.length >= maxTotalItems) break;
    
    try {
      const r = await fetchText(feedUrl, Math.min(8000, (budgets?.max_seconds || 10) * 1000));
      totalBytes += r.bytes;
      totalRequests++;
      
      const itemsRaw = splitItems(r.text);
      
      for (const it of itemsRaw.slice(0, maxItemsPerFeed)) {
        const title = extractTag(it, "title");
        const url = extractTag(it, "link");
        if (!title || !url) continue;

        const item_hash = sha16(url);
        allItems.push({
          collected_at: nowIso(),
          id: item_hash,
          url,
          title,
          topics: keywordTopics(title, Array.isArray(eyeConfig?.topics) ? eyeConfig.topics : []),
          bytes: Math.min(512, title.length + url.length + 64)
        });
      }
    } catch (e) {
      const c = classifyCollectorError(e);
      failures.push({
        url: feedUrl,
        code: c.code,
        error: c.message
      });
    }
  }

  if (allItems.length === 0 && failures.length > 0) {
    const fallbackCodes = new Set([
      "dns_unreachable", "connection_refused", "connection_reset", "timeout",
      "tls_error", "network_error", "http_5xx", "rate_limited", "env_blocked"
    ]);
    const allFallbackEligible = failures.every(f => fallbackCodes.has(String(f.code || "")));
    if (allFallbackEligible) {
      const cached = loadCollectorCache(eyeConfig && eyeConfig.id || "medium_com");
      if (cached && Array.isArray(cached.items) && cached.items.length) {
        return {
          success: true,
          items: cached.items,
          duration_ms: Date.now() - started,
          requests: failures.length,
          bytes: cached.items.reduce((s, it) => s + Number((it && it.bytes) || 0), 0),
          cache_hit: true
        };
      }
    }
    const detail = failures.map(f => `${f.url}: ${f.code}:${f.error}`).join(" | ");
    const dominantCode = failures.every(f => f.code === failures[0].code) ? failures[0].code : "multi_fetch_failed";
    throw makeCollectorError(
      dominantCode,
      `medium_rss_fetch_failed (${detail || "no_attempts"})`,
      { attempts: failures.slice(0, 8) }
    );
  }

  const duration_ms = Date.now() - started;
  if (allItems.length > 0) {
    saveCollectorCache(eyeConfig && eyeConfig.id || "medium_com", allItems);
  }

  return {
    success: true,
    items: allItems.slice(0, maxTotalItems),
    duration_ms,
    requests: totalRequests,
    bytes: totalBytes
  };
}

module.exports = { collectMediumRss, preflightMediumRss };
