#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PINNACLE_MANIFEST = path.join(ROOT, 'crates', 'pinnacle', 'Cargo.toml');

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
  const explicit = cleanText(process.env.PROTHEUS_PINNACLE_RUST_BIN || '', 500);
  const out = [
    explicit,
    path.join(ROOT, 'target', 'release', 'pinnacle_core'),
    path.join(ROOT, 'target', 'debug', 'pinnacle_core'),
    path.join(ROOT, 'crates', 'pinnacle', 'target', 'release', 'pinnacle_core'),
    path.join(ROOT, 'crates', 'pinnacle', 'target', 'debug', 'pinnacle_core')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function runViaRustBinary(command: string, extraArgs: string[] = []) {
  for (const candidate of binaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, [command, ...extraArgs], {
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

function runViaCargo(command: string, extraArgs: string[] = []) {
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    PINNACLE_MANIFEST,
    '--bin',
    'pinnacle_core',
    '--',
    command,
    ...extraArgs
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

function runCommand(command: string, left: unknown, right: unknown, opts: AnyObj = {}) {
  const leftJson = typeof left === 'string' ? left : JSON.stringify(left && typeof left === 'object' ? left : {});
  const rightJson = typeof right === 'string' ? right : JSON.stringify(right && typeof right === 'object' ? right : {});
  const leftB64 = Buffer.from(leftJson, 'utf8').toString('base64');
  const rightB64 = Buffer.from(rightJson, 'utf8').toString('base64');
  const extraArgs = [`--left-b64=${leftB64}`, `--right-b64=${rightB64}`];

  const binResult = runViaRustBinary(command, extraArgs);
  if (binResult.ok) return binResult;

  if (opts.allow_cli_fallback === false) return binResult;
  return runViaCargo(command, extraArgs);
}

function mergeDelta(left: unknown, right: unknown, opts: AnyObj = {}) {
  return runCommand('merge', left, right, opts);
}

function getSovereigntyIndex(left: unknown, right: unknown, opts: AnyObj = {}) {
  return runCommand('index', left, right, opts);
}

module.exports = {
  mergeDelta,
  getSovereigntyIndex,
  runViaRustBinary,
  runViaCargo
};
