#!/usr/bin/env node
'use strict';
export {};

const crypto = require('crypto');
const { classifyCommandPrimitive, classifyActuationPrimitive, loadPrimitiveCatalog, describePrimitiveOpcode } = require('./primitive_catalog.js');

type AnyObj = Record<string, any>;

function cleanText(v: unknown, maxLen = 240) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function hashPayload(v: unknown) {
  return crypto.createHash('sha256').update(JSON.stringify(v == null ? null : v)).digest('hex');
}

function compileCommandToGrammar(command: unknown, opts: AnyObj = {}) {
  const primitive = classifyCommandPrimitive(command, opts);
  const catalog = loadPrimitiveCatalog();
  const primitiveMeta = describePrimitiveOpcode(primitive.opcode, catalog);
  return {
    grammar_id: 'universal_action_grammar',
    grammar_version: '1.0',
    catalog_version: catalog.schema_version,
    runtime_kind: 'command',
    opcode: primitive.opcode,
    effect: primitive.effect,
    primitive_metadata: primitiveMeta ? primitiveMeta.metadata : null,
    confidence: Number(primitive.confidence || 0),
    source: primitive.source || null,
    command_preview: cleanText(primitive.command || command || '', 240),
    command_hash: hashPayload(cleanText(primitive.command || command || '', 4000)),
    step_id: cleanText(opts.step_id || '', 80) || null,
    step_type: cleanText(opts.step_type || '', 40).toLowerCase() || 'command',
    workflow_id: cleanText(opts.workflow_id || '', 120) || null,
    run_id: cleanText(opts.run_id || '', 120) || null,
    objective_id: cleanText(opts.objective_id || '', 120) || null,
    adapter: cleanText(opts.adapter || '', 80) || null,
    provider: cleanText(opts.provider || '', 80) || null,
    dry_run: opts.dry_run === true
  };
}

function compileActuationToGrammar(kind: unknown, params: unknown, opts: AnyObj = {}) {
  const primitive = classifyActuationPrimitive(kind, { params });
  const catalog = loadPrimitiveCatalog();
  const primitiveMeta = describePrimitiveOpcode(primitive.opcode, catalog);
  const paramsObj = params && typeof params === 'object' ? params : {};
  return {
    grammar_id: 'universal_action_grammar',
    grammar_version: '1.0',
    catalog_version: catalog.schema_version,
    runtime_kind: 'adapter',
    opcode: primitive.opcode,
    effect: primitive.effect,
    primitive_metadata: primitiveMeta ? primitiveMeta.metadata : null,
    confidence: Number(primitive.confidence || 0),
    source: primitive.source || null,
    adapter_kind: primitive.adapter_kind || cleanText(kind || '', 80) || 'unknown_adapter',
    params_hash: hashPayload(paramsObj),
    workflow_id: cleanText(opts.workflow_id || '', 120) || null,
    run_id: cleanText(opts.run_id || '', 120) || null,
    objective_id: cleanText(opts.objective_id || '', 120) || null,
    dry_run: opts.dry_run === true
  };
}

module.exports = {
  compileCommandToGrammar,
  compileActuationToGrammar
};
