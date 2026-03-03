#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const MANIFEST = path.join(ROOT, 'crates', 'mobile', 'Cargo.toml');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJsonPayload(raw: unknown) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function binaryCandidates() {
  const explicit = cleanText(process.env.PROTHEUS_MOBILE_RUST_BIN || '', 500);
  const out = [
    explicit,
    path.join(ROOT, 'target', 'release', 'mobile_core'),
    path.join(ROOT, 'target', 'debug', 'mobile_core'),
    path.join(ROOT, 'crates', 'mobile', 'target', 'release', 'mobile_core'),
    path.join(ROOT, 'crates', 'mobile', 'target', 'debug', 'mobile_core')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function runViaRustBinary(requestBase64: string) {
  for (const candidate of binaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, ['run', `--request-base64=${requestBase64}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const payload = parseJsonPayload(out.stdout);
      if (out.status === 0 && payload && typeof payload === 'object') {
        return { ok: true, engine: 'rust_bin', binary_path: candidate, payload };
      }
    } catch {
      // continue
    }
  }
  return { ok: false, error: 'rust_binary_unavailable' };
}

function runViaCargo(requestBase64: string) {
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    MANIFEST,
    '--bin',
    'mobile_core',
    '--',
    'run',
    `--request-base64=${requestBase64}`
  ];
  const out = spawnSync('cargo', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const payload = parseJsonPayload(out.stdout);
  if (Number(out.status) === 0 && payload && typeof payload === 'object') {
    return { ok: true, engine: 'rust_cargo', payload };
  }
  return {
    ok: false,
    error: `cargo_run_failed:${cleanText(out.stderr || out.stdout || '', 260)}`
  };
}

function runMobileCycle(request: unknown, opts: AnyObj = {}) {
  const requestJson = typeof request === 'string'
    ? request
    : JSON.stringify(request && typeof request === 'object' ? request : {});
  const requestBase64 = Buffer.from(String(requestJson || '{}'), 'utf8').toString('base64');

  const binResult = runViaRustBinary(requestBase64);
  if (binResult.ok) return binResult;

  if (opts.allow_cli_fallback === false) return binResult;
  return runViaCargo(requestBase64);
}

module.exports = {
  runMobileCycle,
  runViaRustBinary,
  runViaCargo
};
