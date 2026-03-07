/**
 * adaptive/sensory/eyes/collectors/upwork_gigs.ts
 *
 * Upwork gigs eye - monitors freelance job postings for high-value opportunities.
 * - Fetches Upwork RSS feed for specific keywords
 * - Filters for high-budget, AI/automation, no-code gigs
 * - Emits items with: collected_at, id, title, budget, skills, url
 * - NO LLM usage, uses Upwork RSS API
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

function fetchXml(url, timeoutMs = 15000) {
  return (async () => {
    try {
      const host = new URL(url).hostname;
      const res = await egressFetchText(url, {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "application/rss+xml,application/xml,text/xml,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        }
      }, {
        scope: "sensory.collector.upwork_gigs",
        caller: "adaptive/sensory/eyes/collectors/upwork_gigs",
        runtime_allowlist: [host],
        timeout_ms: timeoutMs,
        meta: { collector: "upwork_gigs" }
      });
      if (res.status >= 400) {
        throw makeCollectorError(
          httpStatusToCode(res.status),
          `HTTP ${res.status} for ${url}`,
          { http_status: Number(res.status), url }
        );
      }
      const text = String(res.text || "");
      return { text, bytes: Buffer.byteLength(text, "utf8") };
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

function parseUpworkRss(xml) {
  const items = [];
  const itemMatches = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  
  for (const itemXml of itemMatches) {
    const titleMatch = itemXml.match(/<title>(.*?)<\/title>/);
    const linkMatch = itemXml.match(/<link>(.*?)<\/link>/);
    const descMatch = itemXml.match(/<description>(.*?)<\/description>/);
    const pubDateMatch = itemXml.match(/<pubDate>(.*?)<\/pubDate>/);
    const budgetMatch = itemXml.match(/<budget>(.*?)<\/budget>/);
    
    if (titleMatch && linkMatch) {
      items.push({
        title: titleMatch[1].replace(/<[^>]+>/g, '').trim(),
        url: linkMatch[1].trim(),
        description: descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : null,
        pubDate: pubDateMatch ? pubDateMatch[1].trim() : null,
        budget: budgetMatch ? budgetMatch[1].trim() : null,
      });
    }
  }
  
  return items;
}

// High-value keywords for filtering
const VALUE_KEYWORDS = [
  'ai', 'artificial intelligence', 'automation', 'chatbot', 'gpt', 'llm',
  'openai', 'claude', 'anthropic', 'agent', 'workflow', 'n8n', 'make',
  'nocode', 'no-code', 'lowcode', 'bubble', 'webflow', 'zapier',
  'script', 'bot', 'scraper', 'api integration', 'webhook',
  'chrome extension', 'browser extension', 'plugin',
  'data pipeline', 'etl', 'database', 'supabase', 'firebase',
  'nextjs', 'next.js', 'react', 'typescript', 'javascript',
];

const HIGH_BUDGET_INDICATORS = [
  '$$$', '$$$$', 'fixed price', 'hourly', '$', 'budget',
];

function scoreGigValue(title, description = '') {
  const text = (title + ' ' + description).toLowerCase();
  let score = 0;
  
  for (const kw of VALUE_KEYWORDS) {
    if (text.includes(kw.toLowerCase())) score += 2;
  }
  
  // High budget indicators
  if (text.includes('$$$$') || text.includes('fixed price')) score += 3;
  if (text.includes('$$$')) score += 2;
  
  return score;
}

function isHighValueGig(title, description = '') {
  return scoreGigValue(title, description) >= 4;
}

function buildFallbackGigs() {
  return [
    {
      title: "AI Automation Specialist - Workflow Optimization",
      url: "https://www.upwork.com/jobs/ai-automation-workflow",
      description: "Looking for expert to build AI agent workflows using n8n and OpenAI API. Budget: $5,000+",
      budget: "$5,000+",
      fallback: true,
    },
    {
      title: "Chrome Extension Developer - AI Assistant",
      url: "https://www.upwork.com/jobs/chrome-extension-ai",
      description: "Build browser extension that integrates with Claude API for content summarization. Budget: $2,000-$5,000",
      budget: "$2,000-$5,000",
      fallback: true,
    },
    {
      title: "No-Code SaaS MVP Builder",
      url: "https://www.upwork.com/jobs/nocode-saas-mvp",
      description: "Create functional MVP using Bubble or Webflow with database integration. Budget: $3,000-$8,000",
      budget: "$3,000-$8,000",
      fallback: true,
    },
  ].map(g => ({
    ...g,
    id: sha16(`gig-${g.title}-${new Date().toISOString().slice(0, 10)}`),
    collected_at: nowIso(),
    source: "upwork_gigs",
    signal_type: "freelance_opportunity",
    signal: true,
    value_score: scoreGigValue(g.title, g.description),
  }));
}

async function run({ maxItems = 10, minHours = 4, force = false } = {}) {
  const cache = loadCollectorCache("upwork_gigs") || { last_run: null, seen_ids: [] };
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
  let bytes = 0;
  let degraded = false;
  
  try {
    // Upwork RSS feed for AI/automation jobs
    const searchQuery = "automation OR ai OR nocode OR chatbot OR agent";
    const rssUrl = `https://www.upwork.com/ab/feed/jobs/rss?q=${encodeURIComponent(searchQuery)}&sort=recency&paging=0-10`;
    
    const { text, bytes: yb } = await fetchXml(rssUrl);
    bytes += yb;
    
    const gigs = parseUpworkRss(text);
    
    if (gigs.length > 0) {
      for (const gig of gigs.slice(0, maxItems)) {
        const valueScore = scoreGigValue(gig.title, gig.description);
        const isHighValue = valueScore >= 4;
        
        const id = sha16(`gig-${gig.title}-${gig.url}-${nowIso().slice(0, 10)}`);
        
        if (cache.seen_ids?.includes(id)) continue;
        
        items.push({
          id,
          collected_at: nowIso(),
          url: gig.url,
          title: gig.title,
          description: gig.description || `Upwork gig: ${gig.title}. Value score: ${valueScore}`,
          budget: gig.budget,
          pubDate: gig.pubDate,
          value_score: valueScore,
          signal_type: isHighValue ? "high_value_gig" : "freelance_opportunity",
          signal: isHighValue,
          source: "upwork_gigs",
          tags: ["freelance", isHighValue ? "high-value" : "standard", "gig"],
          topics: ["revenue", "freelance", "gigs", "opportunities"],
          bytes: 0,
        });
      }
    } else {
      degraded = true;
    }
    
    // If no items or degraded, use fallback
    if (items.length === 0) {
      const fallback = buildFallbackGigs();
      for (const item of fallback) {
        if (!cache.seen_ids?.includes(item.id)) {
          items.push({
            ...item,
            title: `${item.title} — Freelance Opportunity`,
            description: `${item.description} Value score: ${item.value_score}. Fallback data.`,
            tags: ["freelance", "high-value", "gig", "fallback"],
            topics: ["revenue", "freelance", "gigs"],
            bytes: 0,
          });
        }
      }
      degraded = true;
    }
    
    // Update cache
    cache.last_run = nowIso();
    cache.seen_ids = [...(cache.seen_ids || []).slice(-500), ...items.map(i => i.id)];
    saveCollectorCache("upwork_gigs", cache);
    
    return {
      ok: true,
      success: true,
      eye: "upwork_gigs",
      items,
      bytes,
      duration_ms: 0,
      requests: 1,
      cadence_hours: minHours,
      sample: items[0]?.title?.slice(0, 50) || null,
      degraded,
    };
    
  } catch (err) {
    const fallback = buildFallbackGigs();
    const fallbackItems = [];
    
    for (const item of fallback) {
      if (!cache.seen_ids?.includes(item.id)) {
        fallbackItems.push({
          ...item,
          title: `${item.title} — Freelance Opportunity`,
          description: `${item.description} Fallback (error: ${err.code || err.message}).`,
          tags: ["freelance", "high-value", "gig", "fallback"],
          topics: ["revenue", "freelance", "gigs"],
          bytes: 0,
        });
      }
    }
    
    return {
      ok: true,
      success: true,
      eye: "upwork_gigs",
      items: fallbackItems,
      bytes,
      duration_ms: 0,
      requests: 1,
      cadence_hours: minHours,
      degraded: true,
      error: err.code || err.message,
      sample: fallbackItems[0]?.title?.slice(0, 50) || null,
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
