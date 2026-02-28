#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const ROOT = path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.ACCOUNT_CREATION_PROFILE_EXTENSION_POLICY_PATH
  ? path.resolve(process.env.ACCOUNT_CREATION_PROFILE_EXTENSION_POLICY_PATH)
  : path.join(ROOT, 'config', 'account_creation_profile_extension_policy.json');

function nowIso() { return new Date().toISOString(); }
function cleanText(v: unknown, maxLen = 260) { return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen); }
function normalizeToken(v: unknown, maxLen = 180) { return cleanText(v, maxLen).toLowerCase().replace(/[^a-z0-9_.:/-]+/g, '_').replace(/_+/g, '_').replace(/^_+|_+$/g, ''); }
function ensureDir(dirPath: string) { fs.mkdirSync(dirPath, { recursive: true }); }
function readJson(filePath: string, fallback: any) { try { if (!fs.existsSync(filePath)) return fallback; const p = JSON.parse(fs.readFileSync(filePath, 'utf8')); return p == null ? fallback : p; } catch { return fallback; } }
function appendJsonl(filePath: string, row: AnyObj) { ensureDir(path.dirname(filePath)); fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8'); }
function writeJsonAtomic(filePath: string, value: AnyObj) { ensureDir(path.dirname(filePath)); const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`; fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); fs.renameSync(tmp, filePath); }
function relPath(filePath: string) { return path.relative(ROOT, filePath).replace(/\\/g, '/'); }
function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) { out._.push(tok); continue; }
    const idx = tok.indexOf('=');
    if (idx >= 0) { out[tok.slice(2, idx)] = tok.slice(idx + 1); continue; }
    const key = tok.slice(2); const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) { out[key] = String(next); i += 1; continue; }
    out[key] = true;
  }
  return out;
}
function resolvePath(raw: unknown, fallbackRel: string) { const txt = cleanText(raw || '', 520); if (!txt) return path.join(ROOT, fallbackRel); return path.isAbsolute(txt) ? txt : path.join(ROOT, txt); }

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    templates_path: 'config/account_creation_templates.json',
    output_profiles_root: 'state/assimilation/capability_profiles/profiles',
    receipts_path: 'state/workflow/account_creation_profile_extension/receipts.jsonl',
    latest_path: 'state/workflow/account_creation_profile_extension/latest.json',
    required_primitives: ['desktop_ui', 'alias_verification_vault']
  };
}

function loadPolicy(policyPath = POLICY_PATH) {
  const src = readJson(policyPath, {});
  const base = defaultPolicy();
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    templates_path: resolvePath(src.templates_path || base.templates_path, base.templates_path),
    output_profiles_root: resolvePath(src.output_profiles_root || base.output_profiles_root, base.output_profiles_root),
    receipts_path: resolvePath(src.receipts_path || base.receipts_path, base.receipts_path),
    latest_path: resolvePath(src.latest_path || base.latest_path, base.latest_path),
    required_primitives: Array.isArray(src.required_primitives)
      ? src.required_primitives.map((row: unknown) => normalizeToken(row, 80)).filter(Boolean)
      : base.required_primitives.slice(0)
  };
}

function compile(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  if (policy.enabled !== true) return { ok: false, type: 'account_creation_profile_extension_compile', error: 'policy_disabled' };

  const templates = readJson(policy.templates_path, {});
  const templateRows = Array.isArray(templates.templates) ? templates.templates : [];
  const targetTemplate = normalizeToken(args['template-id'] || args.template_id || '', 180);
  const selected = targetTemplate
    ? templateRows.filter((row: AnyObj) => normalizeToken(row && row.id || '', 180) === targetTemplate)
    : templateRows;
  if (!selected.length) {
    return {
      ok: false,
      type: 'account_creation_profile_extension_compile',
      error: 'template_not_found',
      template_id: targetTemplate || null
    };
  }

  ensureDir(policy.output_profiles_root);
  const compiled: AnyObj[] = [];
  for (const template of selected) {
    const templateId = normalizeToken(template.id || 'template', 180) || 'template';
    const profile = {
      schema_id: 'capability_profile',
      schema_version: '1.0',
      profile_id: `account_create_${templateId}`,
      source: {
        capability_id: `account_create_${templateId}`,
        source_type: 'desktop_ui',
        provider: normalizeToken(template.provider || template.platform || 'generic', 120) || 'generic'
      },
      execution: {
        adapter_kind: 'browser_task',
        intent: 'account_creation',
        parameters: {
          template_id: templateId,
          alias_required: true,
          verification_vault_required: true,
          high_risk_gate: true
        }
      },
      metadata: {
        generated_by: 'account_creation_profile_extension',
        generated_at: nowIso(),
        template_name: cleanText(template.name || templateId, 120),
        primitives: policy.required_primitives,
        no_bespoke_kernel_branching: true
      }
    };
    const outPath = path.join(policy.output_profiles_root, `${profile.profile_id}.json`);
    writeJsonAtomic(outPath, profile);
    compiled.push({
      template_id: templateId,
      profile_id: profile.profile_id,
      profile_path: relPath(outPath)
    });
  }

  const out = {
    ok: true,
    type: 'account_creation_profile_extension_compile',
    ts: nowIso(),
    compiled_count: compiled.length,
    compiled,
    templates_path: relPath(policy.templates_path),
    output_profiles_root: relPath(policy.output_profiles_root)
  };
  appendJsonl(policy.receipts_path, out);
  writeJsonAtomic(policy.latest_path, out);
  return out;
}

function status(args: AnyObj = {}) {
  const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : POLICY_PATH);
  const latest = readJson(policy.latest_path, null);
  const receiptsCount = fs.existsSync(policy.receipts_path)
    ? String(fs.readFileSync(policy.receipts_path, 'utf8') || '').split('\n').filter(Boolean).length
    : 0;
  return {
    ok: true,
    type: 'account_creation_profile_extension_status',
    ts: nowIso(),
    receipts_count: receiptsCount,
    latest: latest && typeof latest === 'object'
      ? {
        ts: latest.ts || null,
        compiled_count: Number(latest.compiled_count || 0)
      }
      : null,
    paths: {
      templates_path: relPath(policy.templates_path),
      output_profiles_root: relPath(policy.output_profiles_root),
      receipts_path: relPath(policy.receipts_path),
      latest_path: relPath(policy.latest_path)
    }
  };
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/workflow/account_creation_profile_extension.js compile [--template-id=<id>]');
  console.log('  node systems/workflow/account_creation_profile_extension.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  let out: AnyObj;
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'compile') out = compile(args);
  else if (cmd === 'status') out = status(args);
  else out = { ok: false, type: 'account_creation_profile_extension', error: `unknown_command:${cmd}` };
  process.stdout.write(`${JSON.stringify(out)}\n`);
  if (out.ok !== true) process.exitCode = 1;
}

if (require.main === module) {
  main();
}

module.exports = {
  loadPolicy,
  compile,
  status
};
