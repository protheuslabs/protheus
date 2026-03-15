#!/usr/bin/env node
/**
 * skill_runner.js - Safe skill execution wrapper
 * Enforces supply-chain verification before running any skill
 * 
 * NEW: Global tool output compaction - ALL skill outputs are redacted + compacted
 * before entering working context.
 */

const { verifySkillOrThrow } = require('./skill_gate');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const WORKSPACE_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const TRUST_ADD_CMD = `node ${path.join(WORKSPACE_ROOT, 'tests', 'tooling', 'scripts', 'memory', 'trust_add.ts')}`;

// Import compactor for global chokepoint integration
const { processToolOutput } = require('../../../../client/runtime/lib/tool_compactor_integration.ts');
const { redactSecretsOnly } = require('../../../../client/runtime/lib/tool_response_compactor.ts');

// NEW: Tiered Directives enforcement
const { autoClassifyAndCreate } = require('../../../../client/runtime/lib/action_envelope.ts');
const { validateAction } = require('../../../../client/runtime/lib/directive_resolver.ts');
const { queueForApproval, formatBlockedResponse, formatApprovalRequiredResponse, wasApproved } = require('../../../../client/runtime/lib/approval_gate.ts');

/**
 * Helper: Convert anything to text representation
 */
function asText(x) {
  if (typeof x === 'string') return x;
  if (x === null || x === undefined) return String(x);
  if (typeof x === 'object') return JSON.stringify(x, null, 2);
  return String(x);
}

/**
 * Check if text is already compacted (prevent double-compaction)
 */
function isAlreadyCompacted(text) {
  return text.includes('📦 [TOOL OUTPUT COMPACTED]');
}

/**
 * Execute skill with output compaction
 * Runs skill as child process to capture stdout for compaction
 */
async function runSkillWithCompaction(skillPath, skillArgs, toolName) {
  return new Promise((resolve, reject) => {
    // Use provided toolName or derive from skill path
    const derivedToolName = toolName || (() => {
      const skillName = path.basename(skillPath, '.js');
      const actionHint = skillArgs.length > 0 ? skillArgs[0] : 'run';
      return `skill:${skillName}/${actionHint}`;
    })();
    
    // Spawn skill as child process
    const child = spawn('node', [skillPath, ...skillArgs], {
      stdio: ['inherit', 'pipe', 'pipe']
    });
    
    let stdout = '';
    let stderr = '';
    
    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    child.on('close', (code) => {
      // Combine stdout/stderr for compaction
      let rawOutput = stdout;
      if (stderr) {
        rawOutput += '\n[STDERR]\n' + stderr;
      }
      
      // Convert to text
      const rawText = asText(rawOutput);
      
      // Prevent double-compaction
      if (isAlreadyCompacted(rawText)) {
        resolve(rawText);
        return;
      }
      
      // RAW_OK mode: redact only, no compaction
      if (process.env.RAW_OK === 'true') {
        const redacted = redactSecretsOnly(rawText);
        resolve(redacted);
        return;
      }
      
      // Normal mode: full compaction
      const compacted = processToolOutput(derivedToolName, rawText);
      resolve(compacted);
    });
    
    child.on('error', (err) => {
      reject(err);
    });
  });
}

/**
 * Runtime check: Scan skill file for direct child_process usage
 * Warns if skill bypasses exec_compacted.js
 */
function checkForDirectExec(skillPath) {
  const content = fs.readFileSync(skillPath, 'utf8');
  const lines = content.split('\n');
  const warnings = [];
  
  // Check for direct child_process import
  const hasDirectImport = /require\s*\(\s*['"](node:)?child_process['"]\s*\)/.test(content);
  
  // Check for exec/execSync/execFile usage
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Skip comments
    if (line.trim().startsWith('//') || line.trim().startsWith('*')) continue;
    
    if (/\b(exec|execSync|execFile)\s*\(/.test(line)) {
      // Check if it's using our wrapper
      if (!line.includes('execCompacted') && !line.includes('execFileCompacted')) {
        warnings.push({ line: i + 1, code: line.trim() });
      }
    }
  }
  
  return { hasDirectImport, warnings };
}

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length < 1) {
    console.error('Usage: node skill_runner.js /path/to/skill.js [args...]');
    console.error('');
    console.error('This wrapper verifies skill integrity before execution.');
    console.error('To approve a skill: node trust_add.js /path/to/skill.js "approval note"');
    console.error('');
    console.error('Environment variables:');
    console.error('  RAW_OK=true  - Skip compaction, redact only (debug mode)');
    process.exit(1);
  }
  
  const skillPath = args[0];
  const skillArgs = args.slice(1);
  
  // Verify skill before execution
  try {
    const result = verifySkillOrThrow(skillPath);
    if (result.break_glass) {
      console.warn('⚠️  BREAK GLASS MODE ACTIVE');
    }
  } catch (err) {
    console.error('╔════════════════════════════════════════════════════════════╗');
    console.error('║           SKILL EXECUTION BLOCKED                          ║');
    console.error('╚════════════════════════════════════════════════════════════╝');
    console.error('');
    console.error(`Reason: ${err.message}`);
    console.error('');
    console.error('To approve this skill:');
    console.error(`  ${TRUST_ADD_CMD} ${skillPath} "approval note"`);
    console.error('');
    process.exit(1);
  }
  
  // Runtime warning: check for direct exec usage
  const { hasDirectImport, warnings } = checkForDirectExec(skillPath);
  if (hasDirectImport || warnings.length > 0) {
    console.warn('');
    console.warn('╔════════════════════════════════════════════════════════════╗');
    console.warn('║  ⚠️  DIRECT EXEC USAGE DETECTED                             ║');
    console.warn('╚════════════════════════════════════════════════════════════╝');
    console.warn('');
    console.warn('This skill may be bypassing the exec_compacted.js wrapper.');
    console.warn('Output will be compacted, but subprocess calls may leak secrets.');
    console.warn('');
    if (hasDirectImport) {
      console.warn('  • Direct child_process import found');
    }
    for (const w of warnings) {
      console.warn(`  • Line ${w.line}: ${w.code.substring(0, 50)}${w.code.length > 50 ? '...' : ''}`);
    }
    console.warn('');
    console.warn('Recommended fix: Use execCompacted() from client/runtime/lib/exec_compacted.ts');
    console.warn('');
  }
  
  // Skill verified - execute with compaction
  console.error(`✅ Skill verified: ${skillPath}`);
  
  // NEW: Tiered Directives enforcement
  const skillName = path.basename(skillPath, '.js');
  const actionHint = skillArgs.length > 0 ? skillArgs[0] : 'run';
  const toolName = `skill:${skillName}/${actionHint}`;
  
  // Create action envelope for governance check
  const actionEnvelope = autoClassifyAndCreate({
    toolName: toolName,
    commandText: `${skillPath} ${skillArgs.join(' ')}`,
    payload: { skillPath, skillArgs },
    summary: `Execute skill: ${skillName}`
  });
  
  // Validate against active directives
  const validation = validateAction(actionEnvelope);
  
  if (!validation.allowed) {
    // Action blocked by invariant
    const blockedMsg = formatBlockedResponse(validation);
    console.log(blockedMsg);
    process.exit(1);
  }
  
  if (validation.requires_approval) {
    // Check if previously approved
    if (!wasApproved(actionEnvelope.action_id)) {
      // Queue for approval
      const queueResult = queueForApproval(actionEnvelope, validation.approval_reason);
      const approvalMsg = formatApprovalRequiredResponse(queueResult);
      console.log(approvalMsg);
      process.exit(0);  // Not an error, just needs approval
    }
    // Otherwise, proceed (was previously approved)
    console.error(`✅ Previously approved: ${actionEnvelope.action_id}`);
  }
  
  // Proceed with execution
  try {
    const output = await runSkillWithCompaction(skillPath, skillArgs, toolName);
    // Print output to stdout (goes to working context)
    console.log(output);
  } catch (err) {
    console.error('❌ Skill execution failed:', err.message);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { main, runSkillWithCompaction, asText, isAlreadyCompacted };
