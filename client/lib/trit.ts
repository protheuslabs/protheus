type Trit = -1 | 0 | 1;

type TritLabel = 'pain' | 'unknown' | 'ok';

type MajorityOptions = {
  weights?: unknown[];
  tie_breaker?: 'unknown' | 'pain' | 'ok' | 'first_non_zero';
};

type PropagateOptions = {
  mode?: 'strict' | 'cautious' | 'permissive';
};

const TRIT_PAIN: Trit = -1;
const TRIT_UNKNOWN: Trit = 0;
const TRIT_OK: Trit = 1;

const POSITIVE_WORDS = new Set([
  'ok',
  'pass',
  'allow',
  'approved',
  'healthy',
  'up',
  'true',
  'success',
  'green',
  'ready'
]);

const NEGATIVE_WORDS = new Set([
  'pain',
  'fail',
  'failed',
  'error',
  'blocked',
  'deny',
  'denied',
  'critical',
  'false',
  'down',
  'red'
]);

const NEUTRAL_WORDS = new Set([
  'unknown',
  'neutral',
  'pending',
  'n_a',
  'none',
  'unset'
]);

function normalizeToken(value: unknown): string {
  return String(value == null ? '' : value)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function normalizeWeight(value: unknown, fallback = 1): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

function normalizeTrit(value: unknown): Trit {
  if (value === TRIT_PAIN || value === TRIT_UNKNOWN || value === TRIT_OK) {
    return value as Trit;
  }
  const n = Number(value);
  if (Number.isFinite(n)) {
    if (n > 0) return TRIT_OK;
    if (n < 0) return TRIT_PAIN;
    return TRIT_UNKNOWN;
  }
  const token = normalizeToken(value);
  if (POSITIVE_WORDS.has(token)) return TRIT_OK;
  if (NEGATIVE_WORDS.has(token)) return TRIT_PAIN;
  if (NEUTRAL_WORDS.has(token)) return TRIT_UNKNOWN;
  return TRIT_UNKNOWN;
}

function tritLabel(value: unknown): TritLabel {
  const trit = normalizeTrit(value);
  if (trit === TRIT_PAIN) return 'pain';
  if (trit === TRIT_OK) return 'ok';
  return 'unknown';
}

function tritFromLabel(value: unknown): Trit {
  return normalizeTrit(value);
}

function invertTrit(value: unknown): Trit {
  const trit = normalizeTrit(value);
  if (trit === TRIT_PAIN) return TRIT_OK;
  if (trit === TRIT_OK) return TRIT_PAIN;
  return TRIT_UNKNOWN;
}

function majorityTrit(values: unknown[], opts: MajorityOptions = {}): Trit {
  const rows = Array.isArray(values) ? values : [];
  if (!rows.length) return TRIT_UNKNOWN;
  const weights = Array.isArray(opts.weights) ? opts.weights : [];
  let painWeight = 0;
  let unknownWeight = 0;
  let okWeight = 0;

  for (let i = 0; i < rows.length; i += 1) {
    const trit = normalizeTrit(rows[i]);
    const weight = normalizeWeight(weights[i], 1);
    if (trit === TRIT_PAIN) painWeight += weight;
    else if (trit === TRIT_OK) okWeight += weight;
    else unknownWeight += weight;
  }

  if (painWeight > okWeight && painWeight > unknownWeight) return TRIT_PAIN;
  if (okWeight > painWeight && okWeight > unknownWeight) return TRIT_OK;
  if (unknownWeight > painWeight && unknownWeight > okWeight) return TRIT_UNKNOWN;

  const tieBreaker = String(opts.tie_breaker || 'unknown');
  if (tieBreaker === 'pain') return TRIT_PAIN;
  if (tieBreaker === 'ok') return TRIT_OK;
  if (tieBreaker === 'first_non_zero') {
    const first = rows.map(normalizeTrit).find((row) => row !== TRIT_UNKNOWN);
    return first == null ? TRIT_UNKNOWN : first;
  }
  return TRIT_UNKNOWN;
}

function consensusTrit(values: unknown[]): Trit {
  const rows = Array.isArray(values) ? values.map(normalizeTrit) : [];
  if (!rows.length) return TRIT_UNKNOWN;
  const nonZero = rows.filter((row) => row !== TRIT_UNKNOWN);
  if (!nonZero.length) return TRIT_UNKNOWN;
  const hasPain = nonZero.some((row) => row === TRIT_PAIN);
  const hasOk = nonZero.some((row) => row === TRIT_OK);
  if (hasPain && hasOk) return TRIT_UNKNOWN;
  return hasPain ? TRIT_PAIN : TRIT_OK;
}

function propagateTrit(parent: unknown, child: unknown, opts: PropagateOptions = {}): Trit {
  const p = normalizeTrit(parent);
  const c = normalizeTrit(child);
  const mode = String(opts.mode || 'cautious');

  if (mode === 'strict') {
    if (p === TRIT_PAIN || c === TRIT_PAIN) return TRIT_PAIN;
    if (p === TRIT_OK && c === TRIT_OK) return TRIT_OK;
    return TRIT_UNKNOWN;
  }

  if (mode === 'permissive') {
    if (p === TRIT_OK || c === TRIT_OK) return TRIT_OK;
    if (p === TRIT_PAIN && c === TRIT_PAIN) return TRIT_PAIN;
    return TRIT_UNKNOWN;
  }

  if (c === TRIT_PAIN) return TRIT_PAIN;
  if (p === TRIT_PAIN && c === TRIT_UNKNOWN) return TRIT_PAIN;
  if (p === TRIT_OK && c === TRIT_OK) return TRIT_OK;
  if (p === TRIT_OK && c === TRIT_UNKNOWN) return TRIT_UNKNOWN;
  if (p === TRIT_UNKNOWN && c === TRIT_OK) return TRIT_OK;
  return TRIT_UNKNOWN;
}

function serializeTrit(value: unknown): '-1' | '0' | '1' {
  const trit = normalizeTrit(value);
  if (trit === TRIT_PAIN) return '-1';
  if (trit === TRIT_OK) return '1';
  return '0';
}

function parseSerializedTrit(value: unknown): Trit {
  const token = String(value == null ? '' : value).trim();
  if (token === '-1' || token === '-') return TRIT_PAIN;
  if (token === '1' || token === '+') return TRIT_OK;
  return TRIT_UNKNOWN;
}

function serializeTritVector(values: unknown[]) {
  const rows = Array.isArray(values) ? values : [];
  const digits = rows.map((row) => {
    const trit = normalizeTrit(row);
    if (trit === TRIT_PAIN) return '-';
    if (trit === TRIT_OK) return '+';
    return '0';
  }).join('');
  return {
    schema_id: 'balanced_trit_vector',
    schema_version: '1.0.0',
    encoding: 'balanced_ternary_sign',
    digits,
    values: rows.map(serializeTrit)
  };
}

function parseTritVector(payload: unknown): Trit[] {
  if (Array.isArray(payload)) return payload.map(parseSerializedTrit);
  if (!payload || typeof payload !== 'object') return [];
  const src = payload as { digits?: unknown; values?: unknown };
  if (Array.isArray(src.values)) return src.values.map(parseSerializedTrit);
  const digits = String(src.digits || '');
  if (!digits) return [];
  return digits.split('').map((char) => parseSerializedTrit(char));
}

export {
  TRIT_PAIN,
  TRIT_UNKNOWN,
  TRIT_OK,
  normalizeTrit,
  tritLabel,
  tritFromLabel,
  invertTrit,
  majorityTrit,
  consensusTrit,
  propagateTrit,
  serializeTrit,
  parseSerializedTrit,
  serializeTritVector,
  parseTritVector
};
