#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.HARDWARE_ASSIMILATION_POLICY_PATH
  ? path.resolve(process.env.HARDWARE_ASSIMILATION_POLICY_PATH)
  : path.join(ROOT, 'config', 'hardware_assimilation_policy.json');

type AnyObj = Record<string, any>;

function nowIso() {
  return new Date().toISOString();
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/hardware/attested_assimilation_plane.js join --node-id=<id> --attestation=<token> --constitution-hash=<sha256> [--capabilities-json="{...}"]');
  console.log('  node systems/hardware/attested_assimilation_plane.js heartbeat --node-id=<id>');
  console.log('  node systems/hardware/attested_assimilation_plane.js schedule --work-id=<id> [--required-ram-gb=<n>] [--required-cpu-threads=<n>] [--lease-sec=<n>]');
  console.log('  node systems/hardware/attested_assimilation_plane.js complete --lease-id=<id>');
  console.log('  node systems/hardware/attested_assimilation_plane.js eject --node-id=<id> --reason="..."');
  console.log('  node systems/hardware/attested_assimilation_plane.js status');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (const token of argv) {
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx < 0) out[token.slice(2)] = true;
    else out[token.slice(2, idx)] = token.slice(idx + 1);
  }
  return out;
}

function cleanText(v: unknown, maxLen = 320) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, payload: any) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, row: any) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function sha256File(filePath: string) {
  try {
    const body = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(body).digest('hex');
  } catch {
    return null;
  }
}

function defaultPolicy() {
  return {
    version: '1.0',
    constitution_path: 'AGENT-CONSTITUTION.md',
    state_path: 'state/hardware/assimilation_plane/state.json',
    audit_path: 'state/hardware/assimilation_plane/audit.jsonl',
    required_attestation_secret_env: 'HARDWARE_ASSIMILATION_SECRET',
    idle_dormant_sec: 300,
    max_nodes: 256,
    compatibility: {
      required_capabilities: ['ram_gb', 'cpu_threads', 'arch'],
      min_ram_gb: 1,
      min_cpu_threads: 1,
      allowed_arches: [],
      required_node_profile_version: null
    },
    scheduler: {
      default_lease_sec: 120,
      max_lease_sec: 1800,
      max_leases_per_node: 8,
      min_leases_per_node: 1,
      baseline_cpu_threads_per_lease: 2,
      baseline_ram_gb_per_lease: 2,
      work_steal_enabled: true
    }
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const compatibilityRaw = src.compatibility && typeof src.compatibility === 'object' ? src.compatibility : {};
  const schedulerRaw = src.scheduler && typeof src.scheduler === 'object' ? src.scheduler : {};
  return {
    version: cleanText(src.version || base.version, 32) || '1.0',
    constitution_path: cleanText(src.constitution_path || base.constitution_path, 260) || base.constitution_path,
    state_path: cleanText(src.state_path || base.state_path, 260) || base.state_path,
    audit_path: cleanText(src.audit_path || base.audit_path, 260) || base.audit_path,
    required_attestation_secret_env: cleanText(src.required_attestation_secret_env || base.required_attestation_secret_env, 80) || base.required_attestation_secret_env,
    idle_dormant_sec: clampInt(src.idle_dormant_sec, 5, 86400, base.idle_dormant_sec),
    max_nodes: clampInt(src.max_nodes, 1, 100000, base.max_nodes),
    compatibility: {
      required_capabilities: Array.isArray(compatibilityRaw.required_capabilities)
        ? compatibilityRaw.required_capabilities.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean).slice(0, 32)
        : base.compatibility.required_capabilities.slice(0),
      min_ram_gb: Math.max(0, Number(compatibilityRaw.min_ram_gb != null ? compatibilityRaw.min_ram_gb : base.compatibility.min_ram_gb) || base.compatibility.min_ram_gb),
      min_cpu_threads: Math.max(0, Number(compatibilityRaw.min_cpu_threads != null ? compatibilityRaw.min_cpu_threads : base.compatibility.min_cpu_threads) || base.compatibility.min_cpu_threads),
      allowed_arches: Array.isArray(compatibilityRaw.allowed_arches)
        ? compatibilityRaw.allowed_arches.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean).slice(0, 16)
        : [],
      required_node_profile_version: compatibilityRaw.required_node_profile_version == null
        ? null
        : cleanText(compatibilityRaw.required_node_profile_version, 40) || null
    },
    scheduler: {
      default_lease_sec: clampInt(schedulerRaw.default_lease_sec, 10, 86400, base.scheduler.default_lease_sec),
      max_lease_sec: clampInt(schedulerRaw.max_lease_sec, 10, 86400, base.scheduler.max_lease_sec),
      max_leases_per_node: clampInt(schedulerRaw.max_leases_per_node, 1, 10000, base.scheduler.max_leases_per_node),
      min_leases_per_node: clampInt(schedulerRaw.min_leases_per_node, 1, 1000, base.scheduler.min_leases_per_node),
      baseline_cpu_threads_per_lease: clampInt(schedulerRaw.baseline_cpu_threads_per_lease, 1, 256, base.scheduler.baseline_cpu_threads_per_lease),
      baseline_ram_gb_per_lease: clampInt(schedulerRaw.baseline_ram_gb_per_lease, 1, 4096, base.scheduler.baseline_ram_gb_per_lease),
      work_steal_enabled: schedulerRaw.work_steal_enabled !== false
    }
  };
}

function resolveStatePath(policy: AnyObj) {
  return path.isAbsolute(policy.state_path)
    ? policy.state_path
    : path.join(ROOT, policy.state_path);
}

function resolveAuditPath(policy: AnyObj) {
  return path.isAbsolute(policy.audit_path)
    ? policy.audit_path
    : path.join(ROOT, policy.audit_path);
}

function constitutionHash(policy: AnyObj) {
  const constitution = path.isAbsolute(policy.constitution_path)
    ? policy.constitution_path
    : path.join(ROOT, policy.constitution_path);
  return sha256File(constitution);
}

function defaultState() {
  return {
    schema_id: 'attested_assimilation_plane_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    nodes: {},
    leases: {}
  };
}

function loadState(policy: AnyObj) {
  const statePath = resolveStatePath(policy);
  const src = readJson(statePath, null);
  if (!src || typeof src !== 'object') return defaultState();
  return {
    schema_id: 'attested_assimilation_plane_state',
    schema_version: '1.0',
    updated_at: cleanText(src.updated_at || nowIso(), 64),
    nodes: src.nodes && typeof src.nodes === 'object' ? src.nodes : {},
    leases: src.leases && typeof src.leases === 'object' ? src.leases : {}
  };
}

function saveState(policy: AnyObj, state: AnyObj) {
  const statePath = resolveStatePath(policy);
  writeJsonAtomic(statePath, {
    schema_id: 'attested_assimilation_plane_state',
    schema_version: '1.0',
    updated_at: nowIso(),
    nodes: state && state.nodes && typeof state.nodes === 'object' ? state.nodes : {},
    leases: state && state.leases && typeof state.leases === 'object' ? state.leases : {}
  });
}

function audit(policy: AnyObj, row: AnyObj) {
  appendJsonl(resolveAuditPath(policy), {
    ts: nowIso(),
    ...row
  });
}

function loadCapabilities(arg: unknown) {
  try {
    if (!arg) return {};
    const parsed = JSON.parse(String(arg));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function expectedAttestation(secret: string, nodeId: string, constitutionSha: string) {
  return crypto.createHmac('sha256', secret).update(`${nodeId}|${constitutionSha}`, 'utf8').digest('hex');
}

function dormantSweep(policy: AnyObj, state: AnyObj) {
  const nowMs = Date.now();
  const cutoff = nowMs - (policy.idle_dormant_sec * 1000);
  for (const [nodeId, node] of Object.entries(state.nodes || {})) {
    const row = node && typeof node === 'object' ? node as AnyObj : {};
    const seenMs = Date.parse(String(row.last_seen_at || ''));
    if (!Number.isFinite(seenMs)) continue;
    if (seenMs < cutoff && row.status === 'active') {
      row.status = 'dormant';
      row.updated_at = nowIso();
      state.nodes[nodeId] = row;
      audit(policy, {
        type: 'node_auto_dormant',
        node_id: nodeId
      });
    }
  }
}

function activeLeasesForNode(state: AnyObj, nodeId: string) {
  const nowMs = Date.now();
  return Object.values(state.leases || {}).filter((lease: any) => {
    if (!lease || typeof lease !== 'object') return false;
    if (String(lease.node_id || '') !== String(nodeId || '')) return false;
    const expiresMs = Date.parse(String(lease.expires_at || ''));
    return Number.isFinite(expiresMs) && expiresMs > nowMs && lease.status === 'active';
  }).length;
}

function sweepExpiredLeases(policy: AnyObj, state: AnyObj) {
  const nowMs = Date.now();
  for (const [leaseId, lease] of Object.entries(state.leases || {})) {
    const row = lease && typeof lease === 'object' ? lease as AnyObj : {};
    if (String(row.status || '') !== 'active') continue;
    const expiresMs = Date.parse(String(row.expires_at || ''));
    if (!Number.isFinite(expiresMs)) continue;
    if (expiresMs <= nowMs) {
      row.status = policy.scheduler.work_steal_enabled ? 'expired_reassignable' : 'expired';
      row.updated_at = nowIso();
      state.leases[leaseId] = row;
      audit(policy, {
        type: 'lease_expired',
        lease_id: leaseId,
        node_id: row.node_id,
        work_id: row.work_id,
        reassignable: row.status === 'expired_reassignable'
      });
    }
  }
}

function nodeMeetsRequirement(node: AnyObj, reqRam: number, reqCpu: number) {
  const caps = node.capabilities && typeof node.capabilities === 'object' ? node.capabilities : {};
  const ram = Number(caps.ram_gb || 0);
  const cpu = Number(caps.cpu_threads || 0);
  return ram >= reqRam && cpu >= reqCpu;
}

function nodeElasticLeaseLimit(policy: AnyObj, node: AnyObj) {
  const caps = node && node.capabilities && typeof node.capabilities === 'object' ? node.capabilities : {};
  const cpu = Math.max(0, Number(caps.cpu_threads || 0));
  const ram = Math.max(0, Number(caps.ram_gb || 0));
  const cpuPerLease = Math.max(1, Number(policy && policy.scheduler && policy.scheduler.baseline_cpu_threads_per_lease || 2));
  const ramPerLease = Math.max(1, Number(policy && policy.scheduler && policy.scheduler.baseline_ram_gb_per_lease || 2));
  const minLeases = Math.max(1, Number(policy && policy.scheduler && policy.scheduler.min_leases_per_node || 1));
  const maxLeases = Math.max(minLeases, Number(policy && policy.scheduler && policy.scheduler.max_leases_per_node || 8));
  const cpuCapacity = Math.max(0, Math.floor(cpu / cpuPerLease));
  const ramCapacity = Math.max(0, Math.floor(ram / ramPerLease));
  let elastic = Math.min(cpuCapacity, ramCapacity);
  if (!Number.isFinite(elastic) || elastic <= 0) elastic = minLeases;
  return clampInt(elastic, minLeases, maxLeases, minLeases);
}

function validateNodeCompatibility(policy: AnyObj, caps: AnyObj) {
  const comp = policy && policy.compatibility && typeof policy.compatibility === 'object'
    ? policy.compatibility
    : {};
  const requiredCaps = Array.isArray(comp.required_capabilities)
    ? comp.required_capabilities
    : ['ram_gb', 'cpu_threads'];
  const out: string[] = [];
  for (const key of requiredCaps) {
    const token = normalizeToken(key, 80);
    if (!token) continue;
    if (!Object.prototype.hasOwnProperty.call(caps || {}, token)) out.push(`missing_capability:${token}`);
  }
  const ram = Number(caps && caps.ram_gb || 0);
  const cpu = Number(caps && caps.cpu_threads || 0);
  const minRam = Math.max(0, Number(comp.min_ram_gb || 0));
  const minCpu = Math.max(0, Number(comp.min_cpu_threads || 0));
  if (!Number.isFinite(ram) || ram < minRam) out.push('ram_below_minimum');
  if (!Number.isFinite(cpu) || cpu < minCpu) out.push('cpu_below_minimum');
  const allowedArches = Array.isArray(comp.allowed_arches)
    ? comp.allowed_arches.map((row: unknown) => normalizeToken(row, 40)).filter(Boolean)
    : [];
  const arch = normalizeToken(caps && (caps.arch || caps.cpu_arch), 40);
  if (allowedArches.length && (!arch || !allowedArches.includes(arch))) out.push('arch_not_allowed');
  const requiredProfileVersion = cleanText(comp.required_node_profile_version || '', 40);
  if (requiredProfileVersion) {
    const profileVersion = cleanText(caps && (caps.node_profile_version || caps.profile_version), 40);
    if (!profileVersion || profileVersion !== requiredProfileVersion) out.push('node_profile_version_mismatch');
  }
  return {
    ok: out.length === 0,
    reasons: out
  };
}

function findReassignableLease(state: AnyObj, workId: string) {
  const rows: AnyObj[] = [];
  for (const [leaseId, lease] of Object.entries(state.leases || {})) {
    const row = lease && typeof lease === 'object' ? lease as AnyObj : {};
    if (String(row.work_id || '') !== workId) continue;
    if (String(row.status || '') !== 'expired_reassignable') continue;
    rows.push({ lease_id: leaseId, ...row });
  }
  rows.sort((a, b) => String(a.expires_at || '').localeCompare(String(b.expires_at || '')));
  return rows.length ? rows[0] : null;
}

function cmdJoin(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  dormantSweep(policy, state);
  sweepExpiredLeases(policy, state);

  const nodeId = normalizeToken(args.node_id || args['node-id'] || '', 120);
  const attestation = cleanText(args.attestation || '', 180);
  const providedConstitutionHash = cleanText(args.constitution_hash || args['constitution-hash'] || '', 120).toLowerCase();
  const caps = loadCapabilities(args.capabilities_json || args['capabilities-json']);
  if (!nodeId || !attestation || !providedConstitutionHash) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_join', error: 'node_id_attestation_constitution_hash_required' })}\n`);
    process.exit(1);
  }
  const currentConstitutionHash = String(constitutionHash(policy) || '').toLowerCase();
  if (!currentConstitutionHash || providedConstitutionHash !== currentConstitutionHash) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_join', error: 'constitution_hash_mismatch', expected: currentConstitutionHash || null })}\n`);
    process.exit(1);
  }
  const secret = String(process.env[policy.required_attestation_secret_env] || '').trim();
  if (!secret) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_join', error: 'attestation_secret_missing' })}\n`);
    process.exit(1);
  }
  const expected = expectedAttestation(secret, nodeId, currentConstitutionHash);
  if (attestation.toLowerCase() !== expected.toLowerCase()) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_join', error: 'attestation_invalid' })}\n`);
    process.exit(1);
  }
  const compatibility = validateNodeCompatibility(policy, caps);
  if (!compatibility.ok) {
    process.stdout.write(`${JSON.stringify({
      ok: false,
      type: 'hardware_join',
      error: 'capability_incompatible',
      reasons: compatibility.reasons
    })}\n`);
    process.exit(1);
  }

  const nodeCount = Object.keys(state.nodes || {}).length;
  if (!state.nodes[nodeId] && nodeCount >= policy.max_nodes) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_join', error: 'max_nodes_reached' })}\n`);
    process.exit(1);
  }

  state.nodes[nodeId] = {
    node_id: nodeId,
    status: 'active',
    joined_at: state.nodes[nodeId] && state.nodes[nodeId].joined_at ? state.nodes[nodeId].joined_at : nowIso(),
    last_seen_at: nowIso(),
    capabilities: caps,
    constitution_hash: currentConstitutionHash,
    lease_capacity: nodeElasticLeaseLimit(policy, { capabilities: caps }),
    attested: true,
    updated_at: nowIso()
  };
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'hardware_join',
    ts: nowIso(),
    node: state.nodes[nodeId]
  };
  audit(policy, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdHeartbeat(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  dormantSweep(policy, state);
  sweepExpiredLeases(policy, state);
  const nodeId = normalizeToken(args.node_id || args['node-id'] || '', 120);
  if (!nodeId || !state.nodes[nodeId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_heartbeat', error: 'node_not_found' })}\n`);
    process.exit(1);
  }
  state.nodes[nodeId].status = 'active';
  state.nodes[nodeId].last_seen_at = nowIso();
  state.nodes[nodeId].updated_at = nowIso();
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'hardware_heartbeat',
    ts: nowIso(),
    node_id: nodeId,
    status: state.nodes[nodeId].status
  };
  audit(policy, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdSchedule(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  dormantSweep(policy, state);
  sweepExpiredLeases(policy, state);

  const workId = normalizeToken(args.work_id || args['work-id'] || '', 140);
  const reqRam = clampInt(args.required_ram_gb || args['required-ram-gb'], 0, 100000, 0);
  const reqCpu = clampInt(args.required_cpu_threads || args['required-cpu-threads'], 0, 100000, 0);
  const leaseSec = clampInt(
    args.lease_sec || args['lease-sec'],
    10,
    policy.scheduler.max_lease_sec,
    policy.scheduler.default_lease_sec
  );
  if (!workId) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_schedule', error: 'work_id_required' })}\n`);
    process.exit(1);
  }

  const candidates = Object.values(state.nodes || {})
    .filter((node: any) => node && node.status === 'active' && node.attested === true)
    .filter((node: any) => nodeMeetsRequirement(node, reqRam, reqCpu))
    .filter((node: any) => activeLeasesForNode(state, node.node_id) < nodeElasticLeaseLimit(policy, node))
    .sort((a: any, b: any) => {
      const aLimit = nodeElasticLeaseLimit(policy, a);
      const bLimit = nodeElasticLeaseLimit(policy, b);
      const aLoad = activeLeasesForNode(state, a.node_id) / Math.max(1, aLimit);
      const bLoad = activeLeasesForNode(state, b.node_id) / Math.max(1, bLimit);
      if (aLoad !== bLoad) return aLoad - bLoad;
      if (bLimit !== aLimit) return bLimit - aLimit;
      return String(a.node_id || '').localeCompare(String(b.node_id || ''));
    });

  if (!candidates.length) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_schedule', error: 'no_eligible_node' })}\n`);
    process.exit(1);
  }

  const node = candidates[0];
  const priorLease = policy.scheduler.work_steal_enabled
    ? findReassignableLease(state, workId)
    : null;
  const leaseId = normalizeToken(`lease_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`, 120);
  const expiresAt = new Date(Date.now() + leaseSec * 1000).toISOString();
  state.leases[leaseId] = {
    lease_id: leaseId,
    work_id: workId,
    node_id: node.node_id,
    status: 'active',
    issued_at: nowIso(),
    expires_at: expiresAt,
    reissued_from_lease_id: priorLease ? String(priorLease.lease_id || '') : null,
    required_ram_gb: reqRam,
    required_cpu_threads: reqCpu,
    updated_at: nowIso()
  };
  if (priorLease && priorLease.lease_id && state.leases[priorLease.lease_id]) {
    state.leases[priorLease.lease_id].status = 'reissued';
    state.leases[priorLease.lease_id].reissued_by_lease_id = leaseId;
    state.leases[priorLease.lease_id].updated_at = nowIso();
  }
  state.nodes[node.node_id].lease_capacity = nodeElasticLeaseLimit(policy, node);
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'hardware_schedule',
    ts: nowIso(),
    lease: state.leases[leaseId],
    node: state.nodes[node.node_id],
    lease_capacity: state.nodes[node.node_id].lease_capacity || null
  };
  audit(policy, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdComplete(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  const leaseId = normalizeToken(args.lease_id || args['lease-id'] || '', 120);
  if (!leaseId || !state.leases[leaseId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_complete', error: 'lease_not_found' })}\n`);
    process.exit(1);
  }
  state.leases[leaseId].status = 'completed';
  state.leases[leaseId].completed_at = nowIso();
  state.leases[leaseId].updated_at = nowIso();
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'hardware_complete',
    ts: nowIso(),
    lease: state.leases[leaseId]
  };
  audit(policy, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdEject(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  const nodeId = normalizeToken(args.node_id || args['node-id'] || '', 120);
  const reason = cleanText(args.reason || '', 320);
  if (!nodeId || !state.nodes[nodeId]) {
    process.stdout.write(`${JSON.stringify({ ok: false, type: 'hardware_eject', error: 'node_not_found' })}\n`);
    process.exit(1);
  }
  state.nodes[nodeId].status = 'ejected';
  state.nodes[nodeId].updated_at = nowIso();
  for (const lease of Object.values(state.leases || {})) {
    const row = lease && typeof lease === 'object' ? lease as AnyObj : {};
    if (String(row.node_id || '') !== nodeId) continue;
    if (String(row.status || '') === 'active') {
      row.status = policy.scheduler.work_steal_enabled ? 'expired_reassignable' : 'expired';
      row.updated_at = nowIso();
    }
  }
  saveState(policy, state);
  const out = {
    ok: true,
    type: 'hardware_eject',
    ts: nowIso(),
    node_id: nodeId,
    reason: reason || null
  };
  audit(policy, out);
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function cmdStatus(args: AnyObj) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const state = loadState(policy);
  dormantSweep(policy, state);
  sweepExpiredLeases(policy, state);
  saveState(policy, state);

  const out = {
    ok: true,
    type: 'hardware_status',
    ts: nowIso(),
    policy_version: policy.version,
    constitution_hash: constitutionHash(policy),
    nodes: state.nodes,
    leases: state.leases
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'join') return cmdJoin(args);
  if (cmd === 'heartbeat') return cmdHeartbeat(args);
  if (cmd === 'schedule') return cmdSchedule(args);
  if (cmd === 'complete') return cmdComplete(args);
  if (cmd === 'eject') return cmdEject(args);
  if (cmd === 'status') return cmdStatus(args);
  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
