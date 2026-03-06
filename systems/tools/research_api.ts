#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

type ResearchApiOptions = {
  dryRun?: boolean,
  format?: 'json' | 'markdown',
  apply?: boolean,
  confirmExecution?: boolean,
  maxQueryTokens?: number,
  tokenBudgetMode?: 'trim' | 'reject',
  env?: Record<string, string>
};

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const RESEARCH_CLI = path.join(ROOT, 'systems', 'tools', 'research.js');

function cleanText(v: unknown, maxLen = 300) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJsonPayload(raw: unknown): AnyObj | null {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function systemResearch(query: string, opts: ResearchApiOptions = {}) {
  const normalized = cleanText(query, 12000);
  if (!normalized) {
    return {
      ok: false,
      type: 'research_programmatic',
      error: 'query_required'
    };
  }

  const args: string[] = [RESEARCH_CLI, normalized];
  const format = String(opts.format || 'json').toLowerCase() === 'markdown' ? 'markdown' : 'json';
  args.push(`--format=${format}`);

  if (opts.dryRun !== false) args.push('--dry-run=1');
  if (opts.apply === true) args.push('--apply=1');
  if (opts.confirmExecution === true) args.push('--confirm-execution=1');
  if (opts.maxQueryTokens != null) args.push(`--max-query-tokens=${Math.max(1, Math.floor(Number(opts.maxQueryTokens) || 1))}`);
  if (opts.tokenBudgetMode === 'reject' || opts.tokenBudgetMode === 'trim') args.push(`--token-budget-mode=${opts.tokenBudgetMode}`);

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
    env: {
      ...process.env,
      ...(opts.env || {})
    }
  });

  const status = Number.isFinite(run.status) ? Number(run.status) : 1;
  const payload = parseJsonPayload(run.stdout) || parseJsonPayload(run.stderr);

  if (status === 0 && payload) {
    return {
      ok: true,
      type: 'research_programmatic',
      mode: 'system_research',
      status,
      query: normalized,
      payload
    };
  }

  return {
    ok: false,
    type: 'research_programmatic',
    mode: 'system_research',
    status,
    query: normalized,
    error: cleanText((payload && payload.error) || run.stderr || run.stdout || 'research_invocation_failed', 500),
    payload: payload || null
  };
}

module.exports = {
  systemResearch
};
