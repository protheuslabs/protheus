#!/usr/bin/env node
// @ts-nocheck
/**
 * exec_compacted.js - Global exec wrapper with compaction
 * 
 * ⚠️  ENFORCEMENT: DO NOT call child_process exec/execFile directly.
 *     Use execCompacted() for ALL shell command execution.
 *     Direct exec() calls bypass secret redaction and token compaction.
 */

const { exec, execFile } = require('child_process');
const { processToolOutput } = require('./tool_compactor_integration.js');
const { redactSecretsOnly } = require('./tool_response_compactor.js');

// NEW: Tiered Directives enforcement
const { autoClassifyAndCreate, ACTION_TYPES } = require('./action_envelope.js');
const { validateAction } = require('./directive_resolver.js');
const { queueForApproval, formatBlockedResponse, formatApprovalRequiredResponse, wasApproved } = require('./approval_gate.js');

/**
 * Check if text is already compacted (prevent double-compaction)
 */
function isAlreadyCompacted(text) {
  return text && text.includes('📦 [TOOL OUTPUT COMPACTED]');
}

/**
 * Execute a shell command with automatic compaction and redaction
 * 
 * @param {string} command - Shell command to execute
 * @param {Object} options - Options object
 * @param {string} options.toolName - Name for the tool (e.g., 'exec:moltbook:posts')
 * @param {Object} options.execOptions - child_process.exec options (timeout, cwd, etc.)
 * @returns {Promise<{ok: boolean, toolName: string, text: string, raw_path: string|null, exit_code: number}>}
 */
async function execCompacted(command, options = {}) {
  const {
    toolName = 'exec:unknown',
    execOptions = {},
    skipDirectiveCheck = false  // For internal/bootstrap use
  } = options;

  // NEW: Tiered Directives enforcement (unless skipped)
  if (!skipDirectiveCheck) {
    const actionEnvelope = autoClassifyAndCreate({
      toolName: toolName,
      commandText: command,
      summary: `Execute: ${command.substring(0, 80)}${command.length > 80 ? '...' : ''}`
    });
    
    const validation = validateAction(actionEnvelope);
    
    if (!validation.allowed) {
      return {
        ok: false,
        toolName,
        text: formatBlockedResponse(validation),
        raw_path: null,
        exit_code: 1,
        blocked: true
      };
    }
    
    if (validation.requires_approval && !wasApproved(actionEnvelope.action_id)) {
      const queueResult = queueForApproval(actionEnvelope, validation.approval_reason);
      return {
        ok: false,
        toolName,
        text: formatApprovalRequiredResponse(queueResult),
        raw_path: null,
        exit_code: 0, // Not an error, just needs approval
        approval_required: true,
        action_id: actionEnvelope.action_id
      };
    }
  }

  return new Promise((resolve) => {
    const child = exec(command, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10MB max buffer
      ...execOptions
    }, (error, stdout, stderr) => {
      // Combine stdout and stderr
      let rawOutput = stdout || '';
      if (stderr) {
        rawOutput += '\n[STDERR]\n' + stderr;
      }

      // Always redact secrets first
      let processedOutput = redactSecretsOnly(rawOutput);

      // Determine exit code
      const exitCode = error ? (error.code || 1) : 0;
      const ok = exitCode === 0;

      // Check for double compaction
      if (isAlreadyCompacted(processedOutput)) {
        resolve({
          ok,
          toolName,
          text: processedOutput,
          raw_path: null,
          exit_code: exitCode
        });
        return;
      }

      // Apply compaction if output is large
      // (processToolOutput handles thresholds internally)
      const compacted = processToolOutput(toolName, processedOutput);
      
      // Check if compaction actually happened by looking for the marker
      const wasCompacted = compacted.includes('📦 [TOOL OUTPUT COMPACTED]');

      // Extract raw_path from compacted output if present
      let rawPath = null;
      if (wasCompacted) {
        const pathMatch = compacted.match(/📁 Raw output saved to: (.+)/);
        if (pathMatch) {
          rawPath = pathMatch[1].trim();
        }
      }

      resolve({
        ok,
        toolName,
        text: compacted,
        raw_path: rawPath,
        exit_code: exitCode
      });
    });
  });
}

/**
 * Execute a file directly with arguments (safer than shell exec)
 * 
 * @param {string} file - Path to executable
 * @param {string[]} args - Arguments array
 * @param {Object} options - Options object
 * @param {string} options.toolName - Name for the tool
 * @param {Object} options.execOptions - child_process.execFile options
 * @returns {Promise<{ok: boolean, toolName: string, text: string, raw_path: string|null, exit_code: number}>}
 */
function execFileCompacted(file, args = [], options = {}) {
  const {
    toolName = `exec:${require('path').basename(file)}`,
    execOptions = {}
  } = options;

  return new Promise((resolve) => {
    execFile(file, args, {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      ...execOptions
    }, (error, stdout, stderr) => {
      let rawOutput = stdout || '';
      if (stderr) {
        rawOutput += '\n[STDERR]\n' + stderr;
      }

      let processedOutput = redactSecretsOnly(rawOutput);
      const exitCode = error ? (error.code || 1) : 0;
      const ok = exitCode === 0;

      if (isAlreadyCompacted(processedOutput)) {
        resolve({
          ok,
          toolName,
          text: processedOutput,
          raw_path: null,
          exit_code: exitCode
        });
        return;
      }

      const compacted = processToolOutput(toolName, processedOutput);
      const wasCompacted = compacted.includes('📦 [TOOL OUTPUT COMPACTED]');

      let rawPath = null;
      if (wasCompacted) {
        const pathMatch = compacted.match(/📁 Raw output saved to: (.+)/);
        if (pathMatch) {
          rawPath = pathMatch[1].trim();
        }
      }

      resolve({
        ok,
        toolName,
        text: compacted,
        raw_path: rawPath,
        exit_code: exitCode
      });
    });
  });
}

module.exports = {
  execCompacted,
  execFileCompacted,
  isAlreadyCompacted
};

// Enforcement reminder:
// Every direct child_process.exec/execFile call is a security/compaction bypass.
// Audit command: grep -r "require.*child_process" --include="*.js" .
// Migrate all findings to use execCompacted() or execFileCompacted().
