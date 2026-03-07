'use strict';

export {};

const fs = require('fs') as typeof import('fs');
const {
  nowIso,
  cleanText,
  appendJsonl,
  writeJsonAtomic,
  clampInt
} = require('./queued_backlog_runtime');

type AnyObj = Record<string, any>;

type ArtifactOptions = {
  schemaId?: string,
  schemaVersion?: string,
  artifactType?: string,
  writeLatest?: boolean,
  appendReceipt?: boolean,
  maxReceiptRows?: number
};

function decorateArtifactRow(payload: AnyObj, opts: ArtifactOptions = {}) {
  return {
    schema_id: cleanText(opts.schemaId || payload.schema_id || 'state_artifact_row', 120) || 'state_artifact_row',
    schema_version: cleanText(opts.schemaVersion || payload.schema_version || '1.0', 40) || '1.0',
    artifact_type: cleanText(opts.artifactType || payload.artifact_type || 'receipt', 80) || 'receipt',
    ts: cleanText(payload.ts || nowIso(), 48) || nowIso(),
    ...payload
  };
}

function trimJsonlRows(filePath: string, maxRows: number) {
  const cap = clampInt(maxRows, 1, 1_000_000, 0);
  if (!cap) return;
  try {
    if (!fs.existsSync(filePath)) return;
    const rows = String(fs.readFileSync(filePath, 'utf8') || '').split('\n').filter(Boolean);
    if (rows.length <= cap) return;
    const keep = rows.slice(rows.length - cap).join('\n') + '\n';
    fs.writeFileSync(filePath, keep, 'utf8');
  } catch {
    // Fail-open for retention trimming; main write path already completed.
  }
}

function writeArtifactSet(paths: {
  latestPath?: string,
  receiptsPath?: string,
  historyPath?: string
}, payload: AnyObj, opts: ArtifactOptions = {}) {
  const row = decorateArtifactRow(payload, opts);
  if (opts.writeLatest !== false && paths && paths.latestPath) {
    writeJsonAtomic(paths.latestPath, row);
  }
  if (opts.appendReceipt !== false && paths && paths.receiptsPath) {
    appendJsonl(paths.receiptsPath, row);
    if (opts.maxReceiptRows != null) trimJsonlRows(paths.receiptsPath, opts.maxReceiptRows);
  }
  if (paths && paths.historyPath) {
    appendJsonl(paths.historyPath, row);
  }
  return row;
}

function appendArtifactHistory(historyPath: string, payload: AnyObj, opts: ArtifactOptions = {}) {
  const row = decorateArtifactRow(payload, opts);
  appendJsonl(historyPath, row);
  return row;
}

module.exports = {
  decorateArtifactRow,
  writeArtifactSet,
  appendArtifactHistory,
  trimJsonlRows
};
