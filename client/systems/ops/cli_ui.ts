#!/usr/bin/env node
'use strict';
export {};

type UiLevel = 'info' | 'warn' | 'error' | 'success' | 'accent';
type Spinner = {
  update: (label: string) => void,
  stop: (ok: boolean, finalLabel?: string) => void
};

function supportsColor() {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR === '0') return false;
  if (process.env.FORCE_COLOR === '1') return true;
  return Boolean(process.stderr && process.stderr.isTTY);
}

function colorize(level: UiLevel, text: string, enabled = supportsColor()) {
  if (!enabled) return text;
  const code = level === 'info'
    ? '36'
    : level === 'warn'
      ? '33'
      : level === 'error'
        ? '31'
        : level === 'success'
          ? '32'
          : '35';
  return `\u001b[${code}m${text}\u001b[0m`;
}

function createSpinner(initialLabel: string, enabled = true): Spinner {
  const active = Boolean(enabled && process.stderr && process.stderr.isTTY);
  const frames = ['-', '\\', '|', '/'];
  let idx = 0;
  let label = String(initialLabel || '').trim();
  let timer: NodeJS.Timeout | null = null;

  if (active) {
    timer = setInterval(() => {
      idx = (idx + 1) % frames.length;
      process.stderr.write(`\r${colorize('accent', frames[idx])} ${label}`);
    }, 90);
  }

  return {
    update(nextLabel: string) {
      label = String(nextLabel || '').trim() || label;
      if (active) process.stderr.write(`\r${colorize('accent', frames[idx])} ${label}`);
    },
    stop(ok: boolean, finalLabel?: string) {
      if (timer) clearInterval(timer);
      if (active) {
        const symbol = ok ? colorize('success', 'OK') : colorize('error', 'ERR');
        const doneLabel = String(finalLabel || label).trim() || label;
        process.stderr.write(`\r${symbol} ${doneLabel}\n`);
      }
    }
  };
}

function levenshtein(a: string, b: string) {
  const s = String(a || '');
  const t = String(b || '');
  if (!s) return t.length;
  if (!t) return s.length;
  const dp: number[] = new Array(t.length + 1).fill(0);
  for (let j = 0; j <= t.length; j += 1) dp[j] = j;
  for (let i = 1; i <= s.length; i += 1) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= t.length; j += 1) {
      const tmp = dp[j];
      const cost = s[i - 1] === t[j - 1] ? 0 : 1;
      dp[j] = Math.min(
        dp[j] + 1,
        dp[j - 1] + 1,
        prev + cost
      );
      prev = tmp;
    }
  }
  return dp[t.length];
}

function bestSuggestions(input: string, candidates: string[], limit = 3) {
  const token = String(input || '').trim().toLowerCase();
  if (!token) return [];
  const scored = (Array.isArray(candidates) ? candidates : [])
    .map((candidate) => ({
      candidate,
      score: levenshtein(token, String(candidate || '').toLowerCase())
    }))
    .sort((a, b) => a.score - b.score || String(a.candidate).localeCompare(String(b.candidate)));
  return scored
    .filter((row) => Number.isFinite(row.score) && row.score <= Math.max(3, Math.ceil(token.length * 0.4)))
    .slice(0, limit)
    .map((row) => row.candidate);
}

module.exports = {
  supportsColor,
  colorize,
  createSpinner,
  levenshtein,
  bestSuggestions
};
