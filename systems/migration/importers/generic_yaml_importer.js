'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const MANIFEST = path.join(ROOT, 'crates', 'execution', 'Cargo.toml');
const legacy = require('./generic_yaml_importer_legacy.js');

function cleanText(v, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseJsonPayload(raw) {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try { return JSON.parse(text); } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function binaryCandidates() {
  const explicit = cleanText(process.env.PROTHEUS_EXECUTION_RUST_BIN || '', 500);
  const out = [
    explicit,
    path.join(ROOT, 'target', 'release', 'execution_core'),
    path.join(ROOT, 'target', 'debug', 'execution_core'),
    path.join(ROOT, 'crates', 'execution', 'target', 'release', 'execution_core'),
    path.join(ROOT, 'crates', 'execution', 'target', 'debug', 'execution_core')
  ].filter(Boolean);
  return Array.from(new Set(out));
}

function runViaRustBinary(payloadBase64) {
  for (const candidate of binaryCandidates()) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const out = spawnSync(candidate, ['importer-generic-yaml', `--payload-base64=${payloadBase64}`], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
      });
      const parsed = parseJsonPayload(out.stdout);
      if (Number(out.status) === 0 && parsed && parsed.ok === true && parsed.payload && typeof parsed.payload === 'object') {
        return { ok: true, payload: parsed.payload };
      }
    } catch {
      // continue
    }
  }
  return { ok: false };
}

function runViaCargo(payloadBase64) {
  const args = [
    'run',
    '--quiet',
    '--manifest-path',
    MANIFEST,
    '--bin',
    'execution_core',
    '--',
    'importer-generic-yaml',
    `--payload-base64=${payloadBase64}`
  ];
  const out = spawnSync('cargo', args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const parsed = parseJsonPayload(out.stdout);
  if (Number(out.status) === 0 && parsed && parsed.ok === true && parsed.payload && typeof parsed.payload === 'object') {
    return { ok: true, payload: parsed.payload };
  }
  return {
    ok: false,
    error: cleanText(out.stderr || out.stdout || '', 260)
  };
}

function normalizeImportedPayload(payload) {
  const entities = payload && typeof payload.entities === 'object'
    ? payload.entities
    : {};
  return {
    entities: {
      agents: Array.isArray(entities.agents) ? entities.agents : [],
      tasks: Array.isArray(entities.tasks) ? entities.tasks : [],
      workflows: Array.isArray(entities.workflows) ? entities.workflows : [],
      tools: Array.isArray(entities.tools) ? entities.tools : [],
      records: Array.isArray(entities.records) ? entities.records : []
    },
    source_item_count: Number(payload && payload.source_item_count || 0),
    mapped_item_count: Number(payload && payload.mapped_item_count || 0),
    warnings: Array.isArray(payload && payload.warnings)
      ? payload.warnings.map((v) => cleanText(v, 220)).filter(Boolean)
      : []
  };
}

function importPayload(payload, context = {}) {
  const encoded = Buffer.from(JSON.stringify(payload == null ? '' : payload), 'utf8').toString('base64');

  const rustBinary = runViaRustBinary(encoded);
  if (rustBinary.ok && rustBinary.payload) {
    return normalizeImportedPayload(rustBinary.payload);
  }

  const rustCargo = runViaCargo(encoded);
  if (rustCargo.ok && rustCargo.payload) {
    return normalizeImportedPayload(rustCargo.payload);
  }

  return legacy.importPayload(payload, context);
}

module.exports = {
  engine: 'generic_yaml',
  parseSimpleYaml: legacy.parseSimpleYaml,
  importPayload
};
