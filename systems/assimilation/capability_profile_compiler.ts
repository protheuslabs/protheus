#!/usr/bin/env node
'use strict';
export {};

/**
 * capability_profile_compiler.js
 *
 * V2-067:
 * - Canonical capability profile schema + compiler for profile-only onboarding.
 * - Validates provenance and legal metadata with deterministic receipts.
 * - Provides direct compile-from-research path for Assimilation/Research integration.
 *
 * Usage:
 *   node systems/assimilation/capability_profile_compiler.js compile --in=<profile.json> [--strict=1]
 *   node systems/assimilation/capability_profile_compiler.js from-research --capability-id=<id> --source-type=<type> --research-json=<json|@file> [--strict=1]
 *   node systems/assimilation/capability_profile_compiler.js validate --in=<profile.json> [--strict=1]
 *   node systems/assimilation/capability_profile_compiler.js status [--id=<profile_id>]
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.CAPABILITY_PROFILE_POLICY_PATH
  ? path.resolve(process.env.CAPABILITY_PROFILE_POLICY_PATH)
  : path.join(ROOT, 'config', 'capability_profile_policy.json');

function nowIso() {
  return new Date().toISOString();
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function cleanText(v: unknown, maxLen = 220) {
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

function clampNumber(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  if (n < lo) return lo;
  if (n > hi) return hi;
  return n;
}

function toBool(v: unknown, fallback = false) {
  if (v == null) return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
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

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
}

function resolvePath(raw: unknown, fallbackRel: string) {
  const text = cleanText(raw, 500);
  if (!text) return path.join(ROOT, fallbackRel);
  return path.isAbsolute(text) ? text : path.join(ROOT, text);
}

function stableStringify(value: unknown): string {
  if (value == null) return 'null';
  if (Array.isArray(value)) return `[${value.map((row) => stableStringify(row)).join(',')}]`;
  if (typeof value !== 'object') return JSON.stringify(value);
  const obj = value as AnyObj;
  return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

function shaHex(value: unknown) {
  return crypto.createHash('sha256').update(stableStringify(value), 'utf8').digest('hex');
}

function normalizeStringList(src: unknown, maxItems = 128, maxLen = 240) {
  if (!Array.isArray(src)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of src) {
    const text = cleanText(raw, maxLen);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= maxItems) break;
  }
  return out;
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    strict_validation: true,
    schema_path: 'config/capability_profile_schema.json',
    state: {
      root: 'state/assimilation/capability_profiles',
      profiles_dir: 'state/assimilation/capability_profiles/profiles',
      receipts_path: 'state/assimilation/capability_profiles/receipts.jsonl',
      latest_path: 'state/assimilation/capability_profiles/latest.json'
    },
    onboarding: {
      profile_only_path_enabled: true,
      require_provenance: true,
      max_profile_aliases: 64
    }
  };
}

function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  const state = src.state && typeof src.state === 'object' ? src.state : {};
  const onboarding = src.onboarding && typeof src.onboarding === 'object' ? src.onboarding : {};
  return {
    version: cleanText(src.version || base.version, 32) || base.version,
    enabled: src.enabled !== false,
    strict_validation: src.strict_validation !== false,
    schema_path: resolvePath(src.schema_path || base.schema_path, base.schema_path),
    state: {
      root: resolvePath(state.root || base.state.root, base.state.root),
      profiles_dir: resolvePath(state.profiles_dir || base.state.profiles_dir, base.state.profiles_dir),
      receipts_path: resolvePath(state.receipts_path || base.state.receipts_path, base.state.receipts_path),
      latest_path: resolvePath(state.latest_path || base.state.latest_path, base.state.latest_path)
    },
    onboarding: {
      profile_only_path_enabled: onboarding.profile_only_path_enabled !== false,
      require_provenance: onboarding.require_provenance !== false,
      max_profile_aliases: clampInt(onboarding.max_profile_aliases, 1, 10000, base.onboarding.max_profile_aliases)
    }
  };
}

function normalizeEndpoint(entry: AnyObj) {
  const method = normalizeToken(entry && entry.method || '', 12) || 'get';
  const route = cleanText(entry && (entry.path || entry.route) || '', 240);
  if (!route) return null;
  return { method, path: route };
}

function buildCanonicalProfile(input: AnyObj, meta: AnyObj = {}) {
  const source = input.source && typeof input.source === 'object' ? input.source : {};
  const surface = input.surface && typeof input.surface === 'object' ? input.surface : {};
  const api = surface.api && typeof surface.api === 'object' ? surface.api : {};
  const ui = surface.ui && typeof surface.ui === 'object' ? surface.ui : {};
  const auth = surface.auth && typeof surface.auth === 'object' ? surface.auth : {};
  const rateLimit = surface.rate_limit && typeof surface.rate_limit === 'object' ? surface.rate_limit : {};
  const err = surface.error && typeof surface.error === 'object' ? surface.error : {};
  const provenance = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};

  const endpoints: AnyObj[] = [];
  for (const row of Array.isArray(api.endpoints) ? api.endpoints : []) {
    const normalized = normalizeEndpoint(row && typeof row === 'object' ? row : {});
    if (normalized) endpoints.push(normalized);
  }
  const flows = normalizeStringList(ui.flows, 256, 240);
  const aliases = normalizeStringList(input.aliases, Number(meta.max_aliases || 64), 160)
    .map((row) => normalizeToken(row, 160))
    .filter(Boolean);

  const profileId = normalizeToken(input.profile_id || input.capability_id || source.capability_id || '', 160);
  const sourceType = normalizeToken(source.source_type || input.source_type || '', 40);
  const canonical: AnyObj = {
    schema_id: 'capability_profile',
    schema_version: cleanText(input.schema_version || '1.0', 24) || '1.0',
    generated_at: cleanText(input.generated_at || nowIso(), 40) || nowIso(),
    profile_id: profileId,
    aliases,
    source: {
      capability_id: normalizeToken(source.capability_id || input.capability_id || profileId, 160),
      source_type: sourceType,
      framework: normalizeToken(source.framework || input.framework || 'protheus', 80) || 'protheus',
      origin_ref: cleanText(source.origin_ref || provenance.origin || '', 300) || null
    },
    surface: {
      api: {
        endpoints,
        docs_urls: normalizeStringList(api.docs_urls, 128, 300),
        auth_model: normalizeToken(api.auth_model || auth.mode || 'unknown', 80) || 'unknown'
      },
      ui: {
        flows,
        selectors: normalizeStringList(ui.selectors, 256, 180)
      },
      auth: {
        mode: normalizeToken(auth.mode || api.auth_model || 'unknown', 80) || 'unknown',
        scopes: normalizeStringList(auth.scopes, 128, 120)
      },
      rate_limit: {
        hints: normalizeStringList(rateLimit.hints || api.rate_limits, 128, 200),
        retry_after_supported: rateLimit.retry_after_supported === true
      },
      error: {
        classes: normalizeStringList(err.classes || api.error_classes, 128, 160),
        retryable: normalizeStringList(err.retryable, 128, 160)
      }
    },
    intents: normalizeStringList(input.intents, 256, 180),
    constraints: {
      high_risk_classes: normalizeStringList(input.high_risk_classes, 64, 80).map((v) => normalizeToken(v, 80)).filter(Boolean),
      requires_human_approval: input.requires_human_approval === true
    },
    provenance: {
      origin: cleanText(provenance.origin || '', 300) || null,
      legal: {
        license: normalizeToken(
          provenance.legal && provenance.legal.license
          || provenance.license
          || '',
          80
        ) || null,
        tos_ok: provenance.legal && provenance.legal.tos_ok === true || provenance.tos_ok === true,
        robots_ok: provenance.legal && provenance.legal.robots_ok === true || provenance.robots_ok === true,
        data_rights_ok: provenance.legal && provenance.legal.data_rights_ok === true || provenance.data_rights_ok === true
      },
      confidence: clampNumber(provenance.confidence, 0, 1, 0),
      generated_by: cleanText(meta.generated_by || 'capability_profile_compiler', 80) || 'capability_profile_compiler',
      source_receipt_id: cleanText(provenance.source_receipt_id || '', 180) || null
    },
    evidence: {
      research: input.evidence && input.evidence.research && typeof input.evidence.research === 'object'
        ? input.evidence.research
        : {}
    }
  };
  canonical.profile_hash = shaHex(canonical);
  return canonical;
}

function hasActivitySurface(profile: AnyObj) {
  const api = profile && profile.surface && profile.surface.api && Array.isArray(profile.surface.api.endpoints)
    ? profile.surface.api.endpoints
    : [];
  const ui = profile && profile.surface && profile.surface.ui && Array.isArray(profile.surface.ui.flows)
    ? profile.surface.ui.flows
    : [];
  return api.length > 0 || ui.length > 0;
}

function validateProfile(profile: AnyObj, schema: AnyObj, policy: AnyObj = {}) {
  const failures: string[] = [];
  const requiredTop = Array.isArray(schema.required_top_level) ? schema.required_top_level : [];
  for (const key of requiredTop) {
    if (!(key in (profile || {}))) failures.push(`missing_top_level:${String(key)}`);
  }
  const requiredSource = Array.isArray(schema.required_source_fields) ? schema.required_source_fields : [];
  for (const key of requiredSource) {
    if (!(profile && profile.source && key in profile.source)) failures.push(`missing_source_field:${String(key)}`);
  }
  const sourceType = String(profile && profile.source && profile.source.source_type || '');
  const allowedSource = Array.isArray(schema.allowed_source_types) ? schema.allowed_source_types : [];
  if (!allowedSource.includes(sourceType)) failures.push(`source_type_not_allowed:${sourceType || 'unknown'}`);
  if (!hasActivitySurface(profile)) failures.push('surface_missing_activity_fields');

  const requiredSections = Array.isArray(schema.surface_contract && schema.surface_contract.required_sections)
    ? schema.surface_contract.required_sections
    : [];
  for (const section of requiredSections) {
    if (!(profile && profile.surface && section in profile.surface)) {
      failures.push(`surface_section_missing:${String(section)}`);
    }
  }

  if (policy.onboarding && policy.onboarding.require_provenance === true) {
    const legal = profile && profile.provenance && profile.provenance.legal
      ? profile.provenance.legal
      : {};
    const confidence = Number(profile && profile.provenance && profile.provenance.confidence || 0);
    if (!profile || !profile.provenance || !profile.provenance.origin) failures.push('provenance_origin_missing');
    if (!legal || legal.data_rights_ok !== true) failures.push('provenance_data_rights_required');
    if (confidence <= 0) failures.push('provenance_confidence_required');
  }

  return {
    ok: failures.length === 0,
    failures
  };
}

function profilePath(policy: AnyObj, profileId: string) {
  return path.join(policy.state.profiles_dir, `${profileId}.profile.json`);
}

function compileProfile(input: AnyObj, opts: AnyObj = {}) {
  const policy = opts.policy || loadPolicy(opts.policy_path || DEFAULT_POLICY_PATH);
  const schema = opts.schema || readJson(policy.schema_path, {});
  const canonical = buildCanonicalProfile(input, {
    generated_by: opts.generated_by || 'capability_profile_compiler',
    max_aliases: policy.onboarding && policy.onboarding.max_profile_aliases
  });
  const validation = validateProfile(canonical, schema, policy);
  const strict = opts.strict == null ? policy.strict_validation === true : opts.strict === true;
  const artifact = profilePath(policy, canonical.profile_id || 'unknown_profile');
  const ts = nowIso();
  const out = {
    ok: validation.ok || !strict,
    type: 'capability_profile_compile',
    ts,
    strict,
    profile_id: canonical.profile_id,
    profile_hash: canonical.profile_hash,
    validation,
    profile_path: relPath(artifact),
    receipts_path: relPath(policy.state.receipts_path)
  };
  if (out.ok) {
    writeJsonAtomic(artifact, canonical);
  }
  appendJsonl(policy.state.receipts_path, {
    ts,
    type: 'capability_profile_receipt',
    action: 'compile',
    ok: out.ok,
    strict,
    profile_id: canonical.profile_id,
    profile_hash: canonical.profile_hash,
    validation_failures: validation.failures,
    provenance: {
      origin: canonical.provenance.origin,
      confidence: canonical.provenance.confidence
    }
  });
  writeJsonAtomic(policy.state.latest_path, {
    ...out,
    profile: out.ok ? canonical : undefined
  });
  return {
    ...out,
    profile: canonical
  };
}

function parseJsonInlineOrFile(raw: string) {
  const text = String(raw || '').trim();
  if (!text) return null;
  if (text.startsWith('@')) {
    const filePath = path.resolve(text.slice(1));
    return readJson(filePath, null);
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function compileProfileFromResearch(input: AnyObj, opts: AnyObj = {}) {
  const research = input.research && typeof input.research === 'object' ? input.research : {};
  const legal = research.legal_surface && typeof research.legal_surface === 'object'
    ? research.legal_surface
    : {};
  const properties = research.properties && typeof research.properties === 'object'
    ? research.properties
    : {};
  const artifacts = research.artifacts && typeof research.artifacts === 'object'
    ? research.artifacts
    : {};
  const fallbackEndpoint = `/${String(input.capability_id || 'unknown').replace(/[^a-zA-Z0-9/_-]+/g, '/')}`;
  const sampleEndpoints = Array.isArray(artifacts.sample_api_endpoints) && artifacts.sample_api_endpoints.length > 0
    ? artifacts.sample_api_endpoints
    : [fallbackEndpoint];
  const profileInput = {
    schema_version: '1.0',
    generated_at: nowIso(),
    profile_id: input.profile_id || input.capability_id,
    aliases: input.aliases || [],
    source: {
      capability_id: input.capability_id,
      source_type: input.source_type,
      framework: input.framework || 'protheus',
      origin_ref: input.origin_ref || null
    },
    surface: {
      api: {
        endpoints: sampleEndpoints.map((row: string) => ({
          method: 'get',
          path: cleanText(row, 240)
        })),
        docs_urls: artifacts.docs_urls || [],
        auth_model: properties.auth_model || 'unknown',
        rate_limits: artifacts.rate_limits || []
      },
      ui: {
        flows: input.ui_flows || [],
        selectors: input.ui_selectors || []
      },
      auth: {
        mode: properties.auth_model || 'unknown',
        scopes: input.auth_scopes || []
      },
      rate_limit: {
        hints: artifacts.rate_limits || [],
        retry_after_supported: false
      },
      error: {
        classes: input.error_classes || [],
        retryable: input.retryable_errors || []
      }
    },
    intents: input.intents || [],
    high_risk_classes: input.high_risk_classes || [],
    requires_human_approval: input.requires_human_approval === true,
    provenance: {
      origin: input.origin || input.origin_ref || 'research_probe',
      confidence: clampNumber(research.confidence, 0, 1, 0),
      source_receipt_id: cleanText(input.source_receipt_id || '', 180) || null,
      legal: {
        license: legal.license || null,
        tos_ok: legal.tos_ok === true,
        robots_ok: legal.robots_ok === true,
        data_rights_ok: legal.data_rights_ok === true
      }
    },
    evidence: {
      research
    }
  };
  return compileProfile(profileInput, {
    ...opts,
    generated_by: opts.generated_by || 'assimilation_research_probe'
  });
}

function commandCompile(args: AnyObj, policy: AnyObj) {
  const inPath = cleanText(args.in || args.input || '', 400);
  if (!inPath) throw new Error('input_profile_path_required');
  const src = readJson(path.resolve(inPath), null);
  if (!src || typeof src !== 'object') throw new Error('input_profile_invalid_json');
  return compileProfile(src, {
    policy,
    strict: toBool(args.strict, policy.strict_validation === true)
  });
}

function commandFromResearch(args: AnyObj, policy: AnyObj) {
  const capabilityId = normalizeToken(args['capability-id'] || args.capability_id || '', 160);
  const sourceType = normalizeToken(args['source-type'] || args.source_type || '', 40);
  const rawResearch = cleanText(args['research-json'] || args.research_json || '', 20000);
  if (!capabilityId) throw new Error('capability_id_required');
  if (!sourceType) throw new Error('source_type_required');
  const research = parseJsonInlineOrFile(rawResearch);
  if (!research || typeof research !== 'object') throw new Error('research_json_invalid');
  return compileProfileFromResearch({
    capability_id: capabilityId,
    source_type: sourceType,
    research,
    origin_ref: cleanText(args['origin-ref'] || args.origin_ref || '', 300) || null,
    source_receipt_id: cleanText(args['source-receipt-id'] || args.source_receipt_id || '', 180) || null
  }, {
    policy,
    strict: toBool(args.strict, policy.strict_validation === true)
  });
}

function commandValidate(args: AnyObj, policy: AnyObj) {
  const inPath = cleanText(args.in || args.input || '', 400);
  if (!inPath) throw new Error('input_profile_path_required');
  const src = readJson(path.resolve(inPath), null);
  if (!src || typeof src !== 'object') throw new Error('input_profile_invalid_json');
  const schema = readJson(policy.schema_path, {});
  const canonical = buildCanonicalProfile(src, {
    generated_by: 'capability_profile_validate',
    max_aliases: policy.onboarding.max_profile_aliases
  });
  const validation = validateProfile(canonical, schema, policy);
  const out = {
    ok: validation.ok,
    type: 'capability_profile_validate',
    ts: nowIso(),
    profile_id: canonical.profile_id,
    validation
  };
  writeJsonAtomic(policy.state.latest_path, out);
  return out;
}

function commandStatus(args: AnyObj, policy: AnyObj) {
  const id = normalizeToken(args.id || args['profile-id'] || '', 160) || null;
  if (id) {
    const fp = profilePath(policy, id);
    return {
      ok: true,
      type: 'capability_profile_status',
      ts: nowIso(),
      profile_id: id,
      exists: fs.existsSync(fp),
      profile_path: relPath(fp),
      profile: readJson(fp, null)
    };
  }
  const latest = readJson(policy.state.latest_path, null);
  const profileFiles = fs.existsSync(policy.state.profiles_dir)
    ? fs.readdirSync(policy.state.profiles_dir).filter((f: string) => f.endsWith('.profile.json')).sort()
    : [];
  return {
    ok: true,
    type: 'capability_profile_status',
    ts: nowIso(),
    strict_validation: policy.strict_validation === true,
    profile_only_path_enabled: policy.onboarding.profile_only_path_enabled === true,
    profiles_total: profileFiles.length,
    latest: latest || null,
    profiles_dir: relPath(policy.state.profiles_dir)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || '').trim().toLowerCase();
  if (!cmd || cmd === '--help' || cmd === 'help' || cmd === '-h') {
    process.stdout.write(JSON.stringify({
      ok: true,
      type: 'capability_profile_help',
      script: 'capability_profile_compiler.js',
      usage: [
        'capability_profile_compiler.js compile --in=<profile.json> [--strict=1]',
        'capability_profile_compiler.js from-research --capability-id=<id> --source-type=<type> --research-json=<json|@file> [--strict=1]',
        'capability_profile_compiler.js validate --in=<profile.json> [--strict=1]',
        'capability_profile_compiler.js status [--id=<profile_id>]'
      ]
    }) + '\n');
    return;
  }
  const policyPath = path.resolve(String(args.policy || DEFAULT_POLICY_PATH));
  const policy = loadPolicy(policyPath);
  ensureDir(policy.state.root);
  ensureDir(policy.state.profiles_dir);
  if (policy.enabled !== true) throw new Error('capability_profile_compiler_disabled');

  let out;
  if (cmd === 'compile') out = commandCompile(args, policy);
  else if (cmd === 'from-research') out = commandFromResearch(args, policy);
  else if (cmd === 'validate') out = commandValidate(args, policy);
  else if (cmd === 'status' || !cmd) out = commandStatus(args, policy);
  else throw new Error(`unknown_command:${cmd}`);
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out && out.ok !== true && toBool(args.strict, false)) process.exit(1);
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`capability_profile_compiler.js: FAIL: ${err.message}\n`);
    process.exit(1);
  }
}

module.exports = {
  loadPolicy,
  buildCanonicalProfile,
  validateProfile,
  compileProfile,
  compileProfileFromResearch
};
