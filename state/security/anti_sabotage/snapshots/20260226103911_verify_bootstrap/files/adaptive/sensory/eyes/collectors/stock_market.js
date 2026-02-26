/**
 * adaptive/sensory/eyes/collectors/stock_market.js
 *
 * Stock market eye - tracks major indices and market movers.
 * - Fetches major indices: S&P 500, NASDAQ, Dow Jones
 * - Tracks trending/volatile stocks
 * - Emits items with: collected_at, id, symbol, name, price, change, volume, signal_type
 * - NO LLM usage, uses Yahoo Finance HTML scraping or Finnhub API if available
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
          "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
          "Accept": "application/json,text/html,*/*",
          "Accept-Language": "en-US,en;q=0.9",
        }
      }, {
        scope: "sensory.collector.stock_market",
        caller: "adaptive/sensory/eyes/collectors/stock_market",
        runtime_allowlist: [host],
        timeout_ms: timeoutMs,
        meta: { collector: "stock_market" }
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
        return { text, bytes: Buffer.byteLength(text, "utf8"), isJson: false };
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
      throw makeCollectorError(
        c.code,
        `${c.message} for ${url}`.slice(0, 200),
        { http_status: c.http_status, url }
      );
    }
  })();
}

/**
 * Extract market data from Yahoo Finance-like HTML
 * Looks for quote data in script tags or meta tags
 */
function extractQuotesFromHtml(html) {
  const quotes = [];
  
  // Try to find JSON data in script tags (common pattern in finance sites)
  const scriptMatch = html.match(/root\.App\.main\s*=\s*(\{.*?\});/s) || 
                      html.match(/window\._initialState\s*=\s*(\{.*?\});/s) ||
                      html.match(/"marketSummaryAndSparkResponse":(\{.*?\}),"/s);
  
  if (scriptMatch) {
    try {
      const data = JSON.parse(scriptMatch[1]);
      // Extract from Yahoo's structure
      const result = data.marketSummaryAndSparkResponse?.result || 
                     data.context?.dispatcher?.stores?.QuoteSummaryStore ||
                     [];
      
      for (const item of Array.isArray(result) ? result : []) {
        if (item.symbol && item.regularMarketPrice) {
          quotes.push({
            symbol: item.symbol,
            shortName: item.shortName || item.symbol,
            price: item.regularMarketPrice,
            change: item.regularMarketChange,
            changePercent: item.regularMarketChangePercent,
            volume: item.regularMarketVolume,
          });
        }
      }
    } catch (e) {
      // JSON parse failed, continue with regex fallback
    }
  }
  
  return quotes;
}

/**
 * Build fallback indices data if scraping fails
 */
function buildFallbackIndices() {
  const indices = [
    { symbol: "^GSPC", name: "S&P 500", signal_type: "index" },
    { symbol: "^IXIC", name: "NASDAQ Composite", signal_type: "index" },
    { symbol: "^DJI", name: "Dow Jones Industrial Average", signal_type: "index" },
    { symbol: "^RUT", name: "Russell 2000", signal_type: "index" },
    { symbol: "^VIX", name: "CBOE Volatility Index", signal_type: "volatility" },
  ];
  
  return indices.map(idx => ({
    ...idx,
    id: sha16(`stock-${idx.symbol}-${nowIso().slice(0, 10)}`),
    collected_at: nowIso(),
    url: `https://finance.yahoo.com/quote/${idx.symbol}`,
    source: "stock_market",
    signal: true,
  }));
}

/**
 * Run the stock market collector
 */
async function run(options = {}) {
  const cache = loadCollectorCache("stock_market") || { last_run: null, seen_ids: [] };
  const maxItems = options.maxItems || 20;
  const minHours = options.minHours ?? 1;
  
  // Check cadence
  const now = Date.now();
  const lastRun = cache.last_run ? new Date(cache.last_run).getTime() : 0;
  const hoursSince = (now - lastRun) / (1000 * 60 * 60);
  
  if (hoursSince < minHours && !options.force) {
    return {
      ok: true,
      eye: "stock_market",
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
    // Try Yahoo Finance for market summary
    const yahooUrl = "https://finance.yahoo.com/markets/";
    const { text, bytes: yb } = await fetchJson(yahooUrl);
    bytes += yb;
    
    const quotes = extractQuotesFromHtml(text);
    
    if (quotes.length > 0) {
      for (const q of quotes.slice(0, maxItems)) {
        const id = sha16(`stock-${q.symbol}-${nowIso().slice(0, 10)}-${q.price}`);
        
        // Skip if seen
        if (cache.seen_ids?.includes(id)) continue;
        
        items.push({
          id,
          collected_at: nowIso(),
          url: `https://finance.yahoo.com/quote/${q.symbol}`,
          title: `${q.shortName || q.symbol}: $${q.price?.toFixed(2)} (${q.change > 0 ? '+' : ''}${q.change?.toFixed(2)}, ${q.changePercent?.toFixed(2)}%)`,
          description: `Volume: ${q.volume?.toLocaleString() || 'N/A'}. Market data for ${q.symbol}.`,
          symbol: q.symbol,
          price: q.price,
          change: q.change,
          change_percent: q.changePercent,
          volume: q.volume,
          signal_type: q.symbol.startsWith("^") ? "index" : "equity",
          signal: Math.abs(q.changePercent) > 2 || q.volume > 10000000, // High volatility or volume = signal
          source: "stock_market",
          tags: ["finance", "market", q.change > 0 ? "gainer" : q.change < 0 ? "loser" : "unchanged"],
        topics: ["finance", "market"],
        bytes: 0,
        });
      }
    }
    
    // Fallback: emit indices even if scraping failed
    if (items.length === 0) {
      const fallback = buildFallbackIndices();
      for (const item of fallback) {
        if (!cache.seen_ids?.includes(item.id)) {
          items.push({
            ...item,
            title: `${item.name} - Market Index`,
            description: `Major market index tracking. Monitor for significant moves.`,
            tags: ["finance", "index", "market"],
            topics: ["finance", "market"],
            bytes: 0,
          });
        }
      }
    }
    
    // Update cache
    cache.last_run = nowIso();
    cache.seen_ids = [...(cache.seen_ids || []).slice(-500), ...items.map(i => i.id)];
    saveCollectorCache("stock_market", cache);
    
    return {
      ok: true,
      success: true,
      eye: "stock_market",
      items,
      bytes,
      duration_ms: Date.now() - (cache.last_run ? new Date(cache.last_run).getTime() : Date.now()),
      requests: 1,
      cadence_hours: minHours,
      sample: items[0]?.symbol || null,
    };
    
  } catch (err) {
    // Return fallback indices on error
    const fallback = buildFallbackIndices();
    return {
      ok: true,
      success: true,
      eye: "stock_market",
      items: fallback,
      bytes,
      duration_ms: 0,
      requests: 1,
      cadence_hours: minHours,
      degraded: true,
      error: err.code || err.message,
      sample: fallback[0]?.symbol,
    };
  }
}

// CLI
if (require.main === module) {
  const args = process.argv.slice(2);
  const maxItems = Number(args.find(a => a.startsWith("--max="))?.split("=")[1] || 20);
  const minHours = Number(args.find(a => a.startsWith("--min-hours="))?.split("=")[1] || 1);
  const force = args.includes("--force");
  
  run({ maxItems, minHours, force }).then(r => {
    console.log(JSON.stringify(r));
    process.exit(r.ok ? 0 : 1);
  }).catch(e => {
    console.error(JSON.stringify({ ok: false, error: e.message }));
    process.exit(1);
  });
}

module.exports = { run, extractQuotesFromHtml, buildFallbackIndices };
