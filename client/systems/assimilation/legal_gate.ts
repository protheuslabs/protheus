#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 220) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeList(src: unknown, maxItems = 64, maxLen = 80) {
  if (!Array.isArray(src)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of src) {
    const token = normalizeToken(raw, maxLen);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
    if (out.length >= maxItems) break;
  }
  return out;
}

function defaultLegalPolicy() {
  return {
    fail_closed: true,
    require_license_check: true,
    require_tos_check: true,
    require_robots_check: true,
    require_data_rights: true,
    denied_licenses: ['agpl-3.0', 'gpl-3.0'],
    allowed_licenses: [],
    blocked_domains: []
  };
}

function mergeLegalPolicy(policy: AnyObj = {}) {
  const src = policy && policy.legal_gate && typeof policy.legal_gate === 'object'
    ? policy.legal_gate
    : policy;
  const base = defaultLegalPolicy();
  return {
    fail_closed: src.fail_closed !== false,
    require_license_check: src.require_license_check !== false,
    require_tos_check: src.require_tos_check !== false,
    require_robots_check: src.require_robots_check !== false,
    require_data_rights: src.require_data_rights !== false,
    denied_licenses: normalizeList(src.denied_licenses, 64, 80).length
      ? normalizeList(src.denied_licenses, 64, 80)
      : base.denied_licenses.slice(0),
    allowed_licenses: normalizeList(src.allowed_licenses, 64, 80),
    blocked_domains: normalizeList(src.blocked_domains, 256, 120)
  };
}

function evaluateLegalGate(input: AnyObj = {}, policy: AnyObj = {}) {
  const cfg = mergeLegalPolicy(policy);
  const legal = input.legal && typeof input.legal === 'object' ? input.legal : {};
  const sourceUrl = cleanText(input.source_url || legal.source_url || '', 300);
  const domain = normalizeToken(
    sourceUrl.replace(/^https?:\/\//i, '').split('/')[0] || '',
    120
  ) || null;
  const license = normalizeToken(legal.license || input.license || '', 80) || null;
  const tosOk = legal.tos_ok != null ? !!legal.tos_ok : (input.tos_ok != null ? !!input.tos_ok : null);
  const robotsOk = legal.robots_ok != null ? !!legal.robots_ok : (input.robots_ok != null ? !!input.robots_ok : null);
  const rightsOk = legal.data_rights_ok != null
    ? !!legal.data_rights_ok
    : (input.data_rights_ok != null ? !!input.data_rights_ok : null);

  const deniedLicenses = new Set(cfg.denied_licenses);
  const allowedLicenses = new Set(cfg.allowed_licenses);
  const blockedDomains = new Set(cfg.blocked_domains);

  const reasonCodes: string[] = [];
  const checks: AnyObj = {};
  let blocked = false;

  if (domain && blockedDomains.has(domain)) {
    blocked = true;
    reasonCodes.push('legal_gate_blocked_domain');
  }
  checks.domain = domain;
  checks.blocked_domain = !!(domain && blockedDomains.has(domain));

  if (cfg.require_license_check === true) {
    checks.license_present = !!license;
    if (!license && cfg.fail_closed === true) {
      blocked = true;
      reasonCodes.push('legal_gate_license_missing_fail_closed');
    }
    if (license && deniedLicenses.has(license)) {
      blocked = true;
      reasonCodes.push('legal_gate_license_denied');
    }
    if (license && allowedLicenses.size > 0 && !allowedLicenses.has(license)) {
      blocked = true;
      reasonCodes.push('legal_gate_license_not_allowlisted');
    }
  }

  if (cfg.require_tos_check === true) {
    checks.tos_checked = tosOk !== null;
    checks.tos_ok = tosOk === true;
    if (tosOk === false) {
      blocked = true;
      reasonCodes.push('legal_gate_tos_denied');
    } else if (tosOk === null && cfg.fail_closed === true) {
      blocked = true;
      reasonCodes.push('legal_gate_tos_unknown_fail_closed');
    }
  }

  if (cfg.require_robots_check === true) {
    checks.robots_checked = robotsOk !== null;
    checks.robots_ok = robotsOk === true;
    if (robotsOk === false) {
      blocked = true;
      reasonCodes.push('legal_gate_robots_denied');
    } else if (robotsOk === null && cfg.fail_closed === true) {
      blocked = true;
      reasonCodes.push('legal_gate_robots_unknown_fail_closed');
    }
  }

  if (cfg.require_data_rights === true) {
    checks.data_rights_checked = rightsOk !== null;
    checks.data_rights_ok = rightsOk === true;
    if (rightsOk === false) {
      blocked = true;
      reasonCodes.push('legal_gate_data_rights_denied');
    } else if (rightsOk === null && cfg.fail_closed === true) {
      blocked = true;
      reasonCodes.push('legal_gate_data_rights_unknown_fail_closed');
    }
  }

  const decision = blocked ? 'deny' : 'allow';
  const risk = blocked
    ? 'high'
    : (
      reasonCodes.length > 0
        ? 'medium'
        : 'low'
    );

  return {
    decision,
    allowed: decision === 'allow',
    blocked,
    risk,
    reason_codes: reasonCodes,
    checks,
    legal: {
      source_url: sourceUrl || null,
      domain,
      license,
      tos_ok: tosOk,
      robots_ok: robotsOk,
      data_rights_ok: rightsOk
    }
  };
}

module.exports = {
  evaluateLegalGate
};
