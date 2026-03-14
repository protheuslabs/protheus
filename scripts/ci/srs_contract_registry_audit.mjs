#!/usr/bin/env node
/* eslint-disable no-console */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MANIFEST_PATH = 'planes/contracts/srs/manifest.json';
const TODO_QUEUE = 'core/local/artifacts/todo_execution_full_current.json';

function readJson(path) {
  return JSON.parse(readFileSync(resolve(path), 'utf8'));
}

function main() {
  const manifest = readJson(MANIFEST_PATH);
  const queue = readJson(TODO_QUEUE);

  const entries = Array.isArray(manifest.entries) ? manifest.entries : [];
  const executeRows = (Array.isArray(queue.rows) ? queue.rows : [])
    .filter((row) => row && row.todoBucket === 'execute_now')
    .map((row) => String(row.id || '').trim().toUpperCase())
    .filter(Boolean);

  const executeSet = new Set(executeRows);
  const entrySet = new Set(entries.map((e) => String(e.id || '').trim().toUpperCase()).filter(Boolean));

  const missingContracts = [];
  const invalidContracts = [];
  for (const id of executeSet) {
    const path = `planes/contracts/srs/${id}.json`;
    if (!existsSync(resolve(path))) {
      missingContracts.push({ id, path });
      continue;
    }
    try {
      const contract = readJson(path);
      if (String(contract.id || '').trim().toUpperCase() !== id) {
        invalidContracts.push({ id, reason: 'id_mismatch', path });
      }
      if (!String(contract.upgrade || '').trim()) {
        invalidContracts.push({ id, reason: 'missing_upgrade', path });
      }
      if (!String(contract.layer_map || '').trim()) {
        invalidContracts.push({ id, reason: 'missing_layer_map', path });
      }
    } catch (err) {
      invalidContracts.push({ id, reason: `parse_failed:${String(err)}`, path });
    }
  }

  const missingInManifest = [...executeSet].filter((id) => !entrySet.has(id));
  const staleManifestEntries = [...entrySet].filter((id) => !executeSet.has(id));

  const ok =
    missingContracts.length === 0 &&
    invalidContracts.length === 0 &&
    missingInManifest.length === 0;

  console.log(
    JSON.stringify(
      {
        ok,
        type: 'srs_contract_registry_audit',
        execute_now_count: executeSet.size,
        manifest_entry_count: entrySet.size,
        missing_contracts: missingContracts,
        invalid_contracts: invalidContracts,
        missing_in_manifest: missingInManifest,
        stale_manifest_entries: staleManifestEntries,
      },
      null,
      2,
    ),
  );

  if (!ok) process.exitCode = 1;
}

main();
