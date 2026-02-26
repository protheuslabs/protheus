type SuccessCriteriaRecord = {
  required: boolean;
  min_count: number;
  total_count: number;
  evaluated_count: number;
  passed_count: number;
  failed_count: number;
  unknown_count: number;
  pass_rate: number | null;
  passed: boolean;
  primary_failure: string | null;
  checks: unknown[];
  synthesized: boolean;
};

function shortText(v: unknown, maxLen = 200): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeReasonToken(v: unknown): string {
  const raw = shortText(v, 180).toLowerCase();
  if (!raw) return '';
  const compact = raw.replace(/[^a-z0-9:_-]+/g, '_').replace(/^_+|_+$/g, '');
  if (!compact) return '';

  if (/\bgate_manual\b/.test(compact)) return 'route_gate_manual';
  if (/\bgate_deny\b/.test(compact)) return 'route_gate_deny';
  if (/\bnot_executable\b/.test(compact)) return 'route_not_executable';
  if (/\bpreflight_executable\b/.test(compact)) return 'preflight_not_executable';
  if (/\bpre_exec_criteria_gate\b/.test(compact)) return 'pre_exec_criteria_gate_failed';
  if (/\bqueue_accept_logged\b/.test(compact)) return 'queue_accept_not_logged';
  if (/\bsuccess_criteria\b/.test(compact)) return 'success_criteria_failed';
  if (/\bpostcheck_fail\b/.test(compact)) return 'postcheck_failed';
  if (/\badapter_/.test(compact) && /\bunverified\b/.test(compact)) return 'actuation_unverified';
  if (/\bactuation/.test(compact) && /\bexit_\d+\b/.test(compact)) return 'actuation_execution_failed';
  if (/\broute/.test(compact) && /\bexit_\d+\b/.test(compact)) return 'route_execution_failed';
  if (/\bexec_failed\b/.test(compact) || /\bcommand_failed\b/.test(compact)) return 'execution_failed';

  return compact.slice(0, 80);
}

function normalizeReasonList(values: unknown[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values || []) {
    const token = normalizeReasonToken(v);
    if (!token || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function clampCount(v: unknown): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  return n;
}

function toSuccessCriteriaRecord(criteria: unknown, fallback: Record<string, unknown> = {}): SuccessCriteriaRecord {
  const src = criteria && typeof criteria === 'object' ? criteria as Record<string, unknown> : {};
  const requiredFallback = fallback && fallback.required === true;
  const minCountFallback = Number.isFinite(Number(fallback && fallback.min_count))
    ? Math.max(0, Number(fallback.min_count))
    : 0;
  return {
    required: src.required === true || requiredFallback,
    min_count: Number.isFinite(Number(src.min_count)) ? Math.max(0, Number(src.min_count)) : minCountFallback,
    total_count: clampCount(src.total_count),
    evaluated_count: clampCount(src.evaluated_count),
    passed_count: clampCount(src.passed_count),
    failed_count: clampCount(src.failed_count),
    unknown_count: clampCount(src.unknown_count),
    pass_rate: Number.isFinite(Number(src.pass_rate)) ? Number(src.pass_rate) : null,
    passed: src.passed === true,
    primary_failure: src.primary_failure ? String(src.primary_failure) : null,
    checks: Array.isArray(src.checks) ? src.checks.slice(0, 12) : [],
    synthesized: src.synthesized === true
  };
}

function synthesizeSuccessCriteria({ required, minCount, checkPass }: { required?: boolean; minCount?: number; checkPass: boolean | null }): SuccessCriteriaRecord {
  const resolvedRequired = required !== false;
  const resolvedPass = checkPass === null
    ? (resolvedRequired ? false : true)
    : checkPass === true;
  const evaluated = checkPass === null ? 0 : 1;
  return {
    required: resolvedRequired,
    min_count: Number.isFinite(Number(minCount))
      ? Math.max(0, Number(minCount))
      : (resolvedRequired ? 1 : 0),
    total_count: 0,
    evaluated_count: evaluated,
    passed_count: resolvedPass ? 1 : 0,
    failed_count: resolvedPass ? 0 : 1,
    unknown_count: evaluated === 0 ? 1 : 0,
    pass_rate: evaluated > 0 ? (resolvedPass ? 1 : 0) : null,
    passed: resolvedPass,
    primary_failure: resolvedPass ? null : 'success_criteria_missing_in_receipt_pipeline',
    checks: [],
    synthesized: true
  };
}

function withSuccessCriteriaVerification(baseVerification: Record<string, unknown>, successCriteria: unknown, options: Record<string, unknown> = {}) {
  const base = baseVerification && typeof baseVerification === 'object'
    ? { ...baseVerification }
    : {};
  const criteria = toSuccessCriteriaRecord(successCriteria, (options.fallback as Record<string, unknown>) || {});
  const criteriaPass = criteria.required ? criteria.passed === true : true;
  const checks = Array.isArray(base.checks) ? base.checks.map((row) => ({ ...(row as Record<string, unknown>) })) : [];
  const existingIdx = checks.findIndex((row) => row && row.name === 'success_criteria_met');
  if (existingIdx >= 0) checks[existingIdx] = { name: 'success_criteria_met', pass: criteriaPass };
  else checks.push({ name: 'success_criteria_met', pass: criteriaPass });
  const failedSet = new Set(
    (Array.isArray(base.failed) ? base.failed : [])
      .map((name) => String(name || '').trim())
      .filter(Boolean)
  );
  if (criteriaPass) failedSet.delete('success_criteria_met');
  else failedSet.add('success_criteria_met');
  const failed = Array.from(failedSet);
  const passed = failed.length === 0;
  let outcome = String(base.outcome || '').trim();
  if (!outcome) outcome = passed ? 'shipped' : 'no_change';
  if (!criteriaPass && options.enforceNoChangeOnFailure === true && outcome === 'shipped') {
    outcome = 'no_change';
  }
  const primaryFailure = !criteriaPass
    ? (criteria.primary_failure || String(base.primary_failure || 'success_criteria_failed'))
    : (base.primary_failure || null);
  return {
    ...base,
    checks,
    failed,
    passed,
    outcome,
    primary_failure: primaryFailure,
    success_criteria: criteria
  };
}

function normalizeAutonomyReceiptForWrite(receipt: unknown) {
  const src = receipt && typeof receipt === 'object' ? { ...(receipt as Record<string, unknown>) } : {};
  const intent = src.intent && typeof src.intent === 'object' ? src.intent as Record<string, unknown> : {};
  const verificationSrc = src.verification && typeof src.verification === 'object'
    ? src.verification as Record<string, unknown>
    : {};

  const checks = Array.isArray(verificationSrc.checks)
    ? verificationSrc.checks
      .map((row) => ({
        name: shortText(String((row as Record<string, unknown>)?.name || ''), 80),
        pass: (row as Record<string, unknown>)?.pass === true
      }))
      .filter((row) => row.name)
    : [];
  const failedSet = new Set(
    (Array.isArray(verificationSrc.failed) ? verificationSrc.failed : [])
      .map((name) => shortText(String(name || ''), 80))
      .filter(Boolean)
  );

  const policy = intent.success_criteria_policy && typeof intent.success_criteria_policy === 'object'
    ? intent.success_criteria_policy as Record<string, unknown>
    : {};
  const required = policy.required !== false;
  const minCount = Number.isFinite(Number(policy.min_count))
    ? Math.max(0, Number(policy.min_count))
    : (required ? 1 : 0);
  const successIdx = checks.findIndex((row) => row && row.name === 'success_criteria_met');
  const successCheckPass = successIdx >= 0 ? checks[successIdx].pass === true : null;

  const criteriaIn = verificationSrc.success_criteria && typeof verificationSrc.success_criteria === 'object'
    ? verificationSrc.success_criteria
    : null;
  let criteria = criteriaIn
    ? toSuccessCriteriaRecord(criteriaIn, { required, min_count: minCount })
    : null;
  if (!criteria) {
    criteria = synthesizeSuccessCriteria({ required, minCount, checkPass: successCheckPass });
  }

  const criteriaPass = criteria.required ? criteria.passed === true : true;
  if (successIdx >= 0) checks[successIdx] = { name: 'success_criteria_met', pass: criteriaPass };
  else checks.push({ name: 'success_criteria_met', pass: criteriaPass });

  if (criteriaPass) failedSet.delete('success_criteria_met');
  else failedSet.add('success_criteria_met');

  const failed = Array.from(failedSet);
  const primaryFailureRaw = !criteriaPass
    ? shortText(String(criteria.primary_failure || verificationSrc.primary_failure || 'success_criteria_failed'), 180)
    : (verificationSrc.primary_failure ? shortText(String(verificationSrc.primary_failure), 180) : null);
  const reasonTaxonomy = normalizeReasonList([
    ...failed,
    primaryFailureRaw || ''
  ]);
  const normalizedVerification = {
    ...verificationSrc,
    checks,
    failed,
    passed: failed.length === 0,
    primary_failure: primaryFailureRaw,
    primary_failure_taxonomy: reasonTaxonomy.length ? reasonTaxonomy[0] : null,
    failed_reason_taxonomy: reasonTaxonomy,
    success_criteria: criteria
  };

  return {
    ...src,
    verification: normalizedVerification
  };
}

function successCriteriaFromReceipt(rec: unknown) {
  const normalized = normalizeAutonomyReceiptForWrite(rec && typeof rec === 'object' ? rec : {});
  const verification = normalized.verification && typeof normalized.verification === 'object'
    ? normalized.verification as Record<string, unknown>
    : {};
  const criteria = verification.success_criteria && typeof verification.success_criteria === 'object'
    ? verification.success_criteria
    : null;
  return criteria ? { ...(criteria as Record<string, unknown>) } : null;
}

export {
  toSuccessCriteriaRecord,
  withSuccessCriteriaVerification,
  normalizeAutonomyReceiptForWrite,
  successCriteriaFromReceipt
};
