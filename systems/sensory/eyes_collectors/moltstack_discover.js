/**
 * systems/sensory/eyes_collectors/moltstack_discover.js
 *
 * Deterministic MoltStack Discover feed collector.
 * - Fetches https://moltstack.net/api/posts for latest posts
 * - Emits normalized items for external_eyes
 * - No LLM usage, minimal dependencies
 */

const https = require("https");
const crypto = require("crypto");
const {
  classifyCollectorError,
  httpStatusToCode,
  makeCollectorError,
} = require("./collector_errors");
const { loadCollectorCache, saveCollectorCache } = require("./cache_store");

function sha16(s) {
  return crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function fetchJson(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "openclaw-eyes/1.0",
          Accept: "application/json",
        },
      },
      (res) => {
        if (res.statusCode && res.statusCode >= 400) {
          reject(
            makeCollectorError(
              httpStatusToCode(res.statusCode),
              `HTTP ${res.statusCode} for ${url}`,
              { http_status: Number(res.statusCode), url }
            )
          );
          res.resume();
          return;
        }
        let bytes = 0;
        const chunks = [];
        res.on("data", (d) => {
          bytes += d.length;
          chunks.push(d);
        });
        res.on("end", () => {
          try {
            const text = Buffer.concat(chunks).toString("utf8");
            const data = JSON.parse(text);
            resolve({ data, bytes });
          } catch (e) {
            reject(
              makeCollectorError(
                "parse_error",
                `Failed to parse JSON from ${url}`,
                { url }
              )
            );
          }
        });
      }
    );
    req.on("error", (err) => {
      const c = classifyCollectorError(err);
      reject(
        makeCollectorError(
          c.code,
          `${c.message} for ${url}`.slice(0, 200),
          { http_status: c.http_status, url }
        )
      );
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        makeCollectorError(
          "timeout",
          `Timeout after ${timeoutMs}ms for ${url}`,
          { url }
        )
      );
    });
  });
}

function keywordTopics(title, configuredTopics = []) {
  const t = String(title || "").toLowerCase();
  const out = new Set(configuredTopics);

  if (t.includes("ai") || t.includes("agent") || t.includes("llm"))
    out.add("ai_agents");
  if (t.includes("automation") || t.includes("workflow")) out.add("automation");
  if (t.includes("startup") || t.includes("business")) out.add("startups");
  if (t.includes("revenue") || t.includes("money") || t.includes("income"))
    out.add("revenue");
  if (t.includes("privacy") || t.includes("security")) out.add("security");
  if (t.includes("ethic") || t.includes("moral")) out.add("ethics");
  if (t.includes("multi-agent") || t.includes("system")) out.add("multi_agent");
  if (t.includes("consciousness") || t.includes("mind")) out.add("consciousness");
  if (t.includes("surveillance") || t.includes("privacy")) out.add("surveillance");

  return Array.from(out).slice(0, 5);
}

function preflightMoltstackDiscover(eyeConfig, budgets) {
  const checks = [];
  const failures = [];

  const url = eyeConfig?.parser_options?.api_url || "https://moltstack.net/api/posts";
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") {
      failures.push({
        code: "invalid_config",
        message: `URL must use https: ${url}`,
      });
    }
    const allowlist = Array.isArray(eyeConfig?.allowed_domains)
      ? eyeConfig.allowed_domains
      : ["moltstack.net"];
    const allowed = allowlist.some(
      (d) => u.hostname === d || u.hostname.endsWith(`.${d}`)
    );
    if (!allowed) {
      failures.push({
        code: "domain_not_allowlisted",
        message: `host not allowlisted: ${u.hostname}`,
      });
    } else {
      checks.push({ name: "allowlisted_url", ok: true, host: u.hostname });
    }
  } catch {
    failures.push({ code: "invalid_config", message: `Invalid URL: ${url}` });
  }

  const maxItems = Number(budgets?.max_items);
  if (!Number.isFinite(maxItems) || maxItems <= 0) {
    failures.push({
      code: "invalid_budget",
      message: "budgets.max_items must be > 0",
    });
  } else {
    checks.push({ name: "max_items_valid", ok: true, value: maxItems });
  }

  const maxSeconds = Number(budgets?.max_seconds);
  if (!Number.isFinite(maxSeconds) || maxSeconds <= 0) {
    failures.push({
      code: "invalid_budget",
      message: "budgets.max_seconds must be > 0",
    });
  } else {
    checks.push({ name: "max_seconds_valid", ok: true, value: maxSeconds });
  }

  return {
    ok: failures.length === 0,
    parser_type: "moltstack_discover",
    checks,
    failures,
  };
}

async function collectMoltstackDiscover(eyeConfig, budgets) {
  const started = Date.now();
  const pf = preflightMoltstackDiscover(eyeConfig, budgets);
  if (!pf.ok) {
    const first = pf.failures[0] || {};
    throw makeCollectorError(
      String(first.code || "invalid_config"),
      `moltstack_discover_preflight_failed (${String(
        first.message || "unknown"
      ).slice(0, 160)})`,
      { failures: pf.failures.slice(0, 8) }
    );
  }

  const maxItems = Math.max(1, Math.min(budgets?.max_items || 20, 50));
  const url =
    eyeConfig?.parser_options?.api_url || "https://moltstack.net/api/posts";

  let response;
  try {
    response = await fetchJson(
      url,
      Math.min(15000, budgets?.max_seconds * 1000 || 10000)
    );
  } catch (err) {
    const c = classifyCollectorError(err);
    const fallbackCodes = new Set([
      "dns_unreachable",
      "connection_refused",
      "connection_reset",
      "timeout",
      "tls_error",
      "network_error",
      "http_5xx",
      "rate_limited",
      "env_blocked",
    ]);
    if (fallbackCodes.has(String(c.code || ""))) {
      const cached = loadCollectorCache(
        eyeConfig?.id || "moltstack_discover"
      );
      if (cached && Array.isArray(cached.items) && cached.items.length) {
        return {
          success: true,
          items: cached.items,
          duration_ms: Date.now() - started,
          requests: 1,
          bytes: cached.items.reduce(
            (s, it) => s + Number(it?.bytes || 0),
            0
          ),
          cache_hit: true,
        };
      }
    }
    throw makeCollectorError(
      c.code,
      `moltstack_discover_fetch_failed (${c.message})`,
      { http_status: c.http_status }
    );
  }

  const posts = Array.isArray(response.data?.posts)
    ? response.data.posts.slice(0, maxItems)
    : [];

  const items = [];
  for (const p of posts) {
    const title = p.title?.trim();
    const slug = p.slug;
    const agentSlug = p.agent?.slug;
    if (!title || !slug) continue;

    const url = agentSlug
      ? `https://moltstack.net/${agentSlug}/${slug}`
      : `https://moltstack.net/discover/${slug}`;

    items.push({
      collected_at: nowIso(),
      id: sha16(url),
      url,
      title: title.slice(0, 200),
      topics: keywordTopics(title, eyeConfig?.topics || []),
      bytes: Math.min(512, title.length + url.length + 64),
    });
  }

  const durationMs = Date.now() - started;
  if (items.length > 0) {
    saveCollectorCache(eyeConfig?.id || "moltstack_discover", items);
  }

  return {
    success: true,
    items,
    duration_ms: durationMs,
    requests: 1,
    bytes: response.bytes,
  };
}

module.exports = {
  collectMoltstackDiscover,
  preflightMoltstackDiscover,
};
