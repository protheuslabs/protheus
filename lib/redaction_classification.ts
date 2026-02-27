'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_POLICY_PATH = process.env.REDACTION_CLASSIFICATION_POLICY_PATH
  ? path.resolve(String(process.env.REDACTION_CLASSIFICATION_POLICY_PATH))
  : path.join(ROOT, 'config', 'redaction_classification_policy.json');

type AnyObj = Record<string, any>;

function readJsonSafe(filePath: string, fallback: AnyObj) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
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

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
}

function sha256Hex(input: string) {
  return crypto.createHash('sha256').update(String(input || ''), 'utf8').digest('hex');
}

function defaultPolicy() {
  return {
    version: '1.0',
    enabled: true,
    max_text_bytes: 16384,
    redact_on_block: true,
    text_fields_allowlist: [
      'workflow_id',
      'workflow_status',
      'failure_reason',
      'message',
      'error',
      'stderr',
      'stdout',
      'summary',
      'notes',
      'reason',
      'command'
    ],
    rules: [
      {
        id: 'pii_email',
        category: 'pii',
        action: 'redact',
        regex: '[A-Z0-9._%+-]+@[A-Z0-9.-]+\\.[A-Z]{2,}',
        flags: 'gi'
      },
      {
        id: 'pii_phone',
        category: 'pii',
        action: 'redact',
        regex: '(?:\\+?\\d[\\d\\-()\\s]{7,}\\d)',
        flags: 'g'
      },
      {
        id: 'secret_assignment',
        category: 'secret',
        action: 'block',
        regex: '(?:api[_-]?key|secret|token|password)\\s*[:=]\\s*[A-Za-z0-9_\\-]{8,}',
        flags: 'gi'
      },
      {
        id: 'secret_sk_token',
        category: 'secret',
        action: 'block',
        regex: 'sk-[A-Za-z0-9]{20,}',
        flags: 'g'
      },
      {
        id: 'license_sensitive_notice',
        category: 'license_sensitive',
        action: 'block',
        regex: '\\b(?:all rights reserved|proprietary|confidential)\\b',
        flags: 'gi'
      }
    ]
  };
}

function normalizeRule(row: AnyObj, index: number) {
  const src = row && typeof row === 'object' ? row : {};
  const id = normalizeToken(src.id || `rule_${index + 1}`, 120) || `rule_${index + 1}`;
  const category = normalizeToken(src.category || 'general', 80) || 'general';
  const actionRaw = normalizeToken(src.action || 'redact', 20) || 'redact';
  const action = actionRaw === 'block' ? 'block' : 'redact';
  const regex = cleanText(src.regex || '', 600);
  const flags = cleanText(src.flags || 'gi', 10) || 'gi';
  return {
    id,
    category,
    action,
    regex,
    flags
  };
}

function normalizePolicy(raw: AnyObj) {
  const base = defaultPolicy();
  const src = raw && typeof raw === 'object' ? raw : {};
  const textFields = Array.from(
    new Set(
      (Array.isArray(src.text_fields_allowlist) ? src.text_fields_allowlist : base.text_fields_allowlist)
        .map((v) => normalizeToken(v, 80))
        .filter(Boolean)
    )
  );
  const rulesRaw = Array.isArray(src.rules) ? src.rules : base.rules;
  const rules = rulesRaw
    .map((row, index) => normalizeRule(row, index))
    .filter((row) => row.regex.length > 0);
  return {
    version: cleanText(src.version || base.version, 40) || base.version,
    enabled: src.enabled !== false,
    max_text_bytes: clampInt(src.max_text_bytes, 512, 256 * 1024, base.max_text_bytes),
    redact_on_block: src.redact_on_block !== false,
    text_fields_allowlist: textFields,
    rules
  };
}

function loadRedactionClassificationPolicy(policyPath = DEFAULT_POLICY_PATH) {
  return normalizePolicy(readJsonSafe(policyPath, defaultPolicy()));
}

function compileRuleRegex(rule: AnyObj) {
  try {
    return new RegExp(String(rule.regex || ''), String(rule.flags || 'gi'));
  } catch {
    return null;
  }
}

function collectTextFields(node: unknown, allow: Set<string>, out: string[], budget: AnyObj, depth = 0) {
  if (budget.fields <= 0 || budget.bytes <= 0) return;
  if (node == null) return;
  if (typeof node === 'string') {
    const text = cleanText(node, Math.min(1200, budget.bytes));
    if (!text) return;
    out.push(text);
    budget.fields -= 1;
    budget.bytes -= Buffer.byteLength(text, 'utf8');
    return;
  }
  if (depth > 4) return;
  if (Array.isArray(node)) {
    for (const row of node.slice(0, 24)) {
      if (budget.fields <= 0 || budget.bytes <= 0) break;
      collectTextFields(row, allow, out, budget, depth + 1);
    }
    return;
  }
  if (typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as AnyObj)) {
    if (budget.fields <= 0 || budget.bytes <= 0) break;
    const token = normalizeToken(key, 80);
    if (typeof value === 'string') {
      if (!allow.has(token)) continue;
      collectTextFields(value, allow, out, budget, depth + 1);
      continue;
    }
    if (Array.isArray(value) || (value && typeof value === 'object')) {
      collectTextFields(value, allow, out, budget, depth + 1);
    }
  }
}

function extractTextFromDatum(datum: unknown, policyInput: AnyObj = null) {
  const policy = normalizePolicy(policyInput || loadRedactionClassificationPolicy());
  if (typeof datum === 'string') {
    const trimmed = cleanText(datum, policy.max_text_bytes);
    return {
      text: trimmed,
      field_count: trimmed ? 1 : 0
    };
  }
  const allow = new Set(policy.text_fields_allowlist || []);
  const out: string[] = [];
  const budget = {
    fields: 80,
    bytes: policy.max_text_bytes
  };
  collectTextFields(datum, allow, out, budget);
  const text = out.join('\n').slice(0, policy.max_text_bytes);
  return {
    text,
    field_count: out.length
  };
}

function classifyAndRedactText(inputText: unknown, policyInput: AnyObj = null) {
  const policy = normalizePolicy(policyInput || loadRedactionClassificationPolicy());
  const original = cleanText(inputText, policy.max_text_bytes);
  if (policy.enabled !== true) {
    return {
      enabled: false,
      blocked: false,
      redacted: false,
      categories: [],
      findings: [],
      sanitized_text: original,
      evidence: {
        input_sha256: sha256Hex(original),
        output_sha256: sha256Hex(original),
        input_bytes: Buffer.byteLength(original, 'utf8'),
        output_bytes: Buffer.byteLength(original, 'utf8')
      }
    };
  }
  let working = original;
  const findings: AnyObj[] = [];
  for (const rule of policy.rules || []) {
    const re = compileRuleRegex(rule);
    if (!re) continue;
    let matchCount = 0;
    const replacement = `[REDACTED:${normalizeToken(rule.category || 'general', 40) || 'general'}]`;
    if (String(rule.action || 'redact') === 'redact') {
      working = working.replace(re, () => {
        matchCount += 1;
        return replacement;
      });
    } else {
      const matches = working.match(re);
      matchCount = Array.isArray(matches) ? matches.length : 0;
      if (matchCount > 0 && policy.redact_on_block === true) {
        working = working.replace(re, replacement);
      }
    }
    if (matchCount > 0) {
      findings.push({
        id: rule.id,
        category: rule.category,
        action: rule.action,
        match_count: matchCount
      });
    }
  }
  const blocked = findings.some((row) => row.action === 'block');
  const redacted = findings.some((row) => row.action === 'redact') || (blocked && policy.redact_on_block === true);
  const categories = Array.from(new Set(findings.map((row) => normalizeToken(row.category || 'general', 80)).filter(Boolean)));
  return {
    enabled: true,
    blocked,
    redacted,
    categories,
    findings,
    sanitized_text: working,
    evidence: {
      input_sha256: sha256Hex(original),
      output_sha256: sha256Hex(working),
      input_bytes: Buffer.byteLength(original, 'utf8'),
      output_bytes: Buffer.byteLength(working, 'utf8')
    }
  };
}

function classifyTrainingDatum(datum: unknown, policyInput: AnyObj = null) {
  const policy = normalizePolicy(policyInput || loadRedactionClassificationPolicy());
  const extracted = extractTextFromDatum(datum, policy);
  const classified = classifyAndRedactText(extracted.text, policy);
  return {
    ...classified,
    extracted_field_count: Number(extracted.field_count || 0),
    extracted_text_bytes: Buffer.byteLength(String(extracted.text || ''), 'utf8')
  };
}

module.exports = {
  DEFAULT_POLICY_PATH,
  defaultPolicy,
  normalizePolicy,
  loadRedactionClassificationPolicy,
  extractTextFromDatum,
  classifyAndRedactText,
  classifyTrainingDatum
};

export {};
