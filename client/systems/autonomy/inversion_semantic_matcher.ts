#!/usr/bin/env node
'use strict';
export {};

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 800) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function tokenizeWords(v: unknown) {
  return Array.from(new Set(
    cleanText(v, 2400)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .split(' ')
      .map((row) => row.trim())
      .filter((row) => row.length >= 3)
  ));
}

function escapeRegex(v: unknown) {
  return String(v == null ? '' : v).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function termRegex(term: string) {
  const words = cleanText(term, 120)
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .map((row) => escapeRegex(row));
  if (!words.length) return null;
  return new RegExp(`\\b${words.join('\\s+')}\\b`, 'i');
}

function hasTerm(text: string, tokenSet: Set<string>, term: string) {
  const re = termRegex(term);
  if (re && re.test(text)) return true;
  const parts = normalizeToken(term, 120).split('_').filter(Boolean);
  if (!parts.length) return false;
  if (parts.length === 1) return tokenSet.has(parts[0]);
  return parts.every((part) => tokenSet.has(part));
}

function normalizeRoleMap(raw: unknown, base: AnyObj = {}) {
  const src = raw && typeof raw === 'object' ? raw as AnyObj : {};
  const out: AnyObj = {};
  const rows = {
    ...base,
    ...src
  };
  for (const [key, value] of Object.entries(rows)) {
    const id = normalizeToken(key, 64);
    if (!id) continue;
    const list = Array.isArray(value)
      ? value
      : [value];
    out[id] = Array.from(new Set(list
      .map((row) => cleanText(row, 120).toLowerCase())
      .filter(Boolean)
      .slice(0, 48)));
  }
  return out;
}

function normalizeSemanticCfg(raw: unknown) {
  const src = raw && typeof raw === 'object' ? raw as AnyObj : {};
  return {
    enabled: src.enabled === true,
    min_role_hits: Math.max(1, Math.min(3, Number(src.min_role_hits || 2) || 2)),
    ontology: {
      actions: normalizeRoleMap(src.ontology && src.ontology.actions),
      subjects: normalizeRoleMap(src.ontology && src.ontology.subjects),
      objects: normalizeRoleMap(src.ontology && src.ontology.objects)
    }
  };
}

function normalizeRoleList(raw: unknown) {
  if (!Array.isArray(raw)) return [];
  return Array.from(new Set(raw
    .map((row) => normalizeToken(row, 64))
    .filter(Boolean)
    .slice(0, 24)));
}

function deriveSemanticRolesFromAxiom(axiom: AnyObj) {
  const req = axiom && axiom.semantic_requirements && typeof axiom.semantic_requirements === 'object'
    ? axiom.semantic_requirements
    : {};
  const directActions = normalizeRoleList(req.actions);
  const directSubjects = normalizeRoleList(req.subjects);
  const directObjects = normalizeRoleList(req.objects);
  if (directActions.length || directSubjects.length || directObjects.length) {
    return {
      actions: directActions,
      subjects: directSubjects,
      objects: directObjects
    };
  }
  const signals = axiom && axiom.signals && typeof axiom.signals === 'object' ? axiom.signals : {};
  return {
    actions: normalizeRoleList(signals.action_terms),
    subjects: normalizeRoleList(signals.subject_terms),
    objects: normalizeRoleList(signals.object_terms)
  };
}

function roleHit(roleIds: string[], ontology: AnyObj, haystack: string, tokenSet: Set<string>) {
  if (!roleIds.length) return false;
  for (const roleId of roleIds) {
    const terms = Array.isArray(ontology[roleId]) ? ontology[roleId] : [roleId.replace(/_/g, ' ')];
    const ok = terms.some((term: string) => hasTerm(haystack, tokenSet, term));
    if (ok) return true;
  }
  return false;
}

function evaluateAxiomSemanticMatch(opts: AnyObj = {}) {
  const semantic = normalizeSemanticCfg(opts.semantic || {});
  if (semantic.enabled !== true) {
    return {
      matched: false,
      enabled: false,
      role_hits: { actions: false, subjects: false, objects: false },
      matched_roles: 0,
      required_roles: semantic.min_role_hits,
      confidence: 0
    };
  }

  const axiom = opts.axiom && typeof opts.axiom === 'object' ? opts.axiom : {};
  const roles = deriveSemanticRolesFromAxiom(axiom);
  const haystack = [
    cleanText(opts.objective || '', 700),
    cleanText(opts.signature || '', 700),
    ...(Array.isArray(opts.filters) ? opts.filters.map((row) => cleanText(row, 160)) : []),
    ...(Array.isArray(opts.intent_tags) ? opts.intent_tags.map((row) => cleanText(row, 80).replace(/_/g, ' ')) : [])
  ].join(' ').toLowerCase();
  const tokenSet = new Set(tokenizeWords(haystack));

  const actionHit = roleHit(roles.actions, semantic.ontology.actions, haystack, tokenSet);
  const subjectHit = roleHit(roles.subjects, semantic.ontology.subjects, haystack, tokenSet);
  const objectHit = roleHit(roles.objects, semantic.ontology.objects, haystack, tokenSet);

  const configuredRoles = [
    roles.actions.length > 0,
    roles.subjects.length > 0,
    roles.objects.length > 0
  ].filter(Boolean).length;
  const matchedRoles = [actionHit, subjectHit, objectHit].filter(Boolean).length;
  const requiredRoles = Math.max(1, Math.min(configuredRoles || 1, semantic.min_role_hits));
  const matched = matchedRoles >= requiredRoles;
  const confidence = configuredRoles > 0
    ? Number((matchedRoles / configuredRoles).toFixed(6))
    : 0;

  return {
    matched,
    enabled: true,
    role_hits: {
      actions: actionHit,
      subjects: subjectHit,
      objects: objectHit
    },
    matched_roles: matchedRoles,
    required_roles: requiredRoles,
    confidence,
    semantic_roles: roles
  };
}

module.exports = {
  evaluateAxiomSemanticMatch
};
