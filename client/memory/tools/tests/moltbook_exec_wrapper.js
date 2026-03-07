#!/usr/bin/env node
/**
 * moltbook_exec_wrapper.js - Moltbook API calls via execCompacted
 * 
 * All Moltbook API calls should route through this wrapper to ensure
 * compaction and redaction are applied.
 * 
 * ⚠️  DO NOT call curl directly via exec(). Use these functions instead.
 */

const { execCompacted } = require('../../../lib/exec_compacted.js');
const fs = require('fs');
const path = require('path');

/**
 * Get API key from credentials file
 */
function getApiKey() {
  // Try workspace path first
  const workspacePath = path.join(__dirname, '..', '..', 'config', 'moltbook', 'credentials.json');
  const fallbackPath = path.join(process.env.HOME || '~', '.config', 'moltbook', 'credentials.json');
  
  let credentials = null;
  
  try {
    if (fs.existsSync(workspacePath)) {
      credentials = JSON.parse(fs.readFileSync(workspacePath, 'utf8'));
    } else if (fs.existsSync(fallbackPath)) {
      credentials = JSON.parse(fs.readFileSync(fallbackPath, 'utf8'));
    }
  } catch (err) {
    // Fall through to env var
  }
  
  // Environment variable takes precedence
  return process.env.MOLTBOOK_TOKEN || (credentials && credentials.api_key) || null;
}

/**
 * Fetch hot posts from Moltbook
 * @param {number} limit - Number of posts to fetch
 * @returns {Promise<{ok: boolean, toolName: string, text: string, raw_path: string|null, exit_code: number}>}
 */
async function fetchHotPosts(limit = 5) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      toolName: 'exec:moltbook:posts',
      text: 'Error: MOLTBOOK_TOKEN not configured',
      raw_path: null,
      exit_code: 1
    };
  }
  
  const cmd = `curl -sL -X GET 'https://www.moltbook.com/api/v1/posts?sort=hot&limit=${limit}' -H 'Authorization: Bearer ${apiKey}'`;
  
  return await execCompacted(cmd, {
    toolName: 'exec:moltbook:posts',
    execOptions: { timeout: 15000 }
  });
}

/**
 * Fetch comments for a post
 * @param {string} postId - Post ID
 * @param {number} limit - Number of comments to fetch
 * @returns {Promise<{ok: boolean, toolName: string, text: string, raw_path: string|null, exit_code: number}>}
 */
async function fetchComments(postId, limit = 10) {
  const apiKey = getApiKey();
  if (!apiKey) {
    return {
      ok: false,
      toolName: 'exec:moltbook:comments',
      text: 'Error: MOLTBOOK_TOKEN not configured',
      raw_path: null,
      exit_code: 1
    };
  }
  
  const cmd = `curl -sL -X GET 'https://www.moltbook.com/api/v1/posts/${postId}/comments?limit=${limit}' -H 'Authorization: Bearer ${apiKey}'`;
  
  return await execCompacted(cmd, {
    toolName: 'exec:moltbook:comments',
    execOptions: { timeout: 15000 }
  });
}

/**
 * CLI entry point for testing
 */
async function main() {
  const args = process.argv.slice(2);
  const action = args[0] || 'posts';
  
  let result;
  
  switch (action) {
    case 'posts':
      result = await fetchHotPosts(parseInt(args[1]) || 5);
      break;
    case 'comments':
      result = await fetchComments(args[1] || 'test-post', parseInt(args[2]) || 10);
      break;
    default:
      console.error('Usage: node moltbook_exec_wrapper.js [posts|comments] [args...]');
      process.exit(1);
  }
  
  // Output the compacted text to stdout (for context injection)
  console.log(result.text);
  
  // Exit with the original exit code
  process.exit(result.exit_code);
}

if (require.main === module) {
  main();
}

module.exports = {
  fetchHotPosts,
  fetchComments,
  getApiKey
};