'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');
const adaptive = require('../../../adaptive/sensory/eyes/collectors/ollama_search');

function fetchViaNodeGet(url, options = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(String(url));
    } catch (err) {
      reject(err);
      return;
    }

    const client = parsed.protocol === 'http:' ? http : https;
    const timeoutMs = Number(options.timeout || 10000);
    const req = client.get(parsed, {
      method: String(options.method || 'GET').toUpperCase(),
      headers: options.headers || {}
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          ok: Number(res.statusCode || 0) >= 200 && Number(res.statusCode || 0) < 300,
          status: Number(res.statusCode || 0),
          headers: res.headers || {},
          text: async () => body
        });
      });
    });

    req.on('error', reject);
    if (timeoutMs > 0) {
      req.setTimeout(timeoutMs, () => {
        req.destroy(new Error(`fetch timeout after ${timeoutMs}ms`));
      });
    }
    if (options.signal && typeof options.signal.addEventListener === 'function') {
      options.signal.addEventListener('abort', () => {
        req.destroy(new Error('aborted'));
      }, { once: true });
    }
  });
}

async function withLegacyFetch(fn) {
  const originalFetch = global.fetch;
  global.fetch = (url, options) => fetchViaNodeGet(url, options);
  try {
    return await fn();
  } finally {
    global.fetch = originalFetch;
  }
}

async function collectOllamaSearchNewest(options = {}) {
  return withLegacyFetch(() => adaptive.collectOllamaSearchNewest(options));
}

async function preflightOllamaSearch() {
  return withLegacyFetch(() => adaptive.preflightOllamaSearch());
}

module.exports = {
  ...adaptive,
  collectOllamaSearchNewest,
  preflightOllamaSearch
};
