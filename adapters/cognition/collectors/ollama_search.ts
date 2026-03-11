'use strict';
// Layer ownership: adapters/cognition/collectors (authoritative)

const http = require('http');
const https = require('https');
const { URL: NodeURL } = require('url');
const adaptive = require('../../../apps/_shared/cognition/adaptive/sensory/eyes/collectors/ollama_search.ts');

type FetchLikeResponse = {
  ok: boolean;
  status: number;
  headers: Record<string, unknown>;
  text: () => Promise<string>;
};

type FetchLikeOptions = {
  timeout?: number;
  method?: string;
  headers?: Record<string, string>;
  signal?: { addEventListener?: (name: string, fn: () => void, opts?: { once?: boolean }) => void };
};

function fetchViaNodeGet(url: unknown, options: FetchLikeOptions = {}): Promise<FetchLikeResponse> {
  return new Promise((resolve, reject) => {
    let parsed: InstanceType<typeof NodeURL>;
    try {
      parsed = new NodeURL(String(url));
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
      const chunks: unknown[] = [];
      res.on('data', (chunk: unknown) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk as any))).toString('utf8');
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

async function withLegacyFetch(fn: () => Promise<unknown>): Promise<unknown> {
  const g = globalThis as unknown as { fetch?: (url: unknown, options?: FetchLikeOptions) => Promise<FetchLikeResponse> };
  const originalFetch = g.fetch;
  g.fetch = (url: unknown, options?: FetchLikeOptions) => fetchViaNodeGet(url, options || {});
  try {
    return await fn();
  } finally {
    g.fetch = originalFetch;
  }
}

async function collectOllamaSearchNewest(options: Record<string, unknown> = {}) {
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
export {};
