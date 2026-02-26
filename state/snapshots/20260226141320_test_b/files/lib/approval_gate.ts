#!/usr/bin/env node
/**
 * approval_gate.js - Approval Queue and Gate System
 * 
 * Manages pending approvals and gates actions that require authorization.
 * 
 * Strict YAML Format (round-trip safe):
 *   pending:
 *     - action_id: "act_xxx"
 *       timestamp: "2026-..."
 *       type: "publish_publicly"
 *       summary: "..."
 *       reason: "..."
 *       status: "PENDING"
 */

const fs = require('fs');
const path = require('path');

const QUEUE_FILE = path.join(__dirname, '..', 'state', 'approvals_queue.yaml');

/**
 * Load approval queue
 * Parses strict YAML list format
 */
function loadQueue() {
  if (!fs.existsSync(QUEUE_FILE)) {
    return { pending: [], approved: [], denied: [], history: [] };
  }
  
  const content = fs.readFileSync(QUEUE_FILE, 'utf8');
  return parseQueueYaml(content);
}

/**
 * Parse queue YAML with strict format
 * - Sections: pending, approved, denied, history
 * - Each section contains a list of entries
 * - Entries are indented 2 spaces under section
 * - Keys are indented 4 spaces under section
 */
function parseQueueYaml(content) {
  const queue = { pending: [], approved: [], denied: [], history: [] };
  const lines = content.split('\n');
  
  let currentSection = null;
  let currentEntry = null;
  let sectionBaseIndent = -1;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    const indent = line.search(/\S/);
    
    // Skip comments and empty lines
    if (!trimmed || trimmed.startsWith('#')) continue;
    
    // Section headers (top-level keys ending with ':', possibly with value like '[]')
    // Matches: "pending:", "pending: []", etc.
    if (trimmed.includes(':') && indent === 0) {
      const colonIdx = trimmed.indexOf(':');
      const section = trimmed.substring(0, colonIdx).trim();
      const rest = trimmed.substring(colonIdx + 1).trim();
      
      if (queue.hasOwnProperty(section)) {
        currentSection = section;
        sectionBaseIndent = 0;
        currentEntry = null;
        
        // Handle empty array marker: section: []
        if (rest === '[]') {
          // Section is already empty array from init, nothing to do
        }
        continue;
      }
    }
    
    // List items under a section (must be indented more than section)
    // Format: "  -" or "  - action_id: ..."
    if (currentSection && trimmed.startsWith('-')) {
      const itemIndent = indent;
      const rest = trimmed.substring(1).trim(); // Remove leading '-'
      
      // Create new entry
      currentEntry = {};
      queue[currentSection].push(currentEntry);
      
      // If there's content after '-', it's an inline key: value
      if (rest && rest.includes(':')) {
        const colonIdx = rest.indexOf(':');
        const key = rest.substring(0, colonIdx).trim();
        const val = rest.substring(colonIdx + 1).trim();
        currentEntry[key] = parseValue(val);
      }
      continue;
    }
    
    // Key-value pairs within current entry
    // Must be indented more than the list item (typically 4 spaces)
    if (currentEntry && trimmed.includes(':') && indent > 2) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.substring(0, colonIdx).trim();
      const val = trimmed.substring(colonIdx + 1).trim();
      currentEntry[key] = parseValue(val);
      continue;
    }
  }
  
  return queue;
}

/**
 * Parse a YAML value (handle strings, numbers, booleans)
 */
function parseValue(val) {
  if (!val) return null;
  val = val.trim();
  
  // String with quotes
  if ((val.startsWith('"') && val.endsWith('"')) || 
      (val.startsWith("'") && val.endsWith("'"))) {
    return val.slice(1, -1);
  }
  
  // Boolean
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null' || val === '~') return null;
  
  // Number
  if (/^-?\d+$/.test(val)) return parseInt(val, 10);
  if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
  
  // Unquoted string
  return val;
}

/**
 * Save approval queue with strict format
 * Ensures round-trip safety
 */
function saveQueue(queue) {
  const lines = ['# Approval Queue', `# Updated: ${new Date().toISOString()}`, ''];
  
  for (const [section, sectionEntries] of Object.entries(queue || {})) {
    const entries = Array.isArray(sectionEntries) ? sectionEntries : [];
    if (entries.length === 0) {
      // Empty section: use explicit [] for clarity and round-trip safety
      lines.push(`${section}: []`);
    } else {
      lines.push(`${section}:`);
      for (const entry of entries) {
        // First field on same line as dash
        const keys = Object.keys(entry);
        if (keys.length > 0) {
          const firstKey = keys[0];
          const firstVal = formatValue(entry[firstKey]);
          lines.push(`  - ${firstKey}: ${firstVal}`);
          
          // Remaining fields indented
          for (let i = 1; i < keys.length; i++) {
            const k = keys[i];
            const v = formatValue(entry[k]);
            lines.push(`    ${k}: ${v}`);
          }
        } else {
          lines.push('  -');
        }
      }
    }
    lines.push('');
  }
  
  fs.writeFileSync(QUEUE_FILE, lines.join('\n'), 'utf8');
}

/**
 * Format a value for YAML output
 */
function formatValue(val) {
  if (val === null || val === undefined) return 'null';
  if (typeof val === 'boolean') return val ? 'true' : 'false';
  if (typeof val === 'number') return String(val);
  if (typeof val === 'string') {
    // Quote if contains special characters
    if (/[":{}\[\]\n]/.test(val) || val === '') {
      return JSON.stringify(val);
    }
    return val;
  }
  return JSON.stringify(val);
}

/**
 * Add action to approval queue
 */
function queueForApproval(actionEnvelope, reason) {
  const queue = loadQueue();
  
  const entry = {
    action_id: actionEnvelope.action_id,
    timestamp: new Date().toISOString(),
    directive_id: actionEnvelope.directive_id || 'T0_invariants',
    type: actionEnvelope.type,
    summary: actionEnvelope.summary,
    reason: reason,
    status: 'PENDING',
    payload_pointer: actionEnvelope.action_id
  };
  
  queue.pending.push(entry);
  saveQueue(queue);
  
  return {
    action_id: entry.action_id,
    status: 'PENDING',
    message: generateApprovalMessage(entry)
  };
}

/**
 * Generate approval message for user
 */
function generateApprovalMessage(entry) {
  return `Action: ${entry.summary}
Type: ${entry.type}
Directive: ${entry.directive_id}
Why gated: ${entry.reason}
Action ID: ${entry.action_id}

To approve, reply: APPROVE ${entry.action_id}
To deny, reply: DENY ${entry.action_id}`;
}

/**
 * Approve an action
 */
function approveAction(actionId) {
  const queue = loadQueue();
  
  const idx = queue.pending.findIndex(e => e.action_id === actionId);
  if (idx === -1) {
    return { success: false, error: `Action ${actionId} not found in pending queue` };
  }
  
  const entry = queue.pending[idx];
  entry.status = 'APPROVED';
  entry.approved_at = new Date().toISOString();
  
  queue.pending.splice(idx, 1);
  queue.approved.push(entry);
  queue.history.push({ ...entry, action: 'approved', history_at: new Date().toISOString() });
  
  saveQueue(queue);
  
  return {
    success: true,
    action_id: actionId,
    message: `APPROVED: ${entry.summary}. You can now re-run this action.`
  };
}

/**
 * Deny an action
 */
function denyAction(actionId, reason = 'User denied') {
  const queue = loadQueue();
  
  const idx = queue.pending.findIndex(e => e.action_id === actionId);
  if (idx === -1) {
    return { success: false, error: `Action ${actionId} not found in pending queue` };
  }
  
  const entry = queue.pending[idx];
  entry.status = 'DENIED';
  entry.denied_at = new Date().toISOString();
  entry.deny_reason = reason;
  
  queue.pending.splice(idx, 1);
  queue.denied.push(entry);
  queue.history.push({ ...entry, action: 'denied', history_at: new Date().toISOString() });
  
  saveQueue(queue);
  
  return {
    success: true,
    action_id: actionId,
    message: `DENIED: ${entry.summary}`
  };
}

/**
 * Check if action was previously approved
 */
function wasApproved(actionId) {
  const queue = loadQueue();
  return queue.approved.some(e => e.action_id === actionId);
}

/**
 * Format compact response for blocked action
 */
function formatBlockedResponse(validationResult) {
  return `📦 [ACTION BLOCKED]

• Reason: ${validationResult.blocked_reason}
• Tier: ${validationResult.effective_constraints?.tier || 0}
• Action ID: ${validationResult.action_id}

This action violates invariant constraints and cannot proceed.`;
}

/**
 * Format compact response for approval-required action
 */
function formatApprovalRequiredResponse(queueResult) {
  return `📦 [APPROVAL REQUIRED]

${queueResult.message}

Reply: APPROVE ${queueResult.action_id}`;
}

/**
 * Parse approval command from user input
 */
function parseApprovalCommand(text) {
  const approveMatch = text.match(/^APPROVE\s+(\S+)$/i);
  if (approveMatch) {
    return { action: 'approve', action_id: approveMatch[1] };
  }
  
  const denyMatch = text.match(/^DENY\s+(\S+)$/i);
  if (denyMatch) {
    return { action: 'deny', action_id: denyMatch[1] };
  }
  
  return null;
}

module.exports = {
  queueForApproval,
  approveAction,
  denyAction,
  wasApproved,
  loadQueue,
  saveQueue,
  parseQueueYaml,
  formatBlockedResponse,
  formatApprovalRequiredResponse,
  parseApprovalCommand,
  generateApprovalMessage
};
export {};
