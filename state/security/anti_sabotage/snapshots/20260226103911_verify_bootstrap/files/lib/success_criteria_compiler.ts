type CriteriaInputRow = {
  metric?: string;
  name?: string;
  target?: string;
  threshold?: string;
  description?: string;
  goal?: string;
  horizon?: string;
  window?: string;
  by?: string;
};

type CompilerOptions = {
  source?: string;
};

type ProposalCompilerOptions = {
  include_verify?: boolean;
  include_validation?: boolean;
  allow_fallback?: boolean;
  capability_key?: string;
};

type ProposalInput = {
  success_criteria?: unknown;
  action_spec?: {
    success_criteria?: unknown;
    verify?: unknown;
  };
  validation?: unknown;
};

type CompiledSuccessCriteria = {
  source: string;
  metric: string;
  target: string;
  horizon: string;
  measurable: boolean;
};

const OUTREACH_CAPABILITY_HINT_RE = /\b(opportunity|outreach|lead|sales|bizdev|revenue|freelance|contract|gig|external_intel|client|prospect)\b/;

function normalizeText(v: unknown): string {
  return String(v == null ? '' : v).trim();
}

function normalizeSpaces(v: unknown): string {
  return normalizeText(v).replace(/\s+/g, ' ');
}

function normalizeCapabilityKey(v: unknown): string {
  return normalizeSpaces(v).toLowerCase();
}

function capabilityAllowsOutreach(capabilityKey: string): boolean {
  if (!capabilityKey) return true;
  if (capabilityKey.startsWith('proposal:')) {
    return OUTREACH_CAPABILITY_HINT_RE.test(capabilityKey);
  }
  return true;
}

function remapMetricForCapability(metric: string, capabilityKey: string): string {
  const normMetric = normalizeSpaces(metric).toLowerCase();
  if (!capabilityAllowsOutreach(capabilityKey)) {
    if (normMetric === 'reply_or_interview_count' || normMetric === 'outreach_artifact') {
      return 'artifact_count';
    }
  }
  return normMetric || 'execution_success';
}

function parseFirstInt(text: unknown, fallback: number): number {
  const m = String(text || '').match(/\b(\d+)\b/);
  if (!m) return fallback;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : fallback;
}

function parseComparator(text: unknown, fallback: 'gte' | 'lte'): 'gte' | 'lte' {
  const t = String(text || '').toLowerCase();
  if (/(?:<=|≤|\bat most\b|\bwithin\b|\bunder\b|\bbelow\b|\bmax(?:imum)?\b|\bless than\b)/.test(t)) return 'lte';
  if (/(?:>=|≥|\bat least\b|\bover\b|\babove\b|\bminimum\b|\bmin\b|\bmore than\b)/.test(t)) return 'gte';
  return fallback;
}

function parseDurationLimitMs(text: unknown): number | null {
  const t = String(text || '').toLowerCase();
  const m = t.match(/(\d+(?:\.\d+)?)\s*(ms|msec|millisecond(?:s)?|s|sec|secs|second(?:s)?|m|min|mins|minute(?:s)?)/);
  if (!m) return null;
  let value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const unit = String(m[2] || '');
  if (unit === 'm' || unit === 'min' || unit === 'mins' || unit.startsWith('minute')) value *= 60 * 1000;
  else if (unit === 's' || unit === 'sec' || unit === 'secs' || unit.startsWith('second')) value *= 1000;
  return Math.round(value);
}

function parseTokenLimit(text: unknown): number | null {
  const t = String(text || '').toLowerCase();
  const mA = t.match(/(\d+(?:\.\d+)?)\s*(k|m)?\s*tokens?/);
  const mB = t.match(/tokens?\s*(?:<=|≥|>=|≤|<|>|=|at most|at least|under|over|below|above|within|max(?:imum)?|min(?:imum)?)?\s*(\d+(?:\.\d+)?)(?:\s*(k|m))?/);
  const m = mA || mB;
  if (!m) return null;
  let value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  const suffix = String(m[2] || '').toLowerCase();
  if (suffix === 'k') value *= 1000;
  else if (suffix === 'm') value *= 1000000;
  return Math.round(value);
}

function parseHorizon(text: unknown): string {
  const t = String(text || '').toLowerCase();
  const m = t.match(/\b(\d+\s*(?:h|hr|hour|hours|d|day|days|w|week|weeks|min|mins|minute|minutes|run|runs))\b/);
  if (m) return normalizeSpaces(m[1]);
  if (/\bnext\s+run\b/.test(t)) return 'next run';
  if (/\bnext\s+2\s+runs?\b/.test(t)) return '2 runs';
  if (/\b24h\b/.test(t)) return '24h';
  if (/\b48h\b/.test(t)) return '48h';
  if (/\b7d\b/.test(t)) return '7d';
  return '';
}

function normalizeTarget(metric: string, targetText: unknown, horizonText: unknown): string {
  const text = normalizeSpaces(`${targetText} ${horizonText}`.toLowerCase());
  if (metric === 'execution_success') return 'execution success';
  if (metric === 'postconditions_ok') return 'postconditions pass';
  if (metric === 'queue_outcome_logged') return 'outcome receipt logged';
  if (metric === 'artifact_count') {
    const comparator = parseComparator(text, 'gte');
    const threshold = parseFirstInt(text, 1);
    return `${comparator === 'lte' ? '<=' : '>='}${threshold} artifact`;
  }
  if (metric === 'outreach_artifact') {
    const comparator = parseComparator(text, 'gte');
    const threshold = parseFirstInt(text, 1);
    return `${comparator === 'lte' ? '<=' : '>='}${threshold} outreach artifact`;
  }
  if (metric === 'reply_or_interview_count') {
    const comparator = parseComparator(text, 'gte');
    const threshold = parseFirstInt(text, 1);
    return `${comparator === 'lte' ? '<=' : '>='}${threshold} reply/interview signal`;
  }
  if (metric === 'entries_count') {
    const comparator = parseComparator(text, 'gte');
    const threshold = parseFirstInt(text, 1);
    return `${comparator === 'lte' ? '<=' : '>='}${threshold} entries`;
  }
  if (metric === 'revenue_actions_count') {
    const comparator = parseComparator(text, 'gte');
    const threshold = parseFirstInt(text, 1);
    return `${comparator === 'lte' ? '<=' : '>='}${threshold} revenue actions`;
  }
  if (metric === 'token_usage') {
    const comparator = parseComparator(text, 'lte');
    const limit = parseTokenLimit(text) != null ? parseTokenLimit(text) : 1200;
    return `tokens ${comparator === 'gte' ? '>=' : '<='}${limit}`;
  }
  if (metric === 'duration_ms') {
    const comparator = parseComparator(text, 'lte');
    const limitMs = parseDurationLimitMs(text) != null ? parseDurationLimitMs(text) : 15000;
    return `duration ${comparator === 'gte' ? '>=' : '<='}${limitMs}ms`;
  }
  return normalizeSpaces(targetText || 'execution success') || 'execution success';
}

function classifyMetric(metricText: unknown, targetText: unknown, sourceText: unknown): string {
  const metric = normalizeSpaces(metricText).toLowerCase();
  const text = normalizeSpaces(`${metricText} ${targetText} ${sourceText}`).toLowerCase();

  if (!metric && /\b(reply|interview)\b/.test(text)) return 'reply_or_interview_count';
  if (!metric && /\boutreach\b/.test(text) && /\b(artifact|draft|offer|proposal)\b/.test(text)) return 'outreach_artifact';

  if (metric === 'validation_metric' || metric === 'validation_check' || metric === 'verification_metric' || metric === 'verification_check') return 'postconditions_ok';
  if (metric === 'outreach_artifact') return 'outreach_artifact';
  if (metric === 'reply_or_interview_count' || metric === 'reply_count' || metric === 'interview_count' || metric === 'outreach_reply_count' || metric === 'outreach_interview_count') return 'reply_or_interview_count';
  if (metric === 'artifact_count' || metric === 'experiment_artifact' || metric === 'collector_success_runs' || metric === 'hypothesis_signal_lift' || metric === 'outreach_artifact_count' || metric === 'offer_draft_count' || metric === 'proposal_draft_count') return 'artifact_count';
  if (metric === 'verification_checks_passed' || metric === 'postconditions_ok') return 'postconditions_ok';
  if (metric === 'collector_failure_streak' || metric === 'queue_outcome_logged') return 'queue_outcome_logged';
  if (metric === 'entries_count') return 'entries_count';
  if (metric === 'revenue_actions_count') return 'revenue_actions_count';
  if (metric === 'token_usage') return 'token_usage';
  if (metric === 'duration_ms') return 'duration_ms';
  if (metric === 'execution_success') return 'execution_success';

  if (/\b(reply|interview)\b/.test(text)) return 'reply_or_interview_count';
  if (/\boutreach\b/.test(text) && /\b(artifact|draft|offer|proposal)\b/.test(text)) return 'outreach_artifact';
  if (/\b(artifact|draft|experiment|patch|plan|deliverable)\b/.test(text)) return 'artifact_count';
  if (/\b(postcondition|contract|verify|verification|check(?:s)? pass)\b/.test(text)) return 'postconditions_ok';
  if (/\b(receipt|evidence|queue[\s_-]?outcome|logged?)\b/.test(text)) return 'queue_outcome_logged';
  if (/\brevenue\b/.test(text)) return 'revenue_actions_count';
  if (/\b(entries|entry|notes?)\b/.test(text)) return 'entries_count';
  if (/\btoken(?:s)?\b/.test(text)) return 'token_usage';
  if (/\b(latency|duration|time|ms|msec|millisecond|second|sec|min|minute)\b/.test(text)) return 'duration_ms';
  if (/\b(execut(e|ed|ion)|run|runnable|success)\b/.test(text)) return 'execution_success';
  return 'execution_success';
}

function normalizeInputRows(rows: unknown, source: unknown): Array<{ source: string; metric: string; target: string; horizon: string }> {
  const out: Array<{ source: string; metric: string; target: string; horizon: string }> = [];
  const src = normalizeText(source) || 'success_criteria';
  for (const row of Array.isArray(rows) ? rows : []) {
    if (typeof row === 'string') {
      const target = normalizeSpaces(row);
      if (!target) continue;
      out.push({ source: src, metric: '', target, horizon: '' });
      continue;
    }
    if (!row || typeof row !== 'object') continue;
    const obj = row as CriteriaInputRow;
    const metric = normalizeSpaces(obj.metric || obj.name || '');
    const target = normalizeSpaces(obj.target || obj.threshold || obj.description || obj.goal || '');
    const horizon = normalizeSpaces(obj.horizon || obj.window || obj.by || '');
    if (!metric && !target && !horizon) continue;
    out.push({ source: src, metric, target, horizon });
  }
  return out;
}

function compileSuccessCriteriaRows(rows: unknown, opts: CompilerOptions = {}): CompiledSuccessCriteria[] {
  const rawRows = normalizeInputRows(rows, opts.source || 'success_criteria');
  const out: CompiledSuccessCriteria[] = [];
  const seen = new Set<string>();
  for (const row of rawRows) {
    const metric = classifyMetric(row.metric, row.target, row.source);
    const horizon = row.horizon || parseHorizon(row.target);
    const target = normalizeTarget(metric, row.target, horizon);
    const key = `${metric}|${target}|${horizon}|${row.source}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source: row.source,
      metric,
      target,
      horizon,
      measurable: true
    });
  }
  return out;
}

function compileProposalSuccessCriteria(proposal: ProposalInput, opts: ProposalCompilerOptions = {}): CompiledSuccessCriteria[] {
  const p = proposal && typeof proposal === 'object' ? proposal : {};
  const actionSpec = p.action_spec && typeof p.action_spec === 'object' ? p.action_spec : {};
  const includeVerify = opts.include_verify !== false;
  const includeValidation = opts.include_validation !== false;
  const capabilityKey = normalizeCapabilityKey(opts.capability_key);

  const compiled: CompiledSuccessCriteria[] = [];
  compiled.push(...compileSuccessCriteriaRows(p.success_criteria, { source: 'success_criteria' }));
  compiled.push(...compileSuccessCriteriaRows(actionSpec.success_criteria, { source: 'action_spec.success_criteria' }));
  if (includeVerify) compiled.push(...compileSuccessCriteriaRows(actionSpec.verify, { source: 'action_spec.verify' }));
  if (includeValidation) compiled.push(...compileSuccessCriteriaRows(p.validation, { source: 'validation' }));

  if (!compiled.length && opts.allow_fallback !== false) {
    compiled.push({
      source: 'compiler_fallback',
      metric: 'execution_success',
      target: 'execution success',
      horizon: '',
      measurable: true
    });
  }
  const out: CompiledSuccessCriteria[] = [];
  const seen = new Set<string>();
  for (const row of compiled) {
    const metric = remapMetricForCapability(String(row && row.metric || ''), capabilityKey);
    const horizon = normalizeSpaces(row && row.horizon || '');
    const target = normalizeTarget(metric, row && row.target || '', horizon);
    const source = normalizeSpaces(row && row.source || '') || 'success_criteria';
    const key = `${source}|${metric}|${target}|${horizon}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      source,
      metric,
      target,
      horizon,
      measurable: true
    });
  }
  return out;
}

function toActionSpecRows(compiledRows: CompiledSuccessCriteria[]): Array<{ metric: string; target: string; horizon: string }> {
  const rows = Array.isArray(compiledRows) ? compiledRows : [];
  return rows.map((row) => ({
    metric: String(row.metric || 'execution_success'),
    target: String(row.target || 'execution success'),
    horizon: normalizeSpaces(row.horizon || '')
  }));
}

export {
  compileSuccessCriteriaRows,
  compileProposalSuccessCriteria,
  toActionSpecRows
};
