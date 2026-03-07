'use strict';

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');
const POLICY_PATH = process.env.MUTATION_PROVENANCE_POLICY_PATH
  ? path.resolve(String(process.env.MUTATION_PROVENANCE_POLICY_PATH))
  : path.join(REPO_ROOT, 'config', 'mutation_provenance_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function readJsonSafe(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function appendJsonl(filePath, row) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, JSON.stringify(row) + '\n', 'utf8');
}

function normalizeSource(v) {
  const raw = String(v || '').trim();
  if (!raw) return '';
  if (path.isAbsolute(raw)) return path.relative(REPO_ROOT, raw).replace(/\\/g, '/');
  return raw.replace(/\\/g, '/');
}

function normalizeMeta(meta, fallbackSource, defaultReason) {
  const m = (meta && typeof meta === 'object' ? { ...meta } : {}) as Record<string, any>;
  const source = normalizeSource(m.source || fallbackSource || '');
  const actor = String(m.actor || process.env.USER || 'unknown').trim().slice(0, 80);
  const reason = String(m.reason || defaultReason || '').trim().slice(0, 160);
  return {
    ...m,
    source,
    actor,
    reason
  };
}

function loadPolicy() {
  const fallback = {
    version: '1.0-fallback',
    channels: {
      adaptive: {
        allowed_source_prefixes: ['systems/adaptive/', 'systems/sensory/', 'systems/strategy/', 'systems/autonomy/', 'systems/spine/', 'lib/'],
        require_reason: true
      },
      memory: {
        allowed_source_prefixes: ['systems/memory/', 'systems/spine/', 'systems/adaptive/core/', 'lib/'],
        require_reason: true
      }
    }
  };
  const raw = readJsonSafe(POLICY_PATH, fallback);
  const policy = raw && typeof raw === 'object' ? raw : fallback;
  if (!policy.channels || typeof policy.channels !== 'object') policy.channels = fallback.channels;
  return {
    version: String(policy.version || fallback.version),
    channels: policy.channels
  };
}

function channelConfig(policy, channel) {
  const ch = policy && policy.channels && policy.channels[channel] && typeof policy.channels[channel] === 'object'
    ? policy.channels[channel]
    : {};
  const prefixes = Array.isArray(ch.allowed_source_prefixes)
    ? ch.allowed_source_prefixes.map((x) => String(x || '').replace(/\\/g, '/').trim()).filter(Boolean)
    : [];
  return {
    allowed_source_prefixes: prefixes,
    require_reason: ch.require_reason !== false
  };
}

function isStrict(channel, opts = {}) {
  if (opts && opts.strict === true) return true;
  if (String(process.env.MUTATION_PROVENANCE_STRICT || '').trim() === '1') return true;
  if (channel === 'adaptive' && String(process.env.ADAPTIVE_MUTATION_STRICT || '').trim() === '1') return true;
  if (channel === 'memory' && String(process.env.MEMORY_MUTATION_STRICT || '').trim() === '1') return true;
  return false;
}

function violationPath(channel) {
  return path.join(REPO_ROOT, 'state', 'security', `${String(channel || 'unknown')}_mutation_violations.jsonl`);
}

function auditPath(channel) {
  return path.join(REPO_ROOT, 'state', 'security', `${String(channel || 'unknown')}_mutations.jsonl`);
}

function enforceMutationProvenance(channel, meta, opts = {}) {
  const ch = String(channel || '').trim().toLowerCase();
  const policy = loadPolicy();
  const cfg = channelConfig(policy, ch);
  const normalized = normalizeMeta(meta, opts.fallbackSource || '', opts.defaultReason || '');
  const source = normalizeSource(normalized.source);
  const violations = [];

  if (!source) {
    violations.push('missing_source');
  } else {
    const allowed = cfg.allowed_source_prefixes.some((prefix) => source === prefix.replace(/\/$/, '') || source.startsWith(prefix));
    if (!allowed) violations.push('source_not_allowlisted');
  }

  if (cfg.require_reason && !String(normalized.reason || '').trim()) {
    violations.push('missing_reason');
  }

  const out = {
    ok: violations.length === 0,
    channel: ch,
    policy_version: policy.version,
    meta: normalized,
    source_rel: source,
    violations
  };

  if (!out.ok) {
    appendJsonl(violationPath(ch), {
      ts: nowIso(),
      type: 'mutation_provenance_violation',
      channel: ch,
      policy_version: policy.version,
      source: source || null,
      reason: normalized.reason || null,
      actor: normalized.actor || null,
      context: String(opts.context || '').slice(0, 200) || null,
      violations
    });
    if (isStrict(ch, opts)) {
      throw new Error(`mutation_provenance_blocked:${ch}:${violations.join(',')}`);
    }
  }

  return out;
}

function recordMutationAudit(channel, row = {}) {
  const ch = String(channel || '').trim().toLowerCase() || 'unknown';
  const payload = (row && typeof row === 'object' ? row : {}) as Record<string, any>;
  appendJsonl(auditPath(ch), {
    ts: nowIso(),
    channel: ch,
    ...payload
  });
}

module.exports = {
  normalizeMeta,
  loadPolicy,
  enforceMutationProvenance,
  recordMutationAudit
};

export {};
