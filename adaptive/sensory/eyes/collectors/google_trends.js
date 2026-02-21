/**
 * adaptive/sensory/eyes/collectors/google_trends.js
 *
 * Google Trends eye - tracks trending searches and commercial demand signals.
 * - Scrapes Google Trends daily trending searches page
 * - Filters for business/tech/AI/automation keywords
 * - Emits items with: collected_at, id, term, traffic, related, signal_type
 * - NO LLM usage, uses HTML scraping
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

function fetchHtml(url, timeoutMs = 15000) {
  return (async () => {
    try {
      const host = new URL(url).hostname;
      const res = await egressFetchText(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Accept-Encoding": "gzip, deflate, br",
          "DNT": "1",
          "Connection": "keep-alive",
          "Upgrade-Insecure-Requests": "1",
        }
      }, {
        scope: "sensory.collector.google_trends",
        caller: "adaptive/sensory/eyes/collectors/google_trends",
        runtime_allowlist: [host],
        timeout_ms: timeoutMs,
        meta: { collector: "google_trends" }
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
      throw makeCollectorError(c.code, c.message, { url, http_status: c.http_status });
    }
  })();
}

function parseTrendingSearchesHtml(html) {
  const items = [];
  
  // Look for JSON data embedded in the page
  // Google Trends embeds data in scripts as "trendingSearches": [...]
  const jsonMatch = html.match(/trendingSearches[\"']?\s*:\s*(\[.*?\])(?:,|\s*\})/s);
  
  if (jsonMatch) {
    try {
      const trends = JSON.parse(jsonMatch[1]);
      for (const trend of trends) {
        if (trend.title) {
          items.push({
            term: trend.title.query || trend.title,
            traffic: trend.formattedTraffic || trend.traffic || null,
            related: trend.relatedQueries?.map(q => q.query || q).slice(0, 3) || [],
          });
        }
      }
    } catch (e) {
      // JSON parse failed, fall through to regex extraction
    }
  }
  
  // Fallback: extract from script tags containing "trendingSearches"
  if (items.length === 0) {
    const scriptMatches = html.match(/<script[^>]*>[\s\S]*?trendingSearches[\s\S]*?<\/script>/gi) || [];
    for (const script of scriptMatches) {
      const dataMatch = script.match(/trendingSearches[\"']?\s*:\s*(\[.*?\])(?:,|\s*[\}\]])/s);
      if (dataMatch) {
        try {
          const trends = JSON.parse(dataMatch[1]);
          for (const trend of trends) {
            if (trend.title?.query || typeof trend.title === 'string') {
              items.push({
                term: trend.title.query || trend.title,
                traffic: trend.formattedTraffic || null,
                related: trend.relatedQueries?.map(q => q.query || q).slice(0, 3) || [],
              });
            }
          }
          if (items.length > 0) break;
        } catch (e) {
          continue;
        }
      }
    }
  }
  
  return items;
}

// Commercial intent keywords for filtering
const COMMERCIAL_KEYWORDS = [
  // AI/Automation
  'ai', 'artificial intelligence', 'automation', 'chatbot', 'gpt', 'llm', 'machine learning',
  'robot', 'workflow', 'agent', 'copilot', 'assistant', 'openai', 'anthropic', 'claude',
  // Business/Tech
  'startup', 'saas', 'software', 'app', 'platform', 'tool', 'service',
  'pricing', 'cost', 'buy', 'purchase', 'deal', 'sale', 'discount', 'coupon',
  // Finance/Investing
  'stock', 'crypto', 'bitcoin', 'invest', 'trading', 'market', 'fund', 'etf', 'forex',
  // Productivity
  'productivity', 'efficiency', 'remote work', 'freelance', 'side hustle', 'passive income',
  // Emerging tech
  'blockchain', 'web3', 'nft', 'metaverse', 'vr', 'ar', 'quantum', 'edge computing'
];

const HIGH_VALUE_KEYWORDS = [
  'buy', 'purchase', 'price', 'cost', 'deal', 'discount', 'sale', 'review', 'best', 'top',
  'software', 'tool', 'app', 'platform', 'service', 'saas', 'startup', 'business'
];

function scoreCommercialIntent(term, related = []) {
  const lowerTerm = term.toLowerCase();
  let score = 0;
  
  // Check main term
  for (const kw of COMMERCIAL_KEYWORDS) {
    if (lowerTerm.includes(kw)) score += 1;
  }
  
  // High-value keywords get extra points
  for (const kw of HIGH_VALUE_KEYWORDS) {
    if (lowerTerm.includes(kw)) score += 2;
  }
  
  // Related queries boost score
  for (const r of related) {
    const lowerR = r.toLowerCase();
    for (const kw of COMMERCIAL_KEYWORDS) {
      if (lowerR.includes(kw)) score += 0.5;
    }
  }
  
  return score;
}

function isCommercialIntent(term, related = []) {
  return scoreCommercialIntent(term, related) >= 2;
}

function buildFallbackTrends() {
  // Curated fallback based on current market trends
  const fallbackTerms = [
    { term: "AI agents for business", traffic: "200,000+", related: ["automation", "workflow"] },
    { term: "best SaaS deals 2026", traffic: "50,000+", related: ["pricing", "discount"] },
    { term: "remote work tools", traffic: "100,000+", related: ["productivity", "software"] },
    { term: "startup funding trends", traffic: "100,000+", related: ["venture capital", "investment"] },
    { term: "ChatGPT alternatives business", traffic: "500,000+", related: ["AI tools", "pricing"] },
  ];
  
  return fallbackTerms.map((t, i) => ({
    term: t.term,
    traffic: t.traffic,
    related: t.related,
    id: sha16(`trend-${t.term}-${new Date().toISOString().slice(0, 10)}`),
    collected_at: nowIso(),
    url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(t.term)}`,
    source: "google_trends",
    signal_type: "commercial_demand",
    signal: true,
    fallback: true,
    commercial_score: scoreCommercialIntent(t.term, t.related),
  }));
}

async function run({ maxItems = 10, minHours = 4, force = false } = {}) {
  const cache = loadCollectorCache("google_trends") || { last_run: null, seen_ids: [] };
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
  let degraded = false;
  
  try {
    // Try to scrape Google Trends trending page
    const trendsUrl = "https://trends.google.com/trending?geo=US";
    const { text, bytes: yb } = await fetchHtml(trendsUrl);
    bytes += yb;
    
    const trends = parseTrendingSearchesHtml(text);
    
    if (trends.length > 0) {
      // Successfully parsed trends from HTML
      for (const trend of trends.slice(0, maxItems)) {
        const commercialScore = scoreCommercialIntent(trend.term, trend.related);
        const hasCommercialIntent = commercialScore >= 2;
        
        const id = sha16(`trend-${trend.term}-${nowIso().slice(0, 10)}`);
        
        // Skip if seen
        if (cache.seen_ids?.includes(id)) continue;
        
        items.push({
          id,
          collected_at: nowIso(),
          url: `https://trends.google.com/trends/explore?q=${encodeURIComponent(trend.term)}`,
          title: `${trend.term} — ${trend.traffic || 'Trending'}`,
          description: `Google Trends: "${trend.term}"${trend.traffic ? ` (${trend.traffic})` : ''}. Commercial score: ${commercialScore}. Related: ${trend.related?.join(', ') || 'None'}.`,
          term: trend.term,
          traffic: trend.traffic,
          related: trend.related,
          commercial_score: commercialScore,
          signal_type: hasCommercialIntent ? "commercial_demand" : "general_trend",
          signal: hasCommercialIntent,
          source: "google_trends",
          tags: ["trends", hasCommercialIntent ? "commercial" : "general", "demand"],
          topics: ["market_demand", "trends", "commercial_intent"],
          bytes: 0,
        });
      }
    } else {
      // No trends parsed - use fallback
      degraded = true;
      const fallback = buildFallbackTrends();
      for (const item of fallback) {
        if (!cache.seen_ids?.includes(item.id)) {
          items.push({
            ...item,
            title: `${item.term} — Market Demand Signal`,
            description: `Commercial demand signal: "${item.term}" (${item.traffic}). Related: ${item.related?.join(', ') || 'None'}. Fallback data.`,
            tags: ["trends", "commercial", "demand", "fallback"],
            topics: ["market_demand", "trends"],
            bytes: 0,
          });
        }
      }
    }
    
    // Update cache
    cache.last_run = nowIso();
    cache.seen_ids = [...(cache.seen_ids || []).slice(-500), ...items.map(i => i.id)];
    saveCollectorCache("google_trends", cache);
    
    return {
      ok: true,
      success: true,
      eye: "google_trends",
      items,
      bytes,
      duration_ms: 0,
      requests: 1,
      cadence_hours: minHours,
      sample: items[0]?.term || null,
      degraded,
    };
    
  } catch (err) {
    // Return fallback on error
    degraded = true;
    const fallback = buildFallbackTrends();
    const fallbackItems = [];
    
    for (const item of fallback) {
      if (!cache.seen_ids?.includes(item.id)) {
        fallbackItems.push({
          ...item,
          title: `${item.term} — Market Demand Signal`,
          description: `Commercial demand signal: "${item.term}" (${item.traffic}). Fallback data (error: ${err.code || err.message}).`,
          tags: ["trends", "commercial", "demand", "fallback"],
          topics: ["market_demand", "trends"],
          bytes: 0,
        });
      }
    }
    
    return {
      ok: true,
      success: true,
      eye: "google_trends",
      items: fallbackItems,
      bytes,
      duration_ms: 0,
      requests: 1,
      cadence_hours: minHours,
      degraded: true,
      error: err.code || err.message,
      sample: fallbackItems[0]?.term || null,
    };
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const maxItems = Number(args.find(a => a.startsWith("--max="))?.split("=")[1] || 10);
  const minHours = Number(args.find(a => a.startsWith("--min-hours="))?.split("=")[1] || 4);
  const force = args.includes("--force");
  
  run({ maxItems, minHours, force }).then(r => {
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }).catch(e => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}

module.exports = { run };
