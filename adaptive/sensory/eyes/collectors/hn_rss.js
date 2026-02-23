/**
 * adaptive/sensory/eyes/collectors/hn_rss.js
 *
 * Deterministic HN RSS collector.
 * - Fetches RSS feed via hnrss.org (stable + simple)
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
        scope: "sensory.collector.hn_rss",
        caller: "adaptive/sensory/eyes/collectors/hn_rss",
        runtime_allowlist: [host],
        timeout_ms: timeoutMs,
        meta: { collector: "hn_rss" }
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
  // Minimal decode for common RSS cases (deterministic + tiny)
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
  // Very basic RSS item splitting (works for hnrss.org output)
  return String(rssXml).split(/<item>/i).slice(1).map((chunk) => chunk.split(/<\/item>/i)[0]);
}

function keywordTopics(title, configuredTopics = []) {
  const t = String(title || "").toLowerCase();
  const out = new Set();

  // Keep configured topics if present
  for (const ct of configuredTopics) out.add(ct);

  // Lightweight signals
  if (t.includes("agent")) out.add("ai_agents");
  if (t.includes("llm") || t.includes("gpt") || t.includes("transformer")) out.add("llm");
  if (t.includes("automation") || t.includes("workflow") || t.includes("orchestration")) out.add("automation");
  if (t.includes("tool") || t.includes("sdk") || t.includes("cli") || t.includes("library")) out.add("devtools");

  // Return up to 5 to keep payload small/deterministic
  return Array.from(out).slice(0, 5);
}

function candidateFeedUrls(eyeConfig) {
  const defaults = [
    "https://news.ycombinator.com/rss",
    "https://hnrss.org/frontpage",
    "https://hnrss.org/newest"
  ];
  const out = [];
  const parserOptions = eyeConfig && eyeConfig.parser_options && typeof eyeConfig.parser_options === "object"
    ? eyeConfig.parser_options
    : {};
  if (eyeConfig?.feed_url) out.push(String(eyeConfig.feed_url));
  if (Array.isArray(eyeConfig?.feed_candidates)) {
    for (const u of eyeConfig.feed_candidates) {
      if (!u) continue;
      out.push(String(u));
    }
  }
  if (parserOptions.feed_url) out.push(String(parserOptions.feed_url));
  if (Array.isArray(parserOptions.feed_urls)) {
    for (const u of parserOptions.feed_urls) {
      if (!u) continue;
      out.push(String(u));
    }
  }
  const explicit = Array.from(new Set(out.filter(Boolean)));
  if (explicit.length > 0) return explicit;
  return Array.from(new Set(defaults));
}

function preflightHnRss(eyeConfig, budgets) {
  const failures = [];
  const checks = [];
  const uniqueCandidates = candidateFeedUrls(eyeConfig);

  if (!uniqueCandidates.length) {
    failures.push({ code: "invalid_config", message: "No RSS feed candidates configured" });
  }

  const allowlist = Array.isArray(eyeConfig?.allowed_domains) ? eyeConfig.allowed_domains : [];
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
    parser_type: "hn_rss",
    checks,
    failures,
    candidates: uniqueCandidates
  };
}

async function collectHnRss(eyeConfig, budgets) {
  const started = Date.now();

  // Use configured feed_url first, fall back to candidates
  const pf = preflightHnRss(eyeConfig, budgets);
  if (!pf.ok) {
    const first = pf.failures[0] || {};
    throw makeCollectorError(
      String(first.code || "invalid_config"),
      `hn_rss_preflight_failed (${String(first.message || "unknown").slice(0, 160)})`,
      { failures: pf.failures.slice(0, 8) }
    );
  }
  const uniqueCandidates = Array.isArray(pf.candidates) ? pf.candidates : [];
  let text = "";
  let bytes = 0;
  const failures = [];
  for (const feedUrl of uniqueCandidates) {
    try {
      const r = await fetchText(feedUrl, Math.min(9000, (budgets?.max_seconds || 10) * 1000));
      text = r.text;
      bytes = r.bytes;
      break;
    } catch (e) {
      const c = classifyCollectorError(e);
      failures.push({
        url: feedUrl,
        code: c.code,
        error: c.message
      });
    }
  }
  if (!text) {
    const fallbackCodes = new Set([
      "dns_unreachable",
      "connection_refused",
      "connection_reset",
      "timeout",
      "tls_error",
      "network_error",
      "http_5xx",
      "rate_limited",
      "env_blocked"
    ]);
    const allFallbackEligible = failures.length > 0 && failures.every(f => fallbackCodes.has(String(f.code || "")));
    if (allFallbackEligible) {
      const cached = loadCollectorCache(eyeConfig && eyeConfig.id || "hn_frontpage");
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
    const dominantCode = failures.length > 0 && failures.every(f => f.code === failures[0].code)
      ? failures[0].code
      : "multi_fetch_failed";
    throw makeCollectorError(
      dominantCode,
      `hn_rss_fetch_failed (${detail || "no_attempts"})`,
      { attempts: failures.slice(0, 8) }
    );
  }

  const itemsRaw = splitItems(text);
  const maxItems = Math.max(1, Math.min(budgets?.max_items || 20, 50));

  const items = [];
  for (const it of itemsRaw.slice(0, maxItems)) {
    const title = extractTag(it, "title");
    const url = extractTag(it, "link");
    if (!title || !url) continue;

    const item_hash = sha16(url);
    items.push({
      collected_at: nowIso(),
      id: item_hash,
      url,
      title,
      topics: keywordTopics(title, Array.isArray(eyeConfig?.topics) ? eyeConfig.topics : []),
      bytes: Math.min(512, title.length + url.length + 64)
    });
  }

  const duration_ms = Date.now() - started;
  if (items.length > 0) {
    saveCollectorCache(eyeConfig && eyeConfig.id || "hn_frontpage", items);
  }
  return {
    success: true,
    items,
    duration_ms,
    requests: 1,
    bytes
  };
}

module.exports = { collectHnRss, preflightHnRss };
