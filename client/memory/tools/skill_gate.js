/**
 * Skill Supply-Chain Gate
 * Verifies skills before execution to prevent untrusted/modified code from running
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const CONFIG_PATH = '/Users/jay/.openclaw/workspace/client/config/trusted_skills.json';

/**
 * Expand ~ to home directory
 */
function expandHome(filepath) {
  if (filepath.startsWith('~/')) {
    return path.join(os.homedir(), filepath.slice(2));
  }
  return filepath;
}

/**
 * Compute SHA-256 hash of file contents
 */
function computeHash(filepath) {
  const content = fs.readFileSync(filepath, 'utf8');
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Check if resolved path is within any allowlist root
 */
function isPathAllowlisted(resolvedPath, allowlistRoots) {
  for (const root of allowlistRoots) {
    const expandedRoot = expandHome(root);
    const realRoot = fs.realpathSync(expandedRoot);
    const realPath = fs.realpathSync(resolvedPath);
    
    // Ensure the path starts with the allowlist root (with realpath to defeat symlinks)
    if (realPath.startsWith(realRoot + path.sep) || realPath === realRoot) {
      return true;
    }
  }
  return false;
}

/**
 * Load trusted skills config
 */
function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`SKILL_GATE_CONFIG_MISSING: ${CONFIG_PATH} not found`);
  }
  const content = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(content);
}

/**
 * Verify a skill file before execution
 * @param {string} targetPath - Path to the skill file to verify
 * @returns {object} - { ok: true } if verified
 * @throws {Error} - With code: NOT_ALLOWLISTED | NOT_TRUSTED | HASH_MISMATCH
 */
function verifySkillOrThrow(targetPath) {
  const config = loadConfig();
  
  // Check break glass mode
  const breakGlassEnabled = config.break_glass && config.break_glass.enabled;
  const breakGlassEnv = process.env.OPENCLAW_BREAK_GLASS === '1';
  const breakGlassReason = process.env.OPENCLAW_BREAK_GLASS_REASON;
  
  if (breakGlassEnabled && breakGlassEnv) {
    if (!breakGlassReason || breakGlassReason.trim().length < 10) {
      throw new Error(
        'BREAK_GLASS_REASON_REQUIRED: OPENCLAW_BREAK_GLASS_REASON must be set with a meaningful reason (min 10 chars)'
      );
    }
    console.warn(`⚠️  BREAK GLASS MODE: Executing ${targetPath}`);
    console.warn(`⚠️  Reason: ${breakGlassReason}`);
    console.warn(`⚠️  This bypasses all security checks!`);
    return { ok: true, break_glass: true };
  }
  
  // Resolve absolute path
  const expandedPath = expandHome(targetPath);
  const resolvedPath = path.resolve(expandedPath);
  
  // Check if file exists
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`FILE_NOT_FOUND: ${resolvedPath} does not exist`);
  }
  
  // Check allowlist
  if (!isPathAllowlisted(resolvedPath, config.allowlist_roots)) {
    throw new Error(
      `NOT_ALLOWLISTED: ${resolvedPath} is not within any allowlist root. ` +
      `To approve: node /Users/jay/.openclaw/workspace/client/memory/tools/trust_add.js ${resolvedPath} "approval note"`
    );
  }
  
  // Check if trusted
  const trustedEntry = config.trusted_files[resolvedPath];
  if (!trustedEntry) {
    throw new Error(
      `NOT_TRUSTED: ${resolvedPath} has no pinned hash. ` +
      `To approve: node /Users/jay/.openclaw/workspace/client/memory/tools/trust_add.js ${resolvedPath} "approval note"`
    );
  }
  
  // Verify hash
  const currentHash = computeHash(resolvedPath);
  if (currentHash !== trustedEntry.sha256) {
    throw new Error(
      `HASH_MISMATCH: ${resolvedPath} has been modified since approval. ` +
      `Expected: ${trustedEntry.sha256}, Got: ${currentHash}. ` +
      `To re-approve: node /Users/jay/.openclaw/workspace/client/memory/tools/trust_add.js ${resolvedPath} "re-approval note"`
    );
  }
  
  return { ok: true, hash: currentHash, approved_by: trustedEntry.approved_by };
}

/**
 * Check if a skill is trusted without throwing
 * @param {string} targetPath - Path to check
 * @returns {object} - { trusted: boolean, error?: string, code?: string }
 */
function checkSkill(targetPath) {
  try {
    const result = verifySkillOrThrow(targetPath);
    return { trusted: true, break_glass: result.break_glass || false };
  } catch (err) {
    const code = err.message.split(':')[0];
    return { trusted: false, error: err.message, code };
  }
}

module.exports = {
  verifySkillOrThrow,
  checkSkill,
  computeHash,
  expandHome,
  CONFIG_PATH
};
