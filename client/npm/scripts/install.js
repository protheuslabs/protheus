#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawnSync } = require('child_process');

const pkgRoot = path.resolve(__dirname, '..');
const workspaceRoot = path.resolve(pkgRoot, '..');
const pkg = require(path.join(pkgRoot, 'package.json'));

function exeName() {
  return process.platform === 'win32' ? 'protheus-ops.exe' : 'protheus-ops';
}

function targetBinaryPath() {
  return path.join(pkgRoot, 'vendor', exeName());
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function chmodExec(filePath) {
  if (process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755);
  }
}

function platformTriple() {
  const archMap = {
    x64: 'x86_64',
    arm64: 'aarch64'
  };
  const osMap = {
    darwin: 'apple-darwin',
    linux: 'unknown-linux-gnu',
    win32: 'pc-windows-msvc'
  };
  const arch = archMap[process.arch] || process.arch;
  const os = osMap[process.platform] || process.platform;
  return `${arch}-${os}`;
}

function releaseCandidateUrls() {
  const versionTag = `v${pkg.version}`;
  const triple = platformTriple();
  const base = `https://github.com/protheuslabs/protheus/releases/download/${versionTag}`;
  const name = exeName();
  return [
    `${base}/${name}-${triple}`,
    `${base}/${name}-${triple}.bin`
  ];
}

function download(url, outPath) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        download(res.headers.location, outPath).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`http_${res.statusCode}`));
        return;
      }
      const file = fs.createWriteStream(outPath);
      res.pipe(file);
      file.on('finish', () => {
        file.close(() => resolve(true));
      });
      file.on('error', (err) => {
        fs.rmSync(outPath, { force: true });
        reject(err);
      });
    });
    req.on('error', reject);
  });
}

async function tryDownload(outPath) {
  for (const url of releaseCandidateUrls()) {
    try {
      await download(url, outPath);
      chmodExec(outPath);
      process.stdout.write(`[protheus npm] downloaded prebuilt binary: ${url}\n`);
      return true;
    } catch {
      // try next candidate
    }
  }
  return false;
}

function tryBuildLocal(outPath) {
  const manifestPath = path.join(workspaceRoot, 'crates', 'ops', 'Cargo.toml');
  if (!fs.existsSync(manifestPath)) return false;

  const build = spawnSync(
    'cargo',
    ['build', '--release', '--manifest-path', manifestPath, '--bin', 'protheus-ops'],
    { cwd: workspaceRoot, stdio: 'inherit' }
  );
  if (build.status !== 0) return false;

  const built = path.join(workspaceRoot, 'target', 'release', exeName());
  if (!fs.existsSync(built)) return false;
  fs.copyFileSync(built, outPath);
  chmodExec(outPath);
  process.stdout.write('[protheus npm] built local binary via cargo\n');
  return true;
}

async function main() {
  ensureDir(path.join(pkgRoot, 'vendor'));
  const outPath = targetBinaryPath();

  if (fs.existsSync(outPath) && String(process.env.PROTHEUS_NPM_FORCE_INSTALL || '').trim() !== '1') {
    chmodExec(outPath);
    process.stdout.write('[protheus npm] binary already present\n');
    return;
  }

  const skipDownload = String(process.env.PROTHEUS_NPM_SKIP_DOWNLOAD || '').trim() === '1';
  if (!skipDownload) {
    const downloaded = await tryDownload(outPath);
    if (downloaded) return;
  }

  const built = tryBuildLocal(outPath);
  if (built) return;

  process.stderr.write(
    '[protheus npm] failed to provision binary (release download unavailable and local cargo build failed)\n'
  );
  process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`[protheus npm] install failed: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(1);
});
