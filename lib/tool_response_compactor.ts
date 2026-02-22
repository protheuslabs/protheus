#!/usr/bin/env node
// @ts-nocheck
/**
 * Tool Response Compactor
 * 
 * Rules:
 * - If output > 1200 chars OR > 40 lines → save raw to logs/tool_raw/<timestamp>.txt
 * - Inject only: 5-10 bullet summary with key ids/urls/counts/errors
 * - Include pointer to raw log path
 * - Redact secrets (moltbook_sk_*, Authorization headers)
 */

const fs = require('fs');
const path = require('path');

const TOOL_RAW_DIR = path.join(__dirname, '..', 'logs', 'tool_raw');
const COMPACTION_THRESHOLD_CHARS = 1200;
const COMPACTION_THRESHOLD_LINES = 40;

/**
 * Redact sensitive information from content
 */
function redactSecrets(content) {
  if (typeof content !== 'string') return content;
  
  // Redact moltbook_sk_* tokens (show last 4 only)
  content = content.replace(/moltbook_sk_[a-zA-Z0-9]{32,}/g, (match) => {
    const last4 = match.slice(-4);
    return `moltbook_sk_****${last4}`;
  });
  
  // Redact Authorization: Bearer headers
  content = content.replace(/Authorization:\s*Bearer\s+[a-zA-Z0-9_-]+/gi, 'Authorization: Bearer [REDACTED]');
  
  return content;
}

/**
 * Extract key information for summary
 */
function extractSummary(data, toolName) {
  const bullets = [];
  
  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    
    // Count items if array
    if (Array.isArray(parsed)) {
      bullets.push(`• Count: ${parsed.length} items`);
    }
    
    // Extract IDs
    const ids = [];
    const extractIds = (obj) => {
      if (typeof obj !== 'object' || obj === null) return;
      for (const [key, val] of Object.entries(obj)) {
        if (key.toLowerCase().includes('id') && typeof val === 'string') {
          ids.push(val.substring(0, 8) + '...');
        }
        if (typeof val === 'object') extractIds(val);
      }
    };
    extractIds(parsed);
    if (ids.length > 0) {
      bullets.push(`• IDs: ${ids.slice(0, 5).join(', ')}${ids.length > 5 ? '...' : ''}`);
    }
    
    // Extract URLs
    const urls = [];
    const extractUrls = (obj) => {
      if (typeof obj !== 'object' || obj === null) return;
      for (const [key, val] of Object.entries(obj)) {
        if (typeof val === 'string' && (val.startsWith('http://') || val.startsWith('https://'))) {
          urls.push(val.substring(0, 50) + (val.length > 50 ? '...' : ''));
        }
        if (typeof val === 'object') extractUrls(val);
      }
    };
    extractUrls(parsed);
    if (urls.length > 0) {
      bullets.push(`• URLs: ${urls.slice(0, 3).join(', ')}${urls.length > 3 ? '...' : ''}`);
    }
    
    // Extract counts
    const counts = [];
    for (const [key, val] of Object.entries(parsed)) {
      if (typeof val === 'number' && (key.includes('count') || key.includes('total') || key.includes('upvotes') || key.includes('downvotes'))) {
        counts.push(`${key}: ${val}`);
      }
    }
    if (counts.length > 0) {
      bullets.push(`• Metrics: ${counts.slice(0, 4).join(', ')}`);
    }
    
    // Extract errors
    if (parsed.error || parsed.errors) {
      bullets.push(`• ⚠️ Error detected`);
    }
    if (parsed.status === 'error') {
      bullets.push(`• ⚠️ Status: error`);
    }
    
  } catch (e) {
    // Not JSON, extract what we can from text
    const lines = data.split('\n');
    if (lines.length > 0) {
      bullets.push(`• ${lines.length} lines of text output`);
    }
  }
  
  // Ensure at least 5 bullets, max 10
  while (bullets.length < 5 && bullets.length < 10) {
    if (!bullets.some(b => b.includes('Type:'))) {
      bullets.push(`• Type: ${toolName || 'tool output'}`);
    } else if (!bullets.some(b => b.includes('Status:'))) {
      bullets.push(`• Status: success`);
    } else {
      break;
    }
  }
  
  return bullets.slice(0, 10);
}

/**
 * Main compaction function
 */
function compactToolResponse(data, options = {}) {
  const toolName = options.toolName || 'unknown';
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const rawContent = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  
  const charCount = rawContent.length;
  const lineCount = rawContent.split('\n').length;
  
  // Check if compaction needed
  if (charCount <= COMPACTION_THRESHOLD_CHARS && lineCount <= COMPACTION_THRESHOLD_LINES) {
    // Small output, just redact and return
    return {
      compacted: false,
      content: redactSecrets(rawContent),
      metrics: { chars: charCount, lines: lineCount }
    };
  }
  
  // Compaction needed
  const safeToolName = toolName.replace(/[:\/]/g, '_');
  const rawFilename = `${safeToolName}_${timestamp}.txt`;
  const rawPath = path.join(TOOL_RAW_DIR, rawFilename);
  
  // Redact and save raw
  const redactedRaw = redactSecrets(rawContent);
  fs.writeFileSync(rawPath, redactedRaw, 'utf8');
  
  // Generate summary
  const summary = extractSummary(data, toolName);
  
  // Build compact output
  const compactOutput = [
    `📦 [TOOL OUTPUT COMPACTED]`,
    ``,
    ...summary,
    ``,
    `📁 Raw output saved to: logs/tool_raw/${rawFilename}`,
    `📊 Original: ${charCount} chars, ${lineCount} lines`,
    `📊 Compacted: ${summary.join('').length} chars (summary only)`
  ].join('\n');
  
  return {
    compacted: true,
    content: compactOutput,
    rawPath: rawPath,
    metrics: {
      originalChars: charCount,
      originalLines: lineCount,
      compactedChars: compactOutput.length,
      savingsPercent: Math.round(((charCount - compactOutput.length) / charCount) * 100)
    }
  };
}

/**
 * Redact sensitive information from content (redact-only mode)
 * Use when RAW_OK=true - redacts but doesn't compact
 */
function redactSecretsOnly(content) {
  return redactSecrets(content);
}

module.exports = { compactToolResponse, redactSecrets, redactSecretsOnly, extractSummary };

// CLI usage for testing
if (require.main === module) {
  // Read from stdin
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    const result = compactToolResponse(input, { toolName: process.argv[2] || 'test' });
    console.log(result.content);
    if (result.metrics) {
      console.error(`\n[COMPACTOR METRICS]`, JSON.stringify(result.metrics, null, 2));
    }
  });
}