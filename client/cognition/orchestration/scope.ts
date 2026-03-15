#!/usr/bin/env node
'use strict';

const { parseArgs, parseJson, invokeOrchestration } = require('./core_bridge.ts');

const SCOPE_ID_FALLBACK_PREFIX = 'scope';
const SCOPE_ID_PATTERN = /^[a-z0-9][a-z0-9._:-]{1,95}$/;

function normalizeScope(scope, index = 0) {
  const out = invokeOrchestration('scope.detect_overlaps', {
    scopes: [scope && typeof scope === 'object' ? scope : {}],
  });

  if (!out || !out.ok) {
    return {
      ok: false,
      reason_code: String(out && out.reason_code ? out.reason_code : 'scope_invalid'),
      scope_id: String(
        (scope && (scope.scope_id || scope.scopeId)) || `${SCOPE_ID_FALLBACK_PREFIX}-${index + 1}`
      ).toLowerCase(),
    };
  }

  const normalized = Array.isArray(out.normalized_scopes) ? out.normalized_scopes[0] : null;
  if (!normalized || typeof normalized !== 'object') {
    return {
      ok: false,
      reason_code: 'scope_invalid',
      scope_id: String(
        (scope && (scope.scope_id || scope.scopeId)) || `${SCOPE_ID_FALLBACK_PREFIX}-${index + 1}`
      ).toLowerCase(),
    };
  }

  return {
    ok: true,
    scope: normalized,
  };
}

function detectScopeOverlaps(scopes = []) {
  const out = invokeOrchestration('scope.detect_overlaps', {
    scopes: Array.isArray(scopes) ? scopes : [],
  });
  if (out && typeof out.ok === 'boolean') {
    return {
      ok: out.ok,
      reason_code: String(out.reason_code || (out.ok ? 'scope_non_overlap_ok' : 'scope_overlap_detected')),
      normalized_scopes: Array.isArray(out.normalized_scopes) ? out.normalized_scopes : [],
      overlaps: Array.isArray(out.overlaps) ? out.overlaps : [],
      scope_id: out.scope_id || null,
    };
  }
  return {
    ok: false,
    reason_code: 'orchestration_bridge_error',
    normalized_scopes: [],
    overlaps: [],
  };
}

function findingInScope(finding, scope) {
  const classified = classifyFindingsByScope([finding], scope, '');
  if (!classified.ok) {
    return {
      ok: false,
      reason_code: classified.reason_code || 'scope_classification_failed',
      in_scope: false,
      scope_id: scope && scope.scope_id ? scope.scope_id : null,
    };
  }

  if (classified.in_scope.length > 0) {
    return {
      ok: true,
      reason_code: 'finding_in_scope',
      in_scope: true,
      scope_id: scope && scope.scope_id ? scope.scope_id : null,
      matches_series: true,
      matches_paths: true,
    };
  }

  const violation = classified.violations[0] || {};
  return {
    ok: true,
    reason_code: 'finding_out_of_scope',
    in_scope: false,
    scope_id: violation.scope_id || (scope && scope.scope_id ? scope.scope_id : null),
    matches_series: Boolean(violation.matches_series),
    matches_paths: Boolean(violation.matches_paths),
  };
}

function classifyFindingsByScope(findings = [], scope, agentId = '') {
  const out = invokeOrchestration('scope.classify_findings', {
    findings: Array.isArray(findings) ? findings : [],
    scope: scope && typeof scope === 'object' ? scope : {},
    agent_id: String(agentId || '').trim(),
  });

  if (out && typeof out.ok === 'boolean') {
    return {
      ok: out.ok,
      type: String(out.type || 'orchestration_scope_classification'),
      in_scope: Array.isArray(out.in_scope) ? out.in_scope : [],
      out_of_scope: Array.isArray(out.out_of_scope) ? out.out_of_scope : [],
      violations: Array.isArray(out.violations) ? out.violations : [],
      reason_code: out.reason_code ? String(out.reason_code) : undefined,
    };
  }

  return {
    ok: false,
    type: 'orchestration_scope_classification',
    reason_code: 'orchestration_bridge_error',
    in_scope: [],
    out_of_scope: [],
    violations: [],
  };
}

function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  const command = String(parsed.positional[0] || 'validate').trim().toLowerCase();

  if (command === 'validate' || command === 'overlap') {
    const scopePayload = parseJson(
      parsed.flags['scopes-json'] || parsed.flags.scopes_json,
      [],
      'invalid_scopes_json'
    );
    if (!scopePayload.ok) {
      return {
        ok: false,
        type: 'orchestration_scope_validate',
        reason_code: scopePayload.reason_code,
      };
    }

    const result = detectScopeOverlaps(scopePayload.value);
    return Object.assign({ type: 'orchestration_scope_validate' }, result);
  }

  if (command === 'classify') {
    const scopePayload = parseJson(
      parsed.flags['scope-json'] || parsed.flags.scope_json,
      {},
      'invalid_scope_json'
    );
    if (!scopePayload.ok) {
      return {
        ok: false,
        type: 'orchestration_scope_classification',
        reason_code: scopePayload.reason_code,
      };
    }

    const findingsPayload = parseJson(
      parsed.flags['findings-json'] || parsed.flags.findings_json,
      [],
      'invalid_findings_json'
    );
    if (!findingsPayload.ok) {
      return {
        ok: false,
        type: 'orchestration_scope_classification',
        reason_code: findingsPayload.reason_code,
      };
    }

    return classifyFindingsByScope(
      findingsPayload.value,
      scopePayload.value,
      parsed.flags['agent-id'] || parsed.flags.agent_id || ''
    );
  }

  return {
    ok: false,
    type: 'orchestration_scope_command',
    reason_code: `unsupported_command:${command}`,
    commands: ['validate', 'overlap', 'classify'],
  };
}

if (require.main === module) {
  const out = run(process.argv.slice(2));
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
  process.exit(out.ok ? 0 : 1);
}

module.exports = {
  SCOPE_ID_PATTERN,
  parseArgs,
  normalizeScope,
  detectScopeOverlaps,
  findingInScope,
  classifyFindingsByScope,
  run,
};
