'use strict';
export {};

const fs = require('fs');
const path = require('path');

type AnyObj = Record<string, any>;

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_BURN_ORACLE_LATEST_PATH = process.env.DYNAMIC_BURN_BUDGET_ORACLE_LATEST_PATH
  ? path.resolve(process.env.DYNAMIC_BURN_BUDGET_ORACLE_LATEST_PATH)
  : path.join(REPO_ROOT, 'state', 'ops', 'dynamic_burn_budget_oracle', 'latest.json');

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

function readJson(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function asFinite(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeBurnPressure(v: unknown): 'none' | 'low' | 'medium' | 'high' | 'critical' {
  const key = normalizeToken(v, 32);
  if (key === 'critical') return 'critical';
  if (key === 'high') return 'high';
  if (key === 'medium') return 'medium';
  if (key === 'low') return 'low';
  return 'none';
}

function pressureRank(v: unknown) {
  const p = normalizeBurnPressure(v);
  if (p === 'critical') return 4;
  if (p === 'high') return 3;
  if (p === 'medium') return 2;
  if (p === 'low') return 1;
  return 0;
}

function mapPressureToCostPressure(v: unknown) {
  const p = normalizeBurnPressure(v);
  if (p === 'critical') return 1;
  if (p === 'high') return 0.75;
  if (p === 'medium') return 0.45;
  if (p === 'low') return 0.2;
  return 0;
}

function relPath(filePath: string) {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

function loadDynamicBurnOracleSignal(opts: AnyObj = {}) {
  const rawPath = cleanText(opts.latest_path || opts.path || '', 520);
  const latestPath = rawPath
    ? (path.isAbsolute(rawPath) ? rawPath : path.join(REPO_ROOT, rawPath))
    : DEFAULT_BURN_ORACLE_LATEST_PATH;
  const payload = readJson(latestPath, null);
  const projection = payload && payload.projection && typeof payload.projection === 'object'
    ? payload.projection
    : {};
  const pressure = normalizeBurnPressure(
    opts.pressure
    || projection.pressure
    || (payload && payload.pressure)
    || 'none'
  );
  const projectedRunwayDays = asFinite(
    projection.projected_runway_days_regime
    ?? projection.projected_runway_days
    ?? (payload && payload.projected_runway_days)
  );
  const reasonCodes = Array.isArray(projection.reason_codes)
    ? projection.reason_codes
    : (Array.isArray(payload && payload.reason_codes) ? payload.reason_codes : []);
  const available = !!(
    payload
    && typeof payload === 'object'
    && (
      payload.ok === true
      || (projection && typeof projection === 'object' && Object.keys(projection).length > 0)
    )
  );

  return {
    available,
    pressure,
    pressure_rank: pressureRank(pressure),
    cost_pressure: mapPressureToCostPressure(pressure),
    projected_runway_days: projectedRunwayDays,
    projected_days_to_reset: asFinite(
      projection.projected_days_to_reset
      ?? (payload && payload.projected_days_to_reset)
    ),
    providers_available: Number(projection.providers_available || 0) || 0,
    reason_codes: reasonCodes
      .map((v: unknown) => normalizeToken(v, 80))
      .filter(Boolean)
      .slice(0, 24),
    latest_path: latestPath,
    latest_path_rel: relPath(latestPath),
    ts: cleanText(
      payload && payload.ts
      || payload && payload.updated_at
      || payload && payload.last_updated_at
      || '',
      60
    ) || null,
    cadence: payload && payload.cadence && typeof payload.cadence === 'object'
      ? payload.cadence
      : null,
    projection,
    payload
  };
}

module.exports = {
  DEFAULT_BURN_ORACLE_LATEST_PATH,
  normalizeBurnPressure,
  pressureRank,
  mapPressureToCostPressure,
  loadDynamicBurnOracleSignal
};
