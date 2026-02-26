/**
 * adaptive/sensory/eyes/collectors/moltbook_hot.js
 *
 * Deterministic Moltbook hot feed collector.
 * - Uses skill API wrapper for schema safety
 * - Emits normalized items for external_eyes
 * - No LLM usage
 */

const crypto = require('crypto');
const { moltbook_getHotPosts } = require('../../../../skills/moltbook/moltbook_api');
const { issueSecretHandle, loadSecretById } = require('../../../../lib/secret_broker');
const { classifyCollectorError, makeCollectorError } = require('./collector_errors');
const { loadCollectorCache, saveCollectorCache } = require('./cache_store');

function sha16(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 16);
}

function nowIso() {
  return new Date().toISOString();
}

function issueMoltbookApiHandle() {
  const res = issueSecretHandle({
    secret_id: 'moltbook_api_key',
    scope: 'sensory.collector.moltbook_hot',
    caller: 'adaptive/sensory/eyes/collectors/moltbook_hot',
    ttl_sec: 300,
    reason: 'collector_fetch'
  });
  return res && res.ok ? String(res.handle || '') : '';
}

function normalizePosts(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.posts)) return payload.posts;
  if (payload && payload.data && Array.isArray(payload.data.posts)) return payload.data.posts;
  return [];
}

function extractPostId(p) {
  if (!p || typeof p !== 'object') return null;
  if (typeof p.id === 'string') return p.id;
  if (typeof p.post_id === 'string') return p.post_id;
  return null;
}

function extractUrl(p) {
  if (!p || typeof p !== 'object') return '';
  if (typeof p.url === 'string' && p.url.trim()) return p.url.trim();
  const id = extractPostId(p);
  return id ? `https://www.moltbook.com/p/${id}` : '';
}

function text(v) {
  return String(v == null ? '' : v).trim();
}

function preflightMoltbookHot(eyeConfig, budgets) {
  const checks = [];
  const failures = [];

  const secret = loadSecretById('moltbook_api_key');
  if (!secret || secret.ok !== true) {
    failures.push({ code: 'auth_missing', message: 'missing_moltbook_api_key' });
  } else {
    checks.push({ name: 'api_key_handle_issued', ok: true });
  }

  const maxItems = Number(budgets && budgets.max_items);
  if (!Number.isFinite(maxItems) || maxItems <= 0) {
    failures.push({ code: 'invalid_budget', message: 'budgets.max_items must be > 0' });
  } else {
    checks.push({ name: 'max_items_valid', ok: true, value: maxItems });
  }

  const allowlist = Array.isArray(eyeConfig && eyeConfig.allowed_domains) ? eyeConfig.allowed_domains : [];
  const host = 'www.moltbook.com';
  const allowed = allowlist.some(d => host === d || host.endsWith(`.${d}`));
  if (!allowed) {
    failures.push({ code: 'domain_not_allowlisted', message: `collector host not allowlisted: ${host}` });
  } else {
    checks.push({ name: 'allowlisted_host', ok: true, host });
  }

  return {
    ok: failures.length === 0,
    parser_type: 'moltbook_hot',
    checks,
    failures
  };
}

async function collectMoltbookHot(eyeConfig, budgets) {
  const started = Date.now();
  const pf = preflightMoltbookHot(eyeConfig, budgets);
  if (!pf.ok) {
    const first = pf.failures[0] || {};
    throw makeCollectorError(
      String(first.code || 'collector_preflight_failed'),
      `moltbook_hot_preflight_failed (${String(first.message || 'unknown').slice(0, 160)})`,
      { failures: pf.failures.slice(0, 8) }
    );
  }

  const maxItems = Math.max(1, Math.min(Number(budgets && budgets.max_items || 20), 50));
  let payload;
  try {
    const apiKeyHandle = issueMoltbookApiHandle();
    payload = await moltbook_getHotPosts(maxItems, {
      apiKeyHandle,
      scope: 'sensory.collector.moltbook_hot',
      caller: 'adaptive/sensory/eyes/collectors/moltbook_hot'
    });
  } catch (err) {
    const c = classifyCollectorError(err);
    const fallbackCodes = new Set([
      'dns_unreachable',
      'connection_refused',
      'connection_reset',
      'timeout',
      'tls_error',
      'network_error',
      'http_5xx',
      'rate_limited',
      'env_blocked'
    ]);
    if (fallbackCodes.has(String(c.code || ''))) {
      const cached = loadCollectorCache(eyeConfig && eyeConfig.id || 'moltbook_feed');
      if (cached && Array.isArray(cached.items) && cached.items.length) {
        return {
          success: true,
          items: cached.items,
          duration_ms: Date.now() - started,
          requests: 1,
          bytes: cached.items.reduce((s, it) => s + Number((it && it.bytes) || 0), 0),
          cache_hit: true
        };
      }
    }
    throw makeCollectorError(
      c.code,
      `moltbook_hot_fetch_failed (${c.message})`,
      { http_status: c.http_status }
    );
  }
  const posts = normalizePosts(payload).slice(0, maxItems);

  const items = [];
  for (const p of posts) {
    const title = text(p && p.title);
    const url = extractUrl(p);
    if (!title || !url) continue;
    const id = extractPostId(p) || sha16(url);
    items.push({
      collected_at: nowIso(),
      id: String(id),
      url,
      title: title.slice(0, 200),
      topics: Array.isArray(eyeConfig && eyeConfig.topics) ? eyeConfig.topics.slice(0, 5) : [],
      bytes: Math.min(1024, title.length + url.length + 64)
    });
  }

  const durationMs = Date.now() - started;
  if (items.length > 0) {
    saveCollectorCache(eyeConfig && eyeConfig.id || 'moltbook_feed', items);
  }
  return {
    success: true,
    items,
    duration_ms: durationMs,
    requests: 1,
    bytes: items.reduce((s, i) => s + Number(i.bytes || 0), 0)
  };
}

module.exports = { collectMoltbookHot, preflightMoltbookHot };
