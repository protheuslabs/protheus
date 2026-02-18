// skills/moltbook/moltbook_api.js
// Core Moltbook functions for agent automation

const apiBase = 'https://www.moltbook.com/api/v1';
const getAuthHeader = (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey });

function clip(v, n = 220) {
  return String(v == null ? '' : v).slice(0, n);
}

class MoltbookApiError extends Error {
  constructor(message, { status = 0, method = '', path = '', payload = null, code = 'API_ERROR' } = {}) {
    super(message);
    this.name = 'MoltbookApiError';
    this.status = status;
    this.method = method;
    this.path = path;
    this.payload = payload;
    this.code = code;
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
    throw new Error('Missing apiKey');
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

async function request(path, { method = 'GET', apiKey, body } = {}) {
  assertAuth(apiKey);
  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: body == null
      ? getAuthHeader(apiKey)
      : { ...getAuthHeader(apiKey), 'Content-Type': 'application/json' },
    body: body == null ? undefined : JSON.stringify(body)
  });
  const payload = await parseBodySafe(res);
  if (!res.ok) {
    const msg = parseErrorMessage(payload, res.status, `${method} ${path} failed`);
    const code = res.status === 404 ? 'ENDPOINT_UNSUPPORTED' : 'HTTP_ERROR';
    throw new MoltbookApiError(
      `${method} ${path} failed (${res.status}): ${msg}`,
      { status: res.status, method, path, payload, code }
    );
  }
  return payload;
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
  const path = `/posts?sort=hot&limit=${Number(limit) || 5}`;
  const payload = await request(path, { method: 'GET', apiKey });
  assertPostsPayload(payload, path);
  return payload;
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

async function verifyCreatedPost(postPayload, { title, content, apiKey }) {
  const postId = extractPostId(postPayload);

  if (postId) {
    try {
      const fetched = await request(`/posts/${postId}`, { method: 'GET', apiKey });
      const post = fetched && fetched.post ? fetched.post : fetched;
      if (samePostByContent(post, title, content)) {
        return { verified: true, method: 'id_lookup', post_id: postId, post };
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
  const verification = await verifyCreatedPost(created, {
    title,
    content: body,
    apiKey
  });
  return {
    ...created,
    verification
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
  MoltbookApiError
};
