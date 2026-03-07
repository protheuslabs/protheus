'use strict';
export {};

const { createDomainProxy } = require('../../../lib/legacy_conduit_proxy');

type AnyObj = Record<string, any>;

const runDomain = createDomainProxy(__dirname, 'IMPORTER_WORKFLOW_GRAPH', 'execution-yield-recovery');

function cleanText(v: unknown, maxLen = 260) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function runViaConduit(payloadBase64: string) {
  const out = runDomain(['importer-workflow-graph', `--payload-base64=${String(payloadBase64 || '')}`]);
  if (out && out.ok === true && out.payload && typeof out.payload === 'object' && out.payload.ok === true && out.payload.payload && typeof out.payload.payload === 'object') {
    return { ok: true, payload: out.payload.payload };
  }
  return { ok: false, error: cleanText(out && out.error || 'conduit_importer_unavailable', 260) };
}

function normalizeImportedPayload(payload: AnyObj) {
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
      ? payload.warnings.map((v: unknown) => cleanText(v, 220)).filter(Boolean)
      : []
  };
}

function importPayload(payload: unknown, context: AnyObj = {}) {
  void context;
  const encoded = Buffer.from(JSON.stringify(payload == null ? {} : payload), 'utf8').toString('base64');
  const result = runViaConduit(encoded);
  if (result.ok && result.payload) {
    return normalizeImportedPayload(result.payload);
  }
  const err = cleanText(result.error || 'conduit_importer_unavailable', 220);
  return {
    entities: {
      agents: [],
      tasks: [],
      workflows: [],
      tools: [],
      records: []
    },
    source_item_count: 0,
    mapped_item_count: 0,
    warnings: [`conduit_importer_unavailable:${err}`]
  };
}

module.exports = {
  engine: 'workflow_graph',
  importPayload
};
