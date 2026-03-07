#!/usr/bin/env node
'use strict';

/**
 * Runtime lane for SYSTEMS-SENSORY-TEMPORAL-PATTERNS.
 * Native execution delegated through conduit to Rust kernel runtime.
 */

const fs = require('fs');
const path = require('path');

function findRepoRoot(startDir) {
  let dir = path.resolve(startDir || process.cwd());
  while (true) {
    if (
      fs.existsSync(path.join(dir, 'Cargo.toml'))
      && (
        fs.existsSync(path.join(dir, 'core', 'layer0', 'ops', 'Cargo.toml'))
        || fs.existsSync(path.join(dir, 'crates', 'ops', 'Cargo.toml'))
      )
    ) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return process.cwd();
    dir = parent;
  }
}

const ROOT = findRepoRoot(__dirname);
const { createConduitLaneModule } = require(path.join(ROOT, 'client', 'lib', 'direct_conduit_lane_bridge.js'));

const lane = createConduitLaneModule('SYSTEMS-SENSORY-TEMPORAL-PATTERNS', ROOT);
const { LANE_ID, buildLaneReceipt, verifyLaneReceipt } = lane;

function nowIso() {
  return new Date().toISOString();
}

function cleanText(v: unknown, maxLen = 200) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function readJsonSafe(filePath: string, fallback: any = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

function ensureDir(absDir: string) {
  fs.mkdirSync(absDir, { recursive: true });
}

function writeJsonSafe(filePath: string, payload: any) {
  ensureDir(path.dirname(filePath));
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function statePathCandidates(...relParts: string[]) {
  const rel = path.join(...relParts);
  return [
    path.join(ROOT, 'client', 'local', 'state', rel),
    path.join(ROOT, 'state', rel)
  ];
}

function firstExistingPath(candidates: string[]) {
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function parseTs(v: unknown) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function analyzeTemporalPatterns(input: any = {}) {
  const dateStr = cleanText(input && input.dateStr, 20) || nowIso().slice(0, 10);
  const lookbackDaysRaw = Number(input && input.lookbackDays);
  const lookbackDays = Number.isFinite(lookbackDaysRaw) && lookbackDaysRaw > 0
    ? Math.min(60, Math.max(1, Math.floor(lookbackDaysRaw)))
    : 7;
  const write = input && input.write === false ? false : true;

  const registryPath = firstExistingPath(statePathCandidates('sensory', 'eyes', 'registry.json'));
  const trendPath = firstExistingPath(statePathCandidates('sensory', 'trends', `${dateStr}.json`));
  const anomalyPath = firstExistingPath(statePathCandidates('sensory', 'anomalies', `${dateStr}.json`));
  const registry = readJsonSafe(registryPath, {});
  const eyes = Array.isArray(registry && registry.eyes) ? registry.eyes : [];
  const nowMs = Date.now();
  const darkCandidates: any[] = [];
  const anomalies: any[] = [];

  for (const row of eyes) {
    const eye = row && typeof row === 'object' ? row : {};
    const eyeId = cleanText(eye.id, 80);
    if (!eyeId) continue;
    const status = cleanText(eye.status || 'active', 40).toLowerCase();
    const parserType = cleanText(eye.parser_type || '', 80).toLowerCase();
    if (status === 'retired') continue;
    if (parserType === 'stub') continue;

    const cadenceHours = Math.max(1, Number(eye.cadence_hours || 24));
    const staleHours = Math.max(
      cadenceHours * 2,
      Math.min(24 * lookbackDays, 24 * 14)
    );
    const lastSuccessMs = parseTs(eye.last_success || eye.last_real_signal_ts || eye.last_run || eye.last_run_ts);
    const hoursSinceSuccess = lastSuccessMs == null
      ? Number.POSITIVE_INFINITY
      : Math.max(0, (nowMs - lastSuccessMs) / (1000 * 60 * 60));
    const consecutiveFailures = Math.max(0, Number(eye.consecutive_failures || 0));
    const noSignalRuns = Math.max(0, Number(eye.consecutive_no_signal_runs || 0));
    const darkByFailures = consecutiveFailures >= 2;
    const darkByNoSignal = noSignalRuns >= 3;
    const darkByStale = !Number.isFinite(hoursSinceSuccess) || hoursSinceSuccess >= staleHours;

    if (darkByFailures || darkByNoSignal || darkByStale) {
      const darkReason = darkByFailures
        ? 'stale_failures'
        : (darkByNoSignal ? 'stale_no_signal_runs' : 'silence_exceeded');
      darkCandidates.push({
        eye_id: eyeId,
        dark_reason: darkReason,
        parser_type: parserType || null,
        status,
        consecutive_failures: consecutiveFailures,
        consecutive_no_signal_runs: noSignalRuns,
        hours_since_success: Number.isFinite(hoursSinceSuccess) ? Math.round(hoursSinceSuccess * 10) / 10 : null,
        source: 'temporal_patterns'
      });
    }
  }

  const outage = registry && registry.outage_mode && typeof registry.outage_mode === 'object'
    ? registry.outage_mode
    : {};
  if (outage.active === true) {
    anomalies.push({
      kind: 'infra_outage_mode',
      severity: 'warn',
      failed_transport_eyes: Number(outage.last_failed_transport_eyes || 0),
      window_hours: Number(outage.last_window_hours || 0),
      since: cleanText(outage.since, 64) || null
    });
  }

  const report = {
    ts: nowIso(),
    type: 'temporal_patterns',
    date: dateStr,
    lookback_days: lookbackDays,
    dark_candidates: darkCandidates,
    anomalies,
    registry_path: registryPath,
    trend_path: trendPath,
    anomaly_path: anomalyPath
  };

  if (write) {
    writeJsonSafe(trendPath, report);
    writeJsonSafe(anomalyPath, {
      ts: report.ts,
      type: 'temporal_anomalies',
      date: dateStr,
      anomalies
    });
  }

  return report;
}

module.exports = {
  ...lane,
  analyzeTemporalPatterns,
  LANE_ID,
  buildLaneReceipt,
  verifyLaneReceipt
};

if (require.main === module) {
  buildLaneReceipt()
    .then((row) => {
      console.log(JSON.stringify(row, null, 2));
      process.exit(row && row.ok === true ? 0 : 1);
    })
    .catch((err) => {
      console.error(
        JSON.stringify(
          {
            ok: false,
            type: 'conduit_lane_bridge_error',
            lane_id: LANE_ID,
            error: String(err && err.message ? err.message : err),
          },
          null,
          2,
        ),
      );
      process.exit(1);
    });
}

export {};
