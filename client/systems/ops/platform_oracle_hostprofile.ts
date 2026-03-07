#!/usr/bin/env node
'use strict';
export {};

import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.PLATFORM_ORACLE_HOSTPROFILE_POLICY_PATH
  ? path.resolve(process.env.PLATFORM_ORACLE_HOSTPROFILE_POLICY_PATH)
  : path.join(ROOT, 'config', 'platform_oracle_hostprofile_policy.json');

function nowIso(): string {
  return new Date().toISOString();
}

function rel(filePath: string): string {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function cleanText(v: unknown, maxLen = 240): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseArgs(argv: string[]): AnyObj {
  const out: AnyObj = { _: [] };
  for (const tok of argv) {
    if (!String(tok || '').startsWith('--')) {
      out._.push(String(tok || ''));
      continue;
    }
    const idx = String(tok).indexOf('=');
    if (idx < 0) out[String(tok).slice(2)] = true;
    else out[String(tok).slice(2, idx)] = String(tok).slice(idx + 1);
  }
  return out;
}

function toBool(v: unknown, fallback = false): boolean {
  if (v == null) return fallback;
  const s = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return fallback;
}

function clampNumber(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: AnyObj = {}): AnyObj {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: AnyObj): void {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: AnyObj): void {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function defaultPolicy(): AnyObj {
  return {
    schema_id: 'platform_oracle_hostprofile_policy',
    schema_version: '1.0',
    enabled: true,
    min_confidence: 0.65,
    signing_secret: 'platform_oracle_local_signing_secret',
    fallback_profile: {
      mode: 'minimal',
      os_family: 'unknown',
      distro: 'unknown',
      variant: 'unknown',
      arch: process.arch,
      runtime: { node: process.version }
    },
    state_path: 'state/ops/platform_oracle_hostprofile/latest.json',
    history_path: 'state/ops/platform_oracle_hostprofile/history.jsonl',
    last_known_good_path: 'state/ops/platform_oracle_hostprofile/last_known_good.json'
  };
}

function resolvePath(raw: unknown, fallbackRel: string): string {
  const txt = cleanText(raw, 320);
  if (!txt) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}

function loadPolicy(policyPath: string): AnyObj {
  const base = defaultPolicy();
  const raw = readJson(policyPath, base);
  const fallback = raw && raw.fallback_profile && typeof raw.fallback_profile === 'object'
    ? raw.fallback_profile
    : base.fallback_profile;
  return {
    schema_id: 'platform_oracle_hostprofile_policy',
    schema_version: cleanText(raw.schema_version || base.schema_version, 24) || '1.0',
    enabled: raw.enabled !== false,
    min_confidence: clampNumber(raw.min_confidence, 0, 1, base.min_confidence),
    signing_secret: cleanText(raw.signing_secret || base.signing_secret, 200) || base.signing_secret,
    fallback_profile: {
      mode: cleanText(fallback.mode || 'minimal', 40) || 'minimal',
      os_family: cleanText(fallback.os_family || 'unknown', 80) || 'unknown',
      distro: cleanText(fallback.distro || 'unknown', 120) || 'unknown',
      variant: cleanText(fallback.variant || 'unknown', 120) || 'unknown',
      arch: cleanText(fallback.arch || process.arch, 80) || process.arch,
      runtime: {
        node: cleanText((fallback.runtime || {}).node || process.version, 80) || process.version
      }
    },
    state_path: resolvePath(raw.state_path || base.state_path, base.state_path),
    history_path: resolvePath(raw.history_path || base.history_path, base.history_path),
    last_known_good_path: resolvePath(raw.last_known_good_path || base.last_known_good_path, base.last_known_good_path)
  };
}

function readOsRelease(): AnyObj {
  const candidates = ['/etc/os-release', '/usr/lib/os-release'];
  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const body = fs.readFileSync(p, 'utf8');
      const out: AnyObj = {};
      for (const line of String(body || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
        const idx = trimmed.indexOf('=');
        const key = trimmed.slice(0, idx).trim().toUpperCase();
        let val = trimmed.slice(idx + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith('\'') && val.endsWith('\''))) {
          val = val.slice(1, -1);
        }
        out[key] = val;
      }
      if (Object.keys(out).length > 0) return out;
    } catch {
      // best-effort only
    }
  }
  return {};
}

function detectCloudProvider(): string {
  const envHints = [
    process.env.CLOUD_PROVIDER,
    process.env.AWS_EXECUTION_ENV ? 'aws' : '',
    process.env.GOOGLE_CLOUD_PROJECT ? 'gcp' : '',
    process.env.AZURE_HTTP_USER_AGENT ? 'azure' : ''
  ].map((x) => cleanText(x, 80)).filter(Boolean);
  return envHints[0] || 'unknown';
}

function detectCapabilities(): AnyObj {
  const cap: AnyObj = {
    cgroups: false,
    namespaces: false,
    seccomp: false,
    containerized: false,
    systemd: false
  };

  try { cap.cgroups = fs.existsSync('/sys/fs/cgroup'); } catch {}
  try { cap.namespaces = fs.existsSync('/proc/self/ns'); } catch {}
  try { cap.seccomp = fs.existsSync('/proc/sys/kernel/seccomp/actions_avail'); } catch {}
  try { cap.systemd = fs.existsSync('/run/systemd/system'); } catch {}

  try {
    if (fs.existsSync('/.dockerenv')) cap.containerized = true;
    else if (fs.existsSync('/proc/1/cgroup')) {
      const cgroup = fs.readFileSync('/proc/1/cgroup', 'utf8');
      cap.containerized = /(docker|containerd|kubepods|lxc)/i.test(cgroup);
    }
  } catch {}

  return cap;
}

function scoreConfidence(profile: AnyObj): number {
  let score = 0.35;
  if (profile.os_family && profile.os_family !== 'unknown') score += 0.15;
  if (profile.kernel && profile.kernel.release) score += 0.1;
  if (profile.arch && profile.arch !== 'unknown') score += 0.1;
  if (profile.distro && profile.distro !== 'unknown') score += 0.15;
  if (profile.variant && profile.variant !== 'unknown') score += 0.05;
  if (profile.cloud && profile.cloud.provider && profile.cloud.provider !== 'unknown') score += 0.05;
  const cap = profile.capabilities || {};
  const capSignals = ['cgroups', 'namespaces', 'seccomp', 'systemd'].filter((k) => cap[k] === true).length;
  score += Math.min(0.2, capSignals * 0.05);
  return Number(Math.max(0, Math.min(1, score)).toFixed(3));
}

function buildProfile(phase: string): AnyObj {
  const osRelease = readOsRelease();
  const osFamily = process.platform || 'unknown';
  const distro = cleanText(osRelease.ID || 'unknown', 120).toLowerCase() || 'unknown';
  const variant = cleanText(osRelease.VARIANT_ID || osRelease.ID_LIKE || 'unknown', 120).toLowerCase() || 'unknown';
  const cap = detectCapabilities();

  const profile: AnyObj = {
    schema_id: 'host_profile',
    schema_version: '1.0',
    probe_phase: cleanText(phase, 32) || 'boot',
    ts: nowIso(),
    os_family: cleanText(osFamily, 80) || 'unknown',
    distro,
    variant,
    arch: cleanText(process.arch || 'unknown', 80) || 'unknown',
    kernel: {
      type: cleanText(os.type() || 'unknown', 80) || 'unknown',
      release: cleanText(os.release() || 'unknown', 120) || 'unknown'
    },
    runtime: {
      node: cleanText(process.version || 'unknown', 80) || 'unknown',
      v8: cleanText(process.versions && process.versions.v8 ? process.versions.v8 : 'unknown', 80) || 'unknown',
      platform: cleanText(process.platform || 'unknown', 40) || 'unknown'
    },
    cloud: {
      provider: detectCloudProvider()
    },
    hardware: {
      cpu_count: os.cpus() ? Number(os.cpus().length || 0) : 0,
      memory_mb: Number((os.totalmem() / 1024 / 1024).toFixed(0)),
      hostname: cleanText(os.hostname() || 'unknown', 200) || 'unknown'
    },
    capabilities: cap,
    source: {
      os_release_present: Object.keys(osRelease).length > 0,
      os_release_id: cleanText(osRelease.ID || '', 120) || null
    }
  };
  profile.confidence = scoreConfidence(profile);
  return profile;
}

function stableHash(payload: AnyObj, secret: string): string {
  const h = crypto.createHmac('sha256', String(secret || ''));
  h.update(JSON.stringify(payload));
  return h.digest('hex');
}

function runProbe(policyPath: string, phase: string): AnyObj {
  const policy = loadPolicy(policyPath);
  if (policy.enabled === false) {
    return {
      ok: true,
      skipped: true,
      reason: 'disabled',
      type: 'platform_oracle_hostprofile',
      ts: nowIso(),
      policy_path: rel(policyPath)
    };
  }

  const candidate = buildProfile(phase);
  const lastKnownGood = readJson(policy.last_known_good_path, {});
  const hasLastGood = lastKnownGood && typeof lastKnownGood === 'object' && Object.keys(lastKnownGood).length > 0;

  const accepted = Number(candidate.confidence || 0) >= Number(policy.min_confidence || 0.65);
  let activeProfile = candidate;
  let failClosed = false;
  let rollbackApplied = false;
  let fallbackReason = '';

  if (!accepted) {
    failClosed = true;
    fallbackReason = 'confidence_below_threshold';
    if (hasLastGood) {
      activeProfile = {
        ...lastKnownGood,
        probe_phase: candidate.probe_phase,
        ts: candidate.ts,
        confidence: Number(lastKnownGood.confidence || 0),
        recovered_from: 'last_known_good'
      };
      rollbackApplied = true;
      fallbackReason = 'rollback_to_last_known_good';
    } else {
      activeProfile = {
        ...policy.fallback_profile,
        schema_id: 'host_profile',
        schema_version: '1.0',
        probe_phase: candidate.probe_phase,
        ts: candidate.ts,
        confidence: Number(candidate.confidence || 0),
        recovered_from: 'minimal_fallback'
      };
    }
  }

  const receiptCore = {
    type: 'platform_oracle_hostprofile',
    ts: nowIso(),
    phase: cleanText(phase || 'boot', 32) || 'boot',
    min_confidence: Number(policy.min_confidence || 0.65),
    candidate_confidence: Number(candidate.confidence || 0),
    active_confidence: Number(activeProfile.confidence || 0),
    fail_closed: failClosed,
    rollback_applied: rollbackApplied,
    fallback_reason: fallbackReason || null,
    host_profile: activeProfile,
    candidate_profile: candidate,
    state_path: rel(policy.state_path),
    history_path: rel(policy.history_path),
    last_known_good_path: rel(policy.last_known_good_path)
  };

  const signature = stableHash(receiptCore, policy.signing_secret);
  const receipt = {
    schema_id: 'platform_oracle_hostprofile_receipt',
    schema_version: '1.0',
    artifact_type: 'receipt',
    ok: true,
    ...receiptCore,
    signature
  };

  writeJsonAtomic(policy.state_path, receipt);
  appendJsonl(policy.history_path, receipt);

  if (!failClosed && Number(activeProfile.confidence || 0) >= Number(policy.min_confidence || 0.65)) {
    writeJsonAtomic(policy.last_known_good_path, activeProfile);
  }

  return receipt;
}

function cmdStatus(policyPath: string): void {
  const policy = loadPolicy(policyPath);
  const payload = readJson(policy.state_path, {
    ok: false,
    reason: 'status_not_found',
    type: 'platform_oracle_hostprofile',
    state_path: rel(policy.state_path)
  });
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

function usage(): void {
  console.log('Usage:');
  console.log('  node systems/ops/platform_oracle_hostprofile.js run [--phase=boot|promotion|periodic] [--strict=1|0] [--policy=<path>]');
  console.log('  node systems/ops/platform_oracle_hostprofile.js status [--policy=<path>]');
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const cmd = cleanText(args._[0] || 'status', 40).toLowerCase();
  if (args.help || cmd === 'help') {
    usage();
    process.exit(0);
  }

  const policyPath = args.policy
    ? (path.isAbsolute(String(args.policy)) ? String(args.policy) : path.join(ROOT, String(args.policy)))
    : DEFAULT_POLICY_PATH;

  if (cmd === 'status') {
    cmdStatus(policyPath);
    return;
  }

  if (cmd === 'run') {
    const phase = cleanText(args.phase || args._[1] || 'boot', 32).toLowerCase();
    const strict = toBool(args.strict, false);
    const out = runProbe(policyPath, phase || 'boot');
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    if (strict && out.ok !== true) process.exit(1);
    return;
  }

  usage();
  process.exit(2);
}

if (require.main === module) main();
