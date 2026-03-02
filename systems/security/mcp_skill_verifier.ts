#!/usr/bin/env node
'use strict';
export {};

/**
 * MCP skill verifier primitive for V3-RACE-165.
 */

const { cleanText, stableHash } = require('../../lib/queued_backlog_runtime');

function verifyMcpSkillDescriptor(descriptor: Record<string, any>) {
  const id = cleanText(descriptor && descriptor.id || '', 120);
  const source = cleanText(descriptor && descriptor.source || '', 500);
  const signature = cleanText(descriptor && descriptor.signature || '', 200);
  if (!id || !source) {
    return {
      ok: false,
      error: 'missing_id_or_source'
    };
  }
  const expected = stableHash(`${id}|${source}`, 16);
  const signaturePresent = Boolean(signature);
  const signatureValid = !signaturePresent || signature === expected;
  return {
    ok: signatureValid,
    skill_id: id,
    source,
    verifier: 'mcp_skill_verifier',
    signature_present: signaturePresent,
    signature_valid: signatureValid,
    expected_signature: expected
  };
}

module.exports = {
  verifyMcpSkillDescriptor
};
