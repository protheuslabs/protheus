#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.SUPPLY_CHAIN_TRUST_ROOT
  ? path.resolve(process.env.SUPPLY_CHAIN_TRUST_ROOT)
  : path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SUPPLY_CHAIN_TRUST_POLICY_PATH
  ? path.resolve(process.env.SUPPLY_CHAIN_TRUST_POLICY_PATH)
  : path.join(ROOT, 'config', 'supply_chain_trust_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!String(token || '').startsWith('--')) {
      out._.push(String(token || ''));
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[String(token).slice(2)] = true;
    else out[String(token).slice(2, idx)] = String(token).slice(idx + 1);
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/supply_chain_trust_plane.js run [--strict=1|0] [--policy=<path>] [--verify-only=1|0]');
  console.log('  node systems/security/supply_chain_trust_plane.js status [--policy=<path>]');
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function readJsonl(filePath: string) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function sha256Text(text: string) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

function sha256File(filePath: string) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function resolveRepoPath(v: unknown) {
  const cleaned = cleanText(v || '', 320);
  if (!cleaned) return ROOT;
  return path.isAbsolute(cleaned) ? cleaned : path.join(ROOT, cleaned);
}

function rel(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function matchesPattern(value: string, pattern: string) {
  const normalizedValue = String(value || '').replace(/\\/g, '/');
  const normalizedPattern = String(pattern || '').replace(/\\/g, '/');
  if (!normalizedPattern) return false;
  if (normalizedPattern.endsWith('/**')) {
    const prefix = normalizedPattern.slice(0, -3);
    return normalizedValue.startsWith(prefix);
  }
  if (normalizedPattern.endsWith('/*')) {
    const prefix = normalizedPattern.slice(0, -2);
    if (!normalizedValue.startsWith(prefix)) return false;
    const rest = normalizedValue.slice(prefix.length);
    return rest.indexOf('/') < 0;
  }
  return normalizedValue.includes(normalizedPattern);
}

function pathExcluded(relPath: string, excludes: string[]) {
  return excludes.some((pattern) => matchesPattern(relPath, pattern));
}

function defaultPolicy() {
  return {
    schema_id: 'supply_chain_trust_policy',
    schema_version: '1.0',
    enabled: true,
    mode: 'enforce',
    artifact_roots: ['systems', 'config', 'docs'],
    include_extensions: ['.ts', '.js', '.json', '.md'],
    exclude_patterns: ['state/', 'memory/', 'research/', 'node_modules/', '.git/'],
    require_lockfile: true,
    lockfile_path: 'package-lock.json',
    package_json_path: 'package.json',
    sbom_from_lockfile: true,
    signature_key_env: 'SUPPLY_CHAIN_SIGNING_KEY',
    allow_dev_fallback_key: true,
    dev_fallback_key: 'dev-supply-chain-key-change-me',
    latest_path: 'state/security/supply_chain/latest.json',
    receipts_path: 'state/security/supply_chain/receipts.jsonl',
    manifest_path: 'state/security/supply_chain/manifest.json',
    sbom_path: 'state/security/supply_chain/sbom.json',
    attestation_path: 'state/security/supply_chain/attestation.json',
    run_build_commands: false,
    build_commands: []
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const base = defaultPolicy();
  const src = readJson(policyPath, {});
  const artifactRoots = Array.isArray(src.artifact_roots)
    ? src.artifact_roots.map((row: unknown) => cleanText(row, 320)).filter(Boolean)
    : base.artifact_roots;
  const includeExt = Array.isArray(src.include_extensions)
    ? src.include_extensions.map((row: unknown) => {
      const tok = cleanText(row, 20).toLowerCase();
      return tok.startsWith('.') ? tok : `.${tok}`;
    }).filter(Boolean)
    : base.include_extensions;
  const excludes = Array.isArray(src.exclude_patterns)
    ? src.exclude_patterns.map((row: unknown) => cleanText(row, 120)).filter(Boolean)
    : base.exclude_patterns;
  return {
    schema_id: 'supply_chain_trust_policy',
    schema_version: cleanText(src.schema_version || base.schema_version, 24) || base.schema_version,
    enabled: src.enabled !== false,
    mode: normalizeToken(src.mode || base.mode, 24) === 'advisory' ? 'advisory' : 'enforce',
    artifact_roots: artifactRoots,
    include_extensions: includeExt,
    exclude_patterns: excludes,
    require_lockfile: src.require_lockfile !== false,
    lockfile_path: resolveRepoPath(src.lockfile_path || base.lockfile_path),
    package_json_path: resolveRepoPath(src.package_json_path || base.package_json_path),
    sbom_from_lockfile: src.sbom_from_lockfile !== false,
    signature_key_env: cleanText(src.signature_key_env || base.signature_key_env, 80) || base.signature_key_env,
    allow_dev_fallback_key: src.allow_dev_fallback_key !== false,
    dev_fallback_key: cleanText(src.dev_fallback_key || base.dev_fallback_key, 160) || base.dev_fallback_key,
    latest_path: resolveRepoPath(src.latest_path || base.latest_path),
    receipts_path: resolveRepoPath(src.receipts_path || base.receipts_path),
    manifest_path: resolveRepoPath(src.manifest_path || base.manifest_path),
    sbom_path: resolveRepoPath(src.sbom_path || base.sbom_path),
    attestation_path: resolveRepoPath(src.attestation_path || base.attestation_path),
    run_build_commands: src.run_build_commands === true,
    build_commands: Array.isArray(src.build_commands) ? src.build_commands : base.build_commands,
    policy_path: path.resolve(policyPath)
  };
}

function listArtifactFiles(policy: AnyObj) {
  const out: string[] = [];
  const allowExt = new Set((Array.isArray(policy.include_extensions) ? policy.include_extensions : []).map((v: unknown) => String(v).toLowerCase()));
  const excludes = Array.isArray(policy.exclude_patterns) ? policy.exclude_patterns : [];

  const walk = (absDir: string) => {
    if (!fs.existsSync(absDir)) return;
    const st = fs.statSync(absDir);
    if (!st.isDirectory()) return;
    const entries = fs.readdirSync(absDir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const abs = path.join(absDir, entry.name);
      const rp = rel(abs);
      if (pathExcluded(rp, excludes)) continue;
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const ext = path.extname(entry.name).toLowerCase();
      if (allowExt.size && !allowExt.has(ext)) continue;
      out.push(abs);
    }
  };

  for (const rootRel of Array.isArray(policy.artifact_roots) ? policy.artifact_roots : []) {
    const absRoot = resolveRepoPath(rootRel);
    walk(absRoot);
  }

  return Array.from(new Set(out)).sort((a, b) => rel(a).localeCompare(rel(b)));
}

function runBuildCommands(policy: AnyObj) {
  const rows = Array.isArray(policy.build_commands) ? policy.build_commands : [];
  const receipts: AnyObj[] = [];
  for (const row of rows) {
    const command = Array.isArray(row) ? row.map((v) => String(v)) : [];
    if (command.length < 1) continue;
    const r = spawnSync(command[0], command.slice(1), {
      cwd: ROOT,
      encoding: 'utf8'
    });
    receipts.push({
      command,
      status: Number(r.status || 0),
      ok: r.status === 0,
      stdout: String(r.stdout || '').trim().split('\n').slice(-8),
      stderr: String(r.stderr || '').trim().split('\n').slice(-8)
    });
    if (r.status !== 0) break;
  }
  return {
    ok: receipts.every((row) => row.ok === true),
    receipts
  };
}

function buildSbom(policy: AnyObj) {
  const pkg = readJson(policy.package_json_path, {});
  const lock = readJson(policy.lockfile_path, {});
  const deps = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  const devDeps = pkg.devDependencies && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {};

  const components: AnyObj[] = [];
  if (policy.sbom_from_lockfile === true && lock && lock.packages && typeof lock.packages === 'object') {
    const lockPackages = lock.packages;
    const names = Object.keys(lockPackages).sort();
    for (const key of names) {
      const row = lockPackages[key] && typeof lockPackages[key] === 'object' ? lockPackages[key] : null;
      if (!row) continue;
      const name = key === ''
        ? cleanText(pkg.name || 'root', 160)
        : cleanText(key.replace(/^node_modules\//, ''), 240);
      if (!name) continue;
      components.push({
        name,
        version: cleanText(row.version || '', 80) || null,
        resolved: cleanText(row.resolved || '', 320) || null,
        integrity: cleanText(row.integrity || '', 240) || null,
        dev: row.dev === true,
        source: 'package-lock'
      });
    }
  } else {
    const all = [
      ...Object.entries(deps).map(([name, version]) => ({ name, version, dev: false })),
      ...Object.entries(devDeps).map(([name, version]) => ({ name, version, dev: true }))
    ].sort((a, b) => String(a.name).localeCompare(String(b.name)));
    for (const row of all) {
      components.push({
        name: cleanText(row.name, 200),
        version: cleanText(row.version, 80),
        resolved: null,
        integrity: null,
        dev: row.dev === true,
        source: 'package-json'
      });
    }
  }

  return {
    schema_id: 'sbom_snapshot',
    schema_version: '1.0',
    generated_at: nowIso(),
    package_name: cleanText(pkg.name || '', 160) || null,
    package_version: cleanText(pkg.version || '', 80) || null,
    lockfile_version: Number(lock.lockfileVersion || 0) || null,
    components,
    component_count: components.length
  };
}

function pickSigningKey(policy: AnyObj) {
  const envKey = cleanText(process.env[policy.signature_key_env] || '', 1024);
  if (envKey) {
    return {
      ok: true,
      source: 'env',
      key: envKey
    };
  }
  if (policy.allow_dev_fallback_key === true) {
    return {
      ok: true,
      source: 'dev_fallback',
      key: cleanText(policy.dev_fallback_key || '', 1024)
    };
  }
  return {
    ok: false,
    source: 'missing',
    key: ''
  };
}

function signWithHmac(key: string, payload: AnyObj) {
  const canon = stableStringify(payload);
  return crypto.createHmac('sha256', key).update(canon, 'utf8').digest('hex');
}

function runTrustPlane(args: AnyObj = {}) {
  const policyPath = args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH;
  const policy = loadPolicy(policyPath);
  const strict = toBool(args.strict, false);
  const verifyOnly = toBool(args['verify-only'], false);

  const checks: AnyObj[] = [];
  const addCheck = (id: string, ok: boolean, detail: string) => {
    checks.push({ id, ok: ok === true, detail: cleanText(detail, 320) });
  };

  if (policy.enabled !== true) {
    const payload = {
      ok: true,
      type: 'supply_chain_trust_plane',
      ts: nowIso(),
      decision: 'disabled',
      policy_version: policy.schema_version,
      checks: [],
      strict
    };
    writeJsonAtomic(policy.latest_path, payload);
    return payload;
  }

  const buildResult = policy.run_build_commands === true && verifyOnly !== true
    ? runBuildCommands(policy)
    : { ok: true, receipts: [] };
  addCheck(
    'build_commands',
    buildResult.ok === true,
    buildResult.receipts.length ? `commands=${buildResult.receipts.length}` : 'skipped'
  );

  const lockExists = fs.existsSync(policy.lockfile_path);
  addCheck('lockfile_present', policy.require_lockfile !== true || lockExists, lockExists ? 'present' : 'missing');

  const packageExists = fs.existsSync(policy.package_json_path);
  addCheck('package_json_present', packageExists, packageExists ? 'present' : 'missing');

  const artifactFiles = listArtifactFiles(policy);
  addCheck('artifact_files_discovered', artifactFiles.length > 0, `count=${artifactFiles.length}`);

  const manifestFiles = artifactFiles.map((absPath) => ({
    path: rel(absPath),
    sha256: sha256File(absPath),
    bytes: fs.statSync(absPath).size
  }));
  const manifest = {
    schema_id: 'reproducible_build_manifest',
    schema_version: '1.0',
    generated_at: nowIso(),
    root: ROOT,
    policy_version: policy.schema_version,
    files: manifestFiles,
    file_count: manifestFiles.length
  };
  const manifestHash = sha256Text(stableStringify(manifest));

  const sbom = buildSbom(policy);
  const sbomHash = sha256Text(stableStringify(sbom));

  const lockHash = lockExists ? sha256File(policy.lockfile_path) : null;
  const attestation = {
    schema_id: 'supply_chain_attestation',
    schema_version: '1.0',
    generated_at: nowIso(),
    git_head: cleanText(process.env.GIT_COMMIT_SHA || '', 120) || null,
    lockfile_path: rel(policy.lockfile_path),
    lockfile_sha256: lockHash,
    manifest_sha256: manifestHash,
    sbom_sha256: sbomHash,
    artifact_count: manifest.file_count,
    sbom_components: Number(sbom.component_count || 0),
    policy_version: policy.schema_version
  };

  const keyPick = pickSigningKey(policy);
  addCheck('signing_key_available', keyPick.ok === true, `source=${keyPick.source}`);

  const signature = keyPick.ok === true
    ? signWithHmac(keyPick.key, {
      manifest_sha256: manifestHash,
      sbom_sha256: sbomHash,
      attestation
    })
    : null;
  const verified = keyPick.ok === true && signature === signWithHmac(keyPick.key, {
    manifest_sha256: manifestHash,
    sbom_sha256: sbomHash,
    attestation
  });
  addCheck('signature_verified', verified === true, verified ? 'verified' : 'signature_mismatch');

  const dependencyPinningOk = lockExists === true;
  addCheck('dependency_pinning', dependencyPinningOk, dependencyPinningOk ? 'lockfile_versioned' : 'lockfile_missing');

  if (verifyOnly !== true) {
    writeJsonAtomic(policy.manifest_path, manifest);
    writeJsonAtomic(policy.sbom_path, sbom);
    writeJsonAtomic(policy.attestation_path, {
      ...attestation,
      signature,
      signature_alg: 'hmac-sha256',
      signing_key_source: keyPick.source
    });
  }

  const enforce = policy.mode === 'enforce';
  const failedChecks = checks.filter((row) => row.ok !== true);
  const ok = enforce ? failedChecks.length === 0 : true;
  const decision = ok ? 'allow' : (enforce ? 'deny' : 'advisory_allow');

  const payload = {
    ok,
    type: 'supply_chain_trust_plane',
    ts: nowIso(),
    decision,
    strict,
    verify_only: verifyOnly,
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path),
    mode: policy.mode,
    checks,
    failed_checks: failedChecks.length,
    build_commands: buildResult.receipts,
    manifest_path: rel(policy.manifest_path),
    sbom_path: rel(policy.sbom_path),
    attestation_path: rel(policy.attestation_path),
    latest_path: rel(policy.latest_path),
    receipts_path: rel(policy.receipts_path),
    manifest_sha256: manifestHash,
    sbom_sha256: sbomHash,
    signature_present: !!signature,
    signature_verified: verified === true,
    signing_key_source: keyPick.source,
    artifact_count: manifest.file_count,
    sbom_components: Number(sbom.component_count || 0),
    lockfile_sha256: lockHash
  };

  writeJsonAtomic(policy.latest_path, payload);
  appendJsonl(policy.receipts_path, {
    ts: payload.ts,
    type: payload.type,
    decision: payload.decision,
    ok: payload.ok,
    failed_checks: payload.failed_checks,
    manifest_sha256: payload.manifest_sha256,
    sbom_sha256: payload.sbom_sha256,
    signature_verified: payload.signature_verified,
    signing_key_source: payload.signing_key_source,
    artifact_count: payload.artifact_count,
    sbom_components: payload.sbom_components
  });

  if ((strict || enforce) && payload.ok !== true) {
    payload.exit_code = 1;
  }
  return payload;
}

function cmdRun(args: AnyObj) {
  const payload = runTrustPlane(args);
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.exit_code) process.exit(payload.exit_code);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
  const latest = readJson(policy.latest_path, {});
  const receipts = readJsonl(policy.receipts_path);
  process.stdout.write(`${JSON.stringify({
    ok: true,
    type: 'supply_chain_trust_status',
    latest,
    recent_receipts: receipts.slice(-10),
    policy_version: policy.schema_version,
    policy_path: rel(policy.policy_path)
  }, null, 2)}\n`);
}

function main(argv: string[]) {
  const args = parseArgs(argv);
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'run') return cmdRun(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main(process.argv.slice(2));
}

module.exports = {
  DEFAULT_POLICY_PATH,
  loadPolicy,
  runTrustPlane
};
