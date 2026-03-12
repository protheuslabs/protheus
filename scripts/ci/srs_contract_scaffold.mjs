#!/usr/bin/env node
/* eslint-disable no-console */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_QUEUE_PATH = 'artifacts/todo_execution_full_current.json';
const DEFAULT_REGRESSION_PATH = 'artifacts/srs_full_regression_current.json';
const DEFAULT_IDS_OUT = 'artifacts/srs_contract_batch_ids_current.txt';
const CONTRACT_DIR = 'planes/contracts/srs';
const MANIFEST_PATH = `${CONTRACT_DIR}/manifest.json`;

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function writeJson(path, value) {
  mkdirSync(resolve(dirname(path)), { recursive: true });
  writeFileSync(resolve(path), `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path, value) {
  mkdirSync(resolve(dirname(path)), { recursive: true });
  writeFileSync(resolve(path), value);
}

function parseArgs(argv) {
  const out = new Map();
  for (const token of argv.slice(2)) {
    if (!token.startsWith('--')) continue;
    const idx = token.indexOf('=');
    if (idx === -1) {
      out.set(token.slice(2), '1');
    } else {
      out.set(token.slice(2, idx), token.slice(idx + 1));
    }
  }
  return out;
}

function toImpactNumber(raw) {
  const v = Number(String(raw ?? '').trim());
  return Number.isFinite(v) ? v : null;
}

function normalizeId(raw) {
  return String(raw || '').trim().toUpperCase();
}

function contractForRow(row, generatedAt, sourceTag) {
  const id = normalizeId(row.id);
  const upgrade = String(row.upgrade || '').trim();
  const conduitOnlyBoundary = /conduit-?only/i.test(upgrade);
  const layerMap = String(row.layerMap || '').trim();
  return {
    id,
    upgrade,
    section: String(row.section || '').trim(),
    impact: toImpactNumber(row.impact),
    layer_map: layerMap,
    conduit_only_boundary: conduitOnlyBoundary,
    todo_bucket: String(row.todoBucket || sourceTag || '').trim(),
    execution_contract: {
      runtime: 'core/layer2/ops:srs_contract_runtime',
      deterministic_receipt_required: true,
      mutable_state_path: `state/ops/srs_contract_runtime/${id}/latest.json`,
      history_path: 'state/ops/srs_contract_runtime/history.jsonl',
    },
    deliverables: [
      { type: 'contract', path: `planes/contracts/srs/${id}.json` },
      { type: 'state_receipt', path: `state/ops/srs_contract_runtime/${id}/latest.json` },
      { type: 'execution_history', path: 'state/ops/srs_contract_runtime/history.jsonl' },
    ],
    validation: {
      lane_command: `protheus-ops srs-contract-runtime run --id=${id}`,
      status_command: `protheus-ops srs-contract-runtime status --id=${id}`,
      fail_closed_on_missing_contract: true,
    },
    generated_from: {
      source: sourceTag,
      generated_at: generatedAt,
    },
  };
}

function rowsFromTodo(queuePath) {
  const queue = readJson(queuePath);
  const rows = Array.isArray(queue.rows) ? queue.rows : [];
  return rows
    .filter((row) => row && row.todoBucket === 'execute_now')
    .map((row) => ({ ...row, id: normalizeId(row.id) }))
    .filter((row) => row.id);
}

function rowsFromRegression(regressionPath) {
  const report = readJson(regressionPath);
  const rows = Array.isArray(report.rows) ? report.rows : [];
  return rows
    .filter((row) => row && String(row.status || '').trim() === 'done')
    .filter((row) => {
      const findings = row?.regression?.findings || [];
      return (
        findings.includes('done_without_non_backlog_evidence') ||
        findings.includes('done_without_code_or_test_evidence')
      );
    })
    .map((row) => ({
      id: normalizeId(row.id),
      upgrade: row.upgrade,
      section: row.section,
      impact: row.impact,
      layerMap: row.layerMap,
      todoBucket: 'regression_done_evidence_repair',
    }))
    .filter((row) => row.id);
}

function uniqueById(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = normalizeId(row.id);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ ...row, id });
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv);
  const source = String(args.get('source') || 'todo').trim().toLowerCase();
  const queuePath = String(args.get('queue-path') || DEFAULT_QUEUE_PATH);
  const regressionPath = String(args.get('regression-path') || DEFAULT_REGRESSION_PATH);
  const idsOutPath = String(args.get('ids-out') || DEFAULT_IDS_OUT);

  let sourceRows;
  let sourceRef;
  if (source === 'regression-fail-done') {
    sourceRows = rowsFromRegression(regressionPath);
    sourceRef = regressionPath;
  } else if (source === 'todo') {
    sourceRows = rowsFromTodo(queuePath);
    sourceRef = queuePath;
  } else {
    throw new Error(`unsupported --source value: ${source}`);
  }

  const rows = uniqueById(sourceRows);
  const generatedAt = new Date().toISOString();
  const written = [];
  const existing = [];

  for (const row of rows) {
    const relPath = `${CONTRACT_DIR}/${row.id}.json`;
    if (existsSync(resolve(relPath))) {
      existing.push(row.id);
      continue;
    }
    const payload = contractForRow(row, generatedAt, source);
    writeJson(relPath, payload);
    written.push(row.id);
  }

  const sortedIds = rows.map((row) => row.id).sort();
  const manifestRows = sortedIds.map((id) => ({ id, contract: `${CONTRACT_DIR}/${id}.json` }));
  writeJson(MANIFEST_PATH, {
    ok: true,
    type: 'srs_contract_manifest',
    generated_at: generatedAt,
    source,
    source_ref: sourceRef,
    row_count: rows.length,
    entries: manifestRows,
  });

  writeText(idsOutPath, `${sortedIds.join('\n')}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: 'srs_contract_scaffold',
        source,
        source_ref: sourceRef,
        target_rows: rows.length,
        written: written.length,
        existing: existing.length,
        ids_out: idsOutPath,
        manifest: MANIFEST_PATH,
      },
      null,
      2,
    ),
  );
}

main();
