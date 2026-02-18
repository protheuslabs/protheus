// skills/moltbook/moltbook_api.js
// Core Moltbook functions for agent automation

const apiBase = 'https://www.moltbook.com/api/v1';
const getAuthHeader = (apiKey) => ({ 'Authorization': 'Bearer ' + apiKey });

function clip(v, n = 220) {
  return String(v == null ? '' : v).slice(0, n);
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
    const msg = payload && typeof payload === 'object' && payload.message
      ? payload.message
      : `HTTP ${res.status}`;
    throw new Error(`${method} ${path} failed (${res.status}): ${clip(msg)}`);
  }
  return payload;
}

async function moltbook_getHotPosts(limit = 5, apiKey) {
  return request(`/posts?sort=hot&limit=${Number(limit) || 5}`, { method: 'GET', apiKey });
}

async function moltbook_upvotePost(postId, apiKey) {
  if (!postId) throw new Error('Missing postId');
  return request(`/posts/${postId}/upvote`, { method: 'POST', apiKey });
}

async function moltbook_comment(postId, text, apiKey) {
  if (!postId) throw new Error('Missing postId');
  if (!text || typeof text !== 'string') throw new Error('Missing comment text');
  return request(`/posts/${postId}/comments`, {
    method: 'POST',
    apiKey,
    body: { text }
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
  return request('/posts', {
    method: 'POST',
    apiKey,
    body: {
      title,
      content: body,
      submolt_name: submoltName
    }
  });
}

async function moltbook_listAgents(limit = 10, apiKey) {
  return request(`/agents?sort=active&limit=${Number(limit) || 10}`, { method: 'GET', apiKey });
}

module.exports = {
  moltbook_getHotPosts,
  moltbook_upvotePost,
  moltbook_comment,
  moltbook_createPost,
  moltbook_listAgents
};
