#!/usr/bin/env node
/**
 * Test skill for Moltbook API compaction verification
 * Uses execCompacted() wrapper for automatic redaction + compaction
 */

const { execCompacted } = require('../../lib/exec_compacted.js');

async function main() {
  // Get API key from environment
  const apiKey = process.env.MOLTBOOK_TOKEN || 'test_token';
  
  // Make Moltbook API call via execCompacted (automatic compaction)
  const cmd = `curl -sL -X GET 'https://www.moltbook.com/api/v1/posts?sort=hot&limit=3' -H 'Authorization: Bearer ${apiKey}'`;
  
  const result = await execCompacted(cmd, {
    toolName: 'exec:moltbook:posts',
    execOptions: { timeout: 10000 }
  });
  
  // Output compacted text to stdout (goes to working context)
  console.log(result.text);
  
  process.exit(result.exit_code);
}

main().catch(err => {
  console.error('API call failed:', err.message);
  process.exit(1);
});