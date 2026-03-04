#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

type AssimilateApiOptions = {
  dryRun?: boolean,
  format?: 'json' | 'markdown',
  apply?: boolean,
  confirmExecution?: boolean,
  env?: Record<string, string>
};

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');

const ASSIMILATE_CLI = path.join(ROOT, 'systems', 'tools', 'assimilate.js');

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

function systemAssimilate(target: string, opts: AssimilateApiOptions = {}) {
  const input = cleanText(target, 2000);
  if (!input) {
    return {
      ok: false,
      type: 'assimilate_programmatic',
      error: 'target_required'
    };
  }

  const args: string[] = [ASSIMILATE_CLI, input];
  const format = String(opts.format || 'json').toLowerCase() === 'markdown' ? 'markdown' : 'json';
  args.push(`--format=${format}`);

  if (opts.dryRun !== false) args.push('--dry-run=1');
  if (opts.apply === true) args.push('--apply=1');
  if (opts.confirmExecution === true) args.push('--confirm-execution=1');

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
    env: {
      ...process.env,
      ...(opts.env || {})
    }
  });

  const payload = parseJsonPayload(run.stdout) || parseJsonPayload(run.stderr);
  const status = Number.isFinite(run.status) ? Number(run.status) : 1;

  if (status === 0 && payload) {
    return {
      ok: true,
      type: 'assimilate_programmatic',
      mode: 'system_assimilate',
      target: input,
      status,
      payload
    };
  }

  return {
    ok: false,
    type: 'assimilate_programmatic',
    mode: 'system_assimilate',
    target: input,
    status,
    error: cleanText((payload && payload.error) || run.stderr || run.stdout || 'assimilate_invocation_failed', 500),
    payload: payload || null
  };
}

module.exports = {
  systemAssimilate
};
