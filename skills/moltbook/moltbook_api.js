// skills/moltbook/moltbook_api.js
// Core Moltbook functions for agent automation

const DEFAULT_API_BASES = ['https://www.moltbook.com/api/v1', 'https://api.moltbook.com/api/v1'];
const getAuthHeader = (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey });

function clip(v, n = 220) {
  return String(v == null ? '' : v).slice(0, n);
}

class MoltbookApiError extends Error {
  constructor(message, {
    status = 0,
    method = '',
    path = '',
    base = '',
    payload = null,
    code = 'API_ERROR',
    cause_code = ''
  } = {}) {
    super(message);
    this.name = 'MoltbookApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.base = base;
    this.payload = payload;
    this.code = code;
    this.cause_code = cause_code;
  }
}

async function parseBodySafe(res) {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: clip(text, 500) };
  }
}

function assertAuth(apiKey) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new MoltbookApiError('Missing apiKey', { code: 'AUTH_MISSING' });
  }
}

function parseErrorMessage(payload, status, fallback) {
  if (payload && typeof payload === 'object') {
    const msg = payload.message;
    if (Array.isArray(msg)) return clip(msg.join('; '), 400);
    if (typeof msg === 'string') return clip(msg, 400);
    if (typeof payload.error === 'string') return clip(payload.error, 400);
  }
  return `${fallback} (${status})`;
}

function resolveApiBases() {
  const raw = String(process.env.MOLTBOOK_API_BASES || '').trim();
  if (!raw) return DEFAULT_API_BASES.slice();
  const parsed = raw
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  return parsed.length ? parsed : DEFAULT_API_BASES.slice();
}

function httpStatusCode(status) {
  const s = Number(status || 0);
  if (!Number.isFinite(s) || s <= 0) return 'HTTP_ERROR';
  if (s === 401) return 'AUTH_UNAUTHORIZED';
  if (s === 403) return 'AUTH_FORBIDDEN';
  if (s === 404) return 'ENDPOINT_UNSUPPORTED';
  if (s === 408) return 'TIMEOUT';
  if (s === 429) return 'RATE_LIMITED';
  if (s >= 500) return 'HTTP_5XX';
  if (s >= 400) return 'HTTP_4XX';
  return 'HTTP_ERROR';
}

function networkCauseCode(err) {
  const causeCode = String((err && err.cause && err.cause.code) || err && err.code || '').toUpperCase();
  const message = String((err && err.message) || '').toLowerCase();
  if (causeCode === 'ENOTFOUND' || causeCode === 'EAI_AGAIN' || message.includes('getaddrinfo')) return 'DNS_UNREACHABLE';
  if (causeCode === 'ECONNREFUSED' || causeCode === 'EPERM' || message.includes('connection refused')) return 'CONNECTION_REFUSED';
  if (causeCode === 'ECONNRESET') return 'CONNECTION_RESET';
  if (causeCode === 'ETIMEDOUT' || causeCode === 'ESOCKETTIMEDOUT' || message.includes('timeout')) return 'TIMEOUT';
  if (message.includes('ssl') || message.includes('tls') || message.includes('certificate')) return 'TLS_ERROR';
  return 'NETWORK_ERROR';
}

async function request(path, { method = 'GET', apiKey, body } = {}) {
  assertAuth(apiKey);
  const bases = resolveApiBases();
  const allowFailover = String(method || 'GET').toUpperCase() === 'GET';
  let lastErr = null;

  for (let i = 0; i < bases.length; i++) {
    const base = bases[i];
    let res;
    try {
      res = await fetch(`${base}${path}`, {
        method,
        headers: body == null
          ? getAuthHeader(apiKey)
          : { ...getAuthHeader(apiKey), 'Content-Type': 'application/json' },
        body: body == null ? undefined : JSON.stringify(body)
      });
    } catch (err) {
      const code = networkCauseCode(err);
      const causeCode = String((err && err.cause && err.cause.code) || err && err.code || '').toUpperCase();
      lastErr = new MoltbookApiError(
        `${method} ${path} failed (network): ${clip(err && err.message, 240) || 'fetch failed'}`,
        { method, path, base, code, cause_code: causeCode }
      );
      if (allowFailover && i < bases.length - 1) continue;
      throw lastErr;
    }

    const payload = await parseBodySafe(res);
    if (!res.ok) {
      const msg = parseErrorMessage(payload, res.status, `${method} ${path} failed`);
      const code = httpStatusCode(res.status);
      lastErr = new MoltbookApiError(
        `${method} ${path} failed (${res.status}): ${msg}`,
        { status: res.status, method, path, base, payload, code }
      );
      const failoverEligible = allowFailover && (
        code === 'ENDPOINT_UNSUPPORTED' ||
        code === 'HTTP_5XX' ||
        code === 'TIMEOUT'
      );
      if (failoverEligible && i < bases.length - 1) continue;
      throw lastErr;
    }
    return payload;
  }

  if (lastErr) throw lastErr;
  throw new MoltbookApiError(`${method} ${path} failed (no_api_base_available)`, {
    method,
    path,
    code: 'NETWORK_ERROR'
  });
}

function normalizePostsPayload(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.posts)) return payload.posts;
  if (payload && payload.data && Array.isArray(payload.data.posts)) return payload.data.posts;
  return null;
}

function assertPostsPayload(payload, path) {
  const posts = normalizePostsPayload(payload);
  if (!posts) {
    throw new MoltbookApiError(`Unexpected posts response schema from ${path}`, {
      status: 200,
      method: 'GET',
      path,
      payload,
      code: 'SCHEMA_ERROR'
    });
  }
  return posts;
}

async function moltbook_getHotPosts(limit = 5, apiKey) {
  const n = Number(limit) || 5;
  const candidates = [
    `/posts?sort=hot&limit=${n}`,
    `/posts?sort=new&limit=${n}`
  ];
  let lastErr = null;
  for (const p of candidates) {
    try {
      const payload = await request(p, { method: 'GET', apiKey });
      assertPostsPayload(payload, p);
      return payload;
    } catch (err) {
      lastErr = err;
      if (!(err instanceof MoltbookApiError)) throw err;
      if (err.code !== 'ENDPOINT_UNSUPPORTED' && err.code !== 'HTTP_5XX') throw err;
    }
  }
  if (lastErr) throw lastErr;
  throw new MoltbookApiError('Unable to fetch Moltbook posts', { code: 'HTTP_ERROR', method: 'GET', path: '/posts' });
}

async function moltbook_upvotePost(postId, apiKey) {
  if (!postId) throw new Error('Missing postId');
  const payload = await request(`/posts/${postId}/upvote`, { method: 'POST', apiKey });
  if (!payload || typeof payload !== 'object') {
    throw new MoltbookApiError('Unexpected upvote response schema', { code: 'SCHEMA_ERROR' });
  }
  return payload;
}

async function moltbook_comment(postId, text, apiKey) {
  if (!postId) throw new Error('Missing postId');
  if (!text || typeof text !== 'string') throw new Error('Missing comment text');
  const payload = await request(`/posts/${postId}/comments`, {
    method: 'POST',
    apiKey,
    body: { text }
  });
  if (!payload || typeof payload !== 'object') {
    throw new MoltbookApiError('Unexpected comment response schema', { code: 'SCHEMA_ERROR' });
  }
  return payload;
}

function extractPostId(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.id === 'string') return payload.id;
  if (typeof payload.post_id === 'string') return payload.post_id;
  if (payload.post && typeof payload.post.id === 'string') return payload.post.id;
  if (payload.data && typeof payload.data.id === 'string') return payload.data.id;
  if (payload.data && payload.data.post && typeof payload.data.post.id === 'string') return payload.data.post.id;
  return null;
}

function extractPostSlug(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (typeof payload.slug === 'string') return payload.slug;
  if (payload.post && typeof payload.post.slug === 'string') return payload.post.slug;
  if (payload.data && typeof payload.data.slug === 'string') return payload.data.slug;
  if (payload.data && payload.data.post && typeof payload.data.post.slug === 'string') return payload.data.post.slug;
  return null;
}

function buildPostUrl(post) {
  const slug = extractPostSlug(post);
  if (slug) return `https://www.moltbook.com/p/${slug}`;
  const postId = extractPostId(post);
  if (postId) return `https://www.moltbook.com/p/${postId}`;
  return null;
}

function fieldText(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function samePostByContent(candidate, title, content) {
  const ct = fieldText(candidate && candidate.title);
  const cc = fieldText((candidate && (candidate.content || candidate.body)) || '');
  const t = fieldText(title);
  const c = fieldText(content);
  if (!ct && !cc) return false;
  const titleMatch = t && ct === t;
  const contentMatch = c && (cc === c || cc.includes(c.slice(0, 40)));
  return titleMatch || (titleMatch && contentMatch) || contentMatch;
}

const NUMBER_WORDS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19, twenty: 20, thirty: 30, forty: 40, fifty: 50,
  sixty: 60, seventy: 70, eighty: 80, ninety: 90
};

function parseWordNumber(token) {
  const cleaned = String(token || '').toLowerCase().replace(/[^a-z -]/g, ' ').trim();
  if (!cleaned) return null;
  if (Object.prototype.hasOwnProperty.call(NUMBER_WORDS, cleaned)) return NUMBER_WORDS[cleaned];
  const parts = cleaned.split(/[\s-]+/).filter(Boolean);
  if (parts.length === 2 && NUMBER_WORDS[parts[0]] >= 20 && NUMBER_WORDS[parts[1]] < 10) {
    return NUMBER_WORDS[parts[0]] + NUMBER_WORDS[parts[1]];
  }
  return null;
}

function inferOperator(challengeText) {
  const t = String(challengeText || '').toLowerCase();
  if (t.includes('+') || t.includes(' plus ') || t.includes(' add ')) return '+';
  if (t.includes('-') || t.includes(' minus ') || t.includes(' subtract ')) return '-';
  if (t.includes('*') || t.includes(' x ') || t.includes(' times ') || t.includes(' multiply ')) return '*';
  if (t.includes('/') || t.includes(' divide ') || t.includes(' divided by ')) return '/';
  return null;
}

function solveVerificationChallenge(challengeText) {
  const text = String(challengeText || '');
  if (!text.trim()) throw new MoltbookApiError('Verification challenge missing', { code: 'VERIFICATION_PARSE_ERROR' });

  const nums = [];
  const numericMatches = text.match(/-?\d+(?:\.\d+)?/g) || [];
  for (const n of numericMatches) nums.push(Number(n));

  if (nums.length < 2) {
    const wordMatches = text.toLowerCase().match(/\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\s](?:one|two|three|four|five|six|seven|eight|nine))?\b/g) || [];
    for (const w of wordMatches) {
      const parsed = parseWordNumber(w);
      if (typeof parsed === 'number' && Number.isFinite(parsed)) nums.push(parsed);
    }
  }

  if (nums.length < 2) {
    throw new MoltbookApiError(`Unable to parse verification numbers: ${clip(text, 140)}`, { code: 'VERIFICATION_PARSE_ERROR' });
  }

  const op = inferOperator(text) || '+';
  let result;
  if (op === '+') result = nums[0] + nums[1];
  else if (op === '-') result = nums[0] - nums[1];
  else if (op === '*') result = nums[0] * nums[1];
  else if (op === '/') result = nums[1] === 0 ? NaN : nums[0] / nums[1];
  else result = NaN;

  if (!Number.isFinite(result)) {
    throw new MoltbookApiError(`Unable to compute verification answer: ${clip(text, 140)}`, { code: 'VERIFICATION_PARSE_ERROR' });
  }

  return result.toFixed(2);
}

function extractVerification(payload) {
  if (!payload || typeof payload !== 'object') return null;
  if (payload.verification && typeof payload.verification === 'object') return payload.verification;
  if (payload.post && payload.post.verification && typeof payload.post.verification === 'object') return payload.post.verification;
  if (payload.data && payload.data.verification && typeof payload.data.verification === 'object') return payload.data.verification;
  if (payload.data && payload.data.post && payload.data.post.verification && typeof payload.data.post.verification === 'object') return payload.data.post.verification;
  return null;
}

async function completeVerificationIfPresent(createdPayload, apiKey) {
  const verification = extractVerification(createdPayload);
  if (!verification) return { needed: false, verified: true, method: 'not_required' };

  const verificationCode = verification.verification_code || verification.code || null;
  const challengeText = verification.challenge_text || verification.challenge || '';
  if (!verificationCode) {
    throw new MoltbookApiError('Verification code missing from create response', { code: 'VERIFICATION_MISSING_CODE' });
  }

  const answer = solveVerificationChallenge(challengeText);
  await request('/verify', {
    method: 'POST',
    apiKey,
    body: {
      verification_code: verificationCode,
      answer
    }
  });
  return { needed: true, verified: true, method: 'challenge_verify', answer_format: 'fixed_2' };
}

async function verifyCreatedPost(postPayload, { title, content, apiKey }) {
  const postId = extractPostId(postPayload);

  if (postId) {
    try {
      const fetched = await request(`/posts/${postId}`, { method: 'GET', apiKey });
      const post = fetched && fetched.post ? fetched.post : fetched;
      if (samePostByContent(post, title, content)) {
        return {
          verified: true,
          method: 'id_lookup',
          post_id: postId,
          post_url: buildPostUrl(post),
          post
        };
      }
    } catch (err) {
      if (!(err instanceof MoltbookApiError)) throw err;
      // Fall through to feed lookup if direct fetch endpoint is unavailable.
    }
  }

  const candidates = [
    `/posts?sort=new&limit=20`,
    `/posts?sort=hot&limit=20`
  ];
  for (const p of candidates) {
    try {
      const payload = await request(p, { method: 'GET', apiKey });
      const posts = assertPostsPayload(payload, p);
      const found = posts.find((x) => samePostByContent(x, title, content));
      if (found) {
        return {
          verified: true,
          method: 'feed_lookup',
          post_id: extractPostId(found),
          post_url: buildPostUrl(found),
          post: found
        };
      }
    } catch (err) {
      if (!(err instanceof MoltbookApiError)) throw err;
    }
  }

  throw new MoltbookApiError('POST_UNVERIFIED: create succeeded but verification failed', {
    code: 'POST_UNVERIFIED'
  });
}

// Payload contract observed from API responses:
// - "body" is rejected
// - "submolt_name" is required
// Keep legacy call shape: (title, body, apiKey, submoltName?)
async function moltbook_createPost(title, body, apiKey, submoltName = 'general') {
  if (!title || typeof title !== 'string') throw new Error('Missing title');
  if (!body || typeof body !== 'string') throw new Error('Missing body');
  if (!submoltName || typeof submoltName !== 'string') throw new Error('Missing submoltName');
  const created = await request('/posts', {
    method: 'POST',
    apiKey,
    body: {
      title,
      content: body,
      submolt_name: submoltName
    }
  });
  if (!created || typeof created !== 'object') {
    throw new MoltbookApiError('Unexpected create post response schema', { code: 'SCHEMA_ERROR' });
  }
  const challenge = await completeVerificationIfPresent(created, apiKey);
  const verification = await verifyCreatedPost(created, {
    title,
    content: body,
    apiKey
  });

  const normalizedPostId = verification.post_id || extractPostId(created);
  const normalizedPostUrl = verification.post_url || buildPostUrl(created);
  return {
    ...created,
    challenge,
    verification,
    post_id: normalizedPostId || null,
    post_url: normalizedPostUrl || null,
    verified: verification.verified === true
  };
}

async function moltbook_listAgents(limit = 10, apiKey) {
  const path = `/agents?sort=active&limit=${Number(limit) || 10}`;
  const payload = await request(path, { method: 'GET', apiKey });
  const agents = payload && (Array.isArray(payload) || Array.isArray(payload.agents) || (payload.data && Array.isArray(payload.data.agents)));
  if (!agents) {
    throw new MoltbookApiError('Unexpected agents response schema', {
      method: 'GET',
      path,
      payload,
      code: 'SCHEMA_ERROR'
    });
  }
  return payload;
}

async function moltbook_capabilities(apiKey) {
  const checks = [
    { name: 'posts_hot', fn: () => request('/posts?sort=hot&limit=1', { method: 'GET', apiKey }) },
    { name: 'agents_list', fn: () => request('/agents?sort=active&limit=1', { method: 'GET', apiKey }) }
  ];
  const out = {};
  for (const c of checks) {
    try {
      await c.fn();
      out[c.name] = { supported: true };
    } catch (err) {
      if (err instanceof MoltbookApiError) {
        out[c.name] = {
          supported: false,
          code: err.code,
          status: err.status,
          message: clip(err.message, 180)
        };
      } else {
        out[c.name] = { supported: false, code: 'UNKNOWN', message: clip(String(err), 180) };
      }
    }
  }
  return out;
}

module.exports = {
  moltbook_getHotPosts,
  moltbook_upvotePost,
  moltbook_comment,
  moltbook_createPost,
  moltbook_listAgents,
  moltbook_capabilities,
  MoltbookApiError,
  solveVerificationChallenge
};
