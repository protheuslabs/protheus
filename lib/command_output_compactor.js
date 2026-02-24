#!/usr/bin/env node
'use strict';

/**
 * Command output compaction helper.
 *
 * Wraps large command stdout/stderr through the existing tool-response compactor
 * and preserves a raw pointer when compaction occurs.
 */

const { compactToolResponse } = require('./tool_response_compactor');

function extractRawPathFromContent(content) {
  const txt = String(content || '');
  const m = txt.match(/📁 Raw output saved to:\s*([^\n]+)/);
  return m ? String(m[1] || '').trim() : null;
}

function compactCommandOutput(rawText, toolName) {
  const result = compactToolResponse(String(rawText || ''), { toolName: String(toolName || 'command_output') });
  const rawPathFromContent = extractRawPathFromContent(result.content);
  return {
    text: String(result.content || ''),
    compacted: result.compacted === true,
    raw_path: rawPathFromContent || null,
    metrics: result.metrics || null
  };
}

module.exports = {
  compactCommandOutput,
  extractRawPathFromContent
};

