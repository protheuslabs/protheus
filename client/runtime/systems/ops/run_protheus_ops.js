#!/usr/bin/env node
'use strict';

// Layer ownership: client/runtime/systems/ops (authoritative app bridge helper)

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..', '..');

function isFile(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function mtimeMs(filePath) {
  try {
    return fs.statSync(filePath).mtimeMs || 0;
  } catch {
    return 0;
  }
}

function sourceNewestMtimeMs() {
  const opsRoot = path.join(ROOT, 'core', 'layer0', 'ops');
  const srcRoot = path.join(opsRoot, 'src');
  let newest = Math.max(
    mtimeMs(path.join(ROOT, 'Cargo.toml')),
    mtimeMs(path.join(opsRoot, 'Cargo.toml'))
  );

  const stack = [srcRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }
      if (entry.isFile() && fullPath.endsWith('.rs')) {
        newest = Math.max(newest, mtimeMs(fullPath));
      }
    }
  }
  return newest;
}

function binaryFreshEnough(binPath) {
  const binMtime = mtimeMs(binPath);
  if (!binMtime) return false;
  const srcMtime = sourceNewestMtimeMs();
  if (!srcMtime) return true;
  return binMtime >= srcMtime;
}

function resolveBinary() {
  const explicit = String(process.env.PROTHEUS_NPM_BINARY || '').trim();
  if (explicit && isFile(explicit)) return explicit;

  const release = path.join(
    ROOT,
    'target',
    'release',
    process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
  );
  if (isFile(release) && binaryFreshEnough(release)) return release;

  const target = path.join(
    ROOT,
    'target',
    'debug',
    process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
  );
  if (isFile(target) && binaryFreshEnough(target)) return target;

  const vendor = path.join(
    ROOT,
    'client',
    'cli',
    'npm',
    'vendor',
    process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops'
  );
  if (isFile(vendor) && binaryFreshEnough(vendor)) return vendor;

  return null;
}

function spawnInvocation(command, args, env) {
  return spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: 'pipe',
    env,
  });
}

function processStatus(proc) {
  if (!proc) return 1;
  if (proc.error) return 1;
  return Number.isFinite(proc.status) ? proc.status : 1;
}

function processOutput(proc) {
  const stdout = proc && typeof proc.stdout === 'string' ? proc.stdout : '';
  const stderrBase = proc && typeof proc.stderr === 'string' ? proc.stderr : '';
  const err = proc && proc.error ? `\n${String(proc.error.message || proc.error)}` : '';
  return {
    stdout,
    stderr: `${stderrBase}${err}`,
    combined: `${stdout}\n${stderrBase}${err}`,
  };
}

function writeAll(fd, text) {
  if (!text) return;
  const buffer = Buffer.from(text, 'utf8');
  let offset = 0;
  while (offset < buffer.length) {
    offset += fs.writeSync(fd, buffer, offset, buffer.length - offset);
  }
}

function emitProcessOutput(proc) {
  const out = processOutput(proc);
  writeAll(1, out.stdout);
  writeAll(2, out.stderr);
}

function shouldFallbackToCargo(args, proc, options = {}) {
  if (options.unknownDomainFallback === false) return false;
  if (!Array.isArray(args) || args.length === 0) return false;
  if (processStatus(proc) === 0) return false;
  const out = processOutput(proc);
  return /\bunknown_domain\b/i.test(out.combined);
}

function runViaCargo(args, env) {
  return spawnInvocation(
    'cargo',
    ['run', '--quiet', '-p', 'protheus-ops-core', '--bin', 'protheus-ops', '--'].concat(args),
    env
  );
}

function runProtheusOps(args, options = {}) {
  const bin = resolveBinary();
  const env = { ...process.env, PROTHEUS_ROOT: ROOT, ...(options.env || {}) };
  if (bin) {
    const proc = spawnInvocation(bin, args, env);
    if (shouldFallbackToCargo(args, proc, options)) {
      const fallback = runViaCargo(args, env);
      if (!fallback.error) {
        emitProcessOutput(fallback);
        return processStatus(fallback);
      }
    }
    emitProcessOutput(proc);
    return processStatus(proc);
  }

  const proc = runViaCargo(args, env);
  emitProcessOutput(proc);
  return processStatus(proc);
}

module.exports = { ROOT, resolveBinary, runProtheusOps };

if (require.main === module) {
  const exitCode = runProtheusOps(process.argv.slice(2));
  process.exit(exitCode);
}
