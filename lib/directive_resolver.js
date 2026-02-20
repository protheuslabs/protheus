#!/usr/bin/env node
/**
 * directive_resolver.js - Tiered Directive Resolver
 * 
 * Loads YAML directives, merges constraints by tier, and validates actions.
 * Enforces: Lower-tier constraints override higher-tier directives.
 */

const fs = require('fs');
const path = require('path');
const { requiresApprovalByDefault, detectIrreversible, RISK_LEVELS } = require('./action_envelope.js');

const DIRECTIVES_DIR = path.join(__dirname, '..', 'config', 'directives');
const ACTIVE_FILE = path.join(DIRECTIVES_DIR, 'ACTIVE.yaml');
const TIMEBOUND_PATTERN = /\b(timeframe|deadline|target[_-]?date|review[_-]?by|horizon|months?|years?|quarter|by\s+\d{4}-\d{2}-\d{2})\b/i;

function escapeRegex(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function lineIndent(line) {
  const m = String(line || '').match(/^(\s*)/);
  return m ? m[1].length : 0;
}

function findHeadingIndex(lines, heading, start = 0) {
  const re = new RegExp(`^\\s*${escapeRegex(heading)}:\\s*$`);
  for (let i = Math.max(0, start); i < lines.length; i++) {
    if (re.test(lines[i])) return i;
  }
  return -1;
}

function extractSectionLines(lines, heading, start = 0) {
  const idx = findHeadingIndex(lines, heading, start);
  if (idx < 0) return null;
  const base = lineIndent(lines[idx]);
  const section = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const raw = lines[i];
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      section.push(raw);
      continue;
    }
    if (lineIndent(raw) <= base) break;
    section.push(raw);
  }
  return section;
}

function sectionHasScalar(sectionLines, key) {
  if (!Array.isArray(sectionLines)) return false;
  const re = new RegExp(`^\\s*${escapeRegex(key)}:\\s*(.+?)\\s*$`);
  for (const raw of sectionLines) {
    const m = String(raw || '').match(re);
    if (!m) continue;
    const v = String(m[1] || '').trim();
    if (v && v !== 'null' && v !== '[]' && v !== '{}') return true;
  }
  return false;
}

function sectionHasNestedList(sectionLines, key) {
  if (!Array.isArray(sectionLines)) return false;
  const idx = findHeadingIndex(sectionLines, key, 0);
  if (idx < 0) return false;
  const base = lineIndent(sectionLines[idx]);
  for (let i = idx + 1; i < sectionLines.length; i++) {
    const raw = sectionLines[i];
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ind = lineIndent(raw);
    if (ind <= base) break;
    if (/^\s*-\s+\S+/.test(raw)) return true;
  }
  return false;
}

function sectionHasNestedKeyValue(sectionLines, key) {
  if (!Array.isArray(sectionLines)) return false;
  const idx = findHeadingIndex(sectionLines, key, 0);
  if (idx < 0) return false;
  const base = lineIndent(sectionLines[idx]);
  for (let i = idx + 1; i < sectionLines.length; i++) {
    const raw = sectionLines[i];
    const trimmed = String(raw || '').trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const ind = lineIndent(raw);
    if (ind <= base) break;
    if (/^\s*[a-zA-Z0-9_.-]+\s*:\s*.+$/.test(raw) && !/^\s*-\s+/.test(raw)) return true;
  }
  return false;
}

function validateTier1DirectiveQuality(content, directiveId = 'unknown') {
  const text = String(content || '');
  const lines = text.split('\n');
  const missing = [];
  const questions = [];

  const intent = extractSectionLines(lines, 'intent');
  const constraints = extractSectionLines(lines, 'constraints');
  const success = extractSectionLines(lines, 'success_metrics');
  const scope = extractSectionLines(lines, 'scope');
  const approval = extractSectionLines(lines, 'approval_policy');

  if (!sectionHasScalar(intent, 'primary')) {
    missing.push('intent.primary');
    questions.push('What is the single specific objective (intent.primary)?');
  }
  if (!sectionHasNestedKeyValue(intent, 'definitions') && !TIMEBOUND_PATTERN.test(text)) {
    missing.push('intent.definitions_timebound');
    questions.push('What explicit time-bound target or review horizon applies?');
  } else if (!TIMEBOUND_PATTERN.test(text)) {
    missing.push('intent.timebound_signal');
    questions.push('Add a concrete time-bound signal (deadline/timeframe/review date).');
  }

  if (!sectionHasNestedList(scope, 'included')) {
    missing.push('scope.included');
    questions.push('What is explicitly in scope for this directive?');
  }
  if (!sectionHasNestedList(scope, 'excluded')) {
    missing.push('scope.excluded');
    questions.push('What is explicitly out of scope for this directive?');
  }

  if (!sectionHasNestedKeyValue(constraints, 'risk_limits')) {
    missing.push('constraints.risk_limits');
    questions.push('What quantitative risk limits apply (drawdown, burn, position size)?');
  }

  if (!sectionHasNestedList(success, 'leading')) {
    missing.push('success_metrics.leading');
    questions.push('Which leading indicators will be used to measure progress?');
  }
  if (!sectionHasNestedList(success, 'lagging')) {
    missing.push('success_metrics.lagging');
    questions.push('Which lagging metrics define end-state success?');
  }

  if (!sectionHasNestedList(approval, 'additional_gates')) {
    missing.push('approval_policy.additional_gates');
    questions.push('Which additional approval gates are required for Tier 1 actions?');
  }

  return {
    ok: missing.length === 0,
    directive_id: directiveId,
    missing,
    questions
  };
}

/**
 * Parse YAML - simplified but handles arrays and nested objects
 */
function parseYaml(text) {
  const lines = text.split('\n');
  let pos = 0;
  
  function skipEmptyAndComments() {
    while (pos < lines.length) {
      const line = lines[pos].trim();
      if (line && !line.startsWith('#')) return;
      pos++;
    }
  }
  
  function getIndent(line) {
    const match = line.match(/^(\s*)/);
    return match ? match[1].length : 0;
  }
  
  function parseValueAtIndent(baseIndent) {
    skipEmptyAndComments();
    if (pos >= lines.length) return null;
    
    const currentLine = lines[pos];
    const indent = getIndent(currentLine);
    const trimmed = currentLine.trim();
    
    if (indent < baseIndent) return null;
    
    // List item
    if (trimmed.startsWith('- ')) {
      const rest = trimmed.substring(2).trim();
      pos++;
      
      if (rest.includes(':')) {
        // Object in list - parse as object
        const colonIdx = rest.indexOf(':');
        const key = rest.substring(0, colonIdx).trim();
        const val = rest.substring(colonIdx + 1).trim();
        
        const obj = {};
        obj[key] = parseScalar(val);
        
        // Parse nested items at higher indent
        while (pos < lines.length) {
          const nextLine = lines[pos];
          if (!nextLine.trim() || nextLine.trim().startsWith('#')) {
            pos++;
            continue;
          }
          
          const nextIndent = getIndent(nextLine);
          if (nextIndent <= baseIndent) break;
          
          // This is a nested key of the current object
          const nextTrimmed = nextLine.trim();
          if (nextTrimmed.includes(':')) {
            const nc = nextTrimmed.indexOf(':');
            const k = nextTrimmed.substring(0, nc).trim();
            const v = nextTrimmed.substring(nc + 1).trim();
            obj[k] = parseScalar(v);
            pos++;
          } else {
            pos++;
          }
        }
        
        return obj;
      } else {
        return parseScalar(rest);
      }
    }
    
    // Key: value pair
    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.substring(0, colonIdx).trim();
      const val = trimmed.substring(colonIdx + 1).trim();
      pos++;
      
      if (!val) {
        // Nested structure - determine if array or object
        const nextItems = [];
        while (pos < lines.length) {
          const nextLine = lines[pos];
          if (!nextLine.trim() || nextLine.trim().startsWith('#')) {
            pos++;
            continue;
          }
          
          const nextIndent = getIndent(nextLine);
          if (nextIndent <= baseIndent) break;
          
          const nextTrimmed = nextLine.trim();
          
          if (nextTrimmed.startsWith('- ')) {
            // It's an array
            const arr = [];
            while (pos < lines.length) {
              const itemLine = lines[pos];
              if (!itemLine.trim() || itemLine.trim().startsWith('#')) {
                pos++;
                continue;
              }
              const itemIndent = getIndent(itemLine);
              if (itemIndent <= baseIndent) break;
              
              const itemTrimmed = itemLine.trim();
              if (itemTrimmed.startsWith('- ')) {
                const item = parseValueAtIndent(itemIndent);
                if (item !== null) arr.push(item);
              } else {
                break;
              }
            }
            return arr;
          } else if (nextTrimmed.includes(':')) {
            // It's an object
            const obj = {};
            while (pos < lines.length) {
              const objLine = lines[pos];
              if (!objLine.trim() || objLine.trim().startsWith('#')) {
                pos++;
                continue;
              }
              const objIndent = getIndent(objLine);
              if (objIndent <= baseIndent) break;
              
              const objTrimmed = objLine.trim();
              if (objTrimmed.includes(':')) {
                const oc = objTrimmed.indexOf(':');
                const k = objTrimmed.substring(0, oc).trim();
                const v = objTrimmed.substring(oc + 1).trim();
                obj[k] = parseScalar(v);
                pos++;
              } else {
                break;
              }
            }
            return obj;
          } else {
            pos++;
          }
        }
        return nextItems.length > 0 ? nextItems : {};
      } else {
        return { [key]: parseScalar(val) };
      }
    }
    
    pos++;
    return parseScalar(trimmed);
  }
  
  function parseScalar(val) {
    if (!val) return null;
    val = val.trim();
    if (val === 'true') return true;
    if (val === 'false') return false;
    if (val === 'null' || val === '~') return null;
    if (/^-?\d+$/.test(val)) return parseInt(val, 10);
    if (/^-?\d+\.\d+$/.test(val)) return parseFloat(val);
    if (/^"(.*)"$/.test(val)) return val.slice(1, -1);
    if (/^'(.*)'$/.test(val)) return val.slice(1, -1);
    return val;
  }
  
  // Parse top-level document
  const result = {};
  while (pos < lines.length) {
    skipEmptyAndComments();
    if (pos >= lines.length) break;
    
    const line = lines[pos];
    const trimmed = line.trim();
    
    if (trimmed.includes(':')) {
      const colonIdx = trimmed.indexOf(':');
      const key = trimmed.substring(0, colonIdx).trim();
      const val = trimmed.substring(colonIdx + 1).trim();
      pos++;
      
      if (!val) {
        // Nested structure
        const baseIndent = getIndent(line);
        skipEmptyAndComments();
        if (pos < lines.length) {
          const nextLine = lines[pos];
          const nextTrimmed = nextLine.trim();
          const nextIndent = getIndent(nextLine);
          
          if (nextTrimmed.startsWith('- ')) {
            // Array
            const arr = [];
            while (pos < lines.length) {
              const itemLine = lines[pos];
              if (!itemLine.trim() || itemLine.trim().startsWith('#')) {
                pos++;
                continue;
              }
              const itemIndent = getIndent(itemLine);
              if (itemIndent <= baseIndent) break;
              
              const itemTrimmed = itemLine.trim();
              if (itemTrimmed.startsWith('- ')) {
                const item = parseValueAtIndent(itemIndent);
                if (item !== null) arr.push(item);
              } else {
                break;
              }
            }
            result[key] = arr;
          } else if (nextTrimmed.includes(':')) {
            // Object
            const obj = {};
            while (pos < lines.length) {
              const objLine = lines[pos];
              if (!objLine.trim() || objLine.trim().startsWith('#')) {
                pos++;
                continue;
              }
              const objIndent = getIndent(objLine);
              if (objIndent <= baseIndent) break;
              
              const objTrimmed = objLine.trim();
              if (objTrimmed.includes(':')) {
                const oc = objTrimmed.indexOf(':');
                const k = objTrimmed.substring(0, oc).trim();
                const v = objTrimmed.substring(oc + 1).trim();
                obj[k] = parseScalar(v);
                pos++;
              } else {
                break;
              }
            }
            result[key] = obj;
          } else {
            result[key] = {};
          }
        } else {
          result[key] = {};
        }
      } else {
        result[key] = parseScalar(val);
      }
    } else {
      pos++;
    }
  }
  
  return result;
}

/**
 * Load active directives from ACTIVE.yaml
 * 
 * Options:
 *   - allowMissing: If true, skip missing files with warning instead of error.
 *     Default: false (throws hard error). Set env ALLOW_MISSING_DIRECTIVES=true to override.
 */
function loadActiveDirectives(options = {}) {
  // Allow env-based override for dev
  const forceAllowMissing = process.env.ALLOW_MISSING_DIRECTIVES === 'true';
  const forceAllowWeakTier1 = process.env.ALLOW_WEAK_T1_DIRECTIVES === 'true';
  const {
    allowMissing = forceAllowMissing || false,
    allowWeakTier1 = forceAllowWeakTier1 || false
  } = options;
  
  if (!fs.existsSync(ACTIVE_FILE)) {
    throw new Error(`ACTIVE.yaml not found at ${ACTIVE_FILE}`);
  }
  
  const content = fs.readFileSync(ACTIVE_FILE, 'utf8');
  const active = parseYaml(content);
  
  if (!active.active_directives || !Array.isArray(active.active_directives)) {
    throw new Error(`ACTIVE.yaml missing active_directives array. Got: ${JSON.stringify(active)}`);
  }
  
  const loaded = [];
  const missing = [];
  
  for (const entry of active.active_directives) {
    if (entry.status !== 'active') continue;
    
    const fileName = entry.id.endsWith('.yaml') ? entry.id : `${entry.id}.yaml`;
    const filePath = path.join(DIRECTIVES_DIR, fileName);
    
    if (!fs.existsSync(filePath)) {
      if (allowMissing) {
        // Warn and skip missing files in dev mode
        console.warn(`[DIRECTIVE WARNING] Missing file: ${filePath} (skipped due to ALLOW_MISSING_DIRECTIVES=true)`);
        continue;
      }
      missing.push({ id: entry.id, file: fileName, path: filePath });
      continue;
    }
    
    const directiveContent = fs.readFileSync(filePath, 'utf8');
    const entryTier = Number(entry.tier);
    if (entryTier === 1) {
      const quality = validateTier1DirectiveQuality(directiveContent, entry.id);
      if (!quality.ok) {
        if (allowWeakTier1) {
          console.warn(
            `[DIRECTIVE WARNING] Weak Tier 1 directive '${entry.id}' loaded with missing fields: ${quality.missing.join(', ')}`
          );
        } else {
          throw new Error(
            `Tier 1 directive '${entry.id}' is missing required strategic fields:\n` +
            quality.missing.map((m) => `  - ${m}`).join('\n') +
            `\n\nRequired clarification prompts:\n` +
            quality.questions.map((q) => `  - ${q}`).join('\n') +
            `\n\nThis gate enforces SMART-lite specificity for strategic directives.`
          );
        }
      }
    }
    const directive = parseYaml(directiveContent);
    
    loaded.push({
      id: entry.id,
      tier: entry.tier || directive.metadata?.tier || 99,
      status: entry.status,
      data: directive
    });
  }
  
  // If any files were missing and allowMissing is false, throw hard error
  if (missing.length > 0 && !allowMissing) {
    const details = missing.map(m => `  - ${m.id} (expected: ${m.file})`).join('\n');
    throw new Error(
      `Missing directive files referenced in ACTIVE.yaml:\n${details}\n\n` +
      `To create placeholder files: touch ${missing.map(m => m.path).join(' ')}\n` +
      `To skip missing files (dev mode): ALLOW_MISSING_DIRECTIVES=true node script.js`
    );
  }
  
  // Sort by tier (lower = higher precedence)
  loaded.sort((a, b) => a.tier - b.tier);
  
  return loaded;
}

/**
 * Merge constraints from all active directives (T0 first, then T1, etc.)
 */
function mergeConstraints(directives) {
  const merged = {
    tier: 0,
    hard_blocks: [],
    approval_required: [],
    risk_limits: {},
    high_stakes_domains: new Set()
  };
  
  for (const directive of directives) {
    const data = directive.data;
    
    // Direct hard_blocks array
    if (data.hard_blocks && Array.isArray(data.hard_blocks)) {
      for (const block of data.hard_blocks) {
        if (typeof block === 'object' && block.rule) {
          merged.hard_blocks.push({
            rule: block.rule,
            description: block.description || block.rule,
            tier: block.tier || directive.tier,
            patterns: block.patterns || []
          });
        }
      }
    }
    
    // Direct approval_required array
    if (data.approval_required && Array.isArray(data.approval_required)) {
      for (const rule of data.approval_required) {
        if (typeof rule === 'object' && rule.rule) {
          merged.approval_required.push({
            rule: rule.rule,
            description: rule.description || rule.rule,
            tier: rule.tier || directive.tier,
            examples: rule.examples || []
          });
        }
      }
    }
    
    // High-stakes domains array
    if (data.high_stakes_domains && Array.isArray(data.high_stakes_domains)) {
      for (const item of data.high_stakes_domains) {
        if (typeof item === 'object' && item.domain && item.escalation_required) {
          merged.high_stakes_domains.add(item.domain);
        }
      }
    }
    
    // Nested directives (for T1+ files)
    if (data.directives && Array.isArray(data.directives)) {
      for (const dir of data.directives) {
        if (dir?.constraints?.max_drawdown_pct) {
          merged.risk_limits[dir.id] = dir.constraints;
        }
      }
    }
  }
  
  return merged;
}

/**
 * Validate an action against merged constraints
 */
function validateAction(actionEnvelope) {
  const directives = loadActiveDirectives();
  const constraints = mergeConstraints(directives);
  
  const result = {
    allowed: true,
    requires_approval: false,
    blocked_reason: null,
    effective_constraints: constraints,
    action_id: actionEnvelope.action_id,
    tier: actionEnvelope.tier || 2
  };
  
  // Check T0 hard blocks
  for (const block of constraints.hard_blocks) {
    const check = checkHardBlock(block, actionEnvelope);
    if (check.violated) {
      result.allowed = false;
      result.blocked_reason = `T${block.tier} INVARIANT VIOLATION: ${block.description}. ${check.details}`;
      return result;
    }
  }
  
  // Check approval requirements
  const approvalCheck = checkApprovalRequired(constraints, actionEnvelope);
  if (approvalCheck.required) {
    result.requires_approval = true;
    result.blocked_reason = null;  // Not blocked, just needs approval
    result.approval_reason = approvalCheck.reason;
  }
  
  // Check for irreversible actions
  if (actionEnvelope.metadata?.command_text) {
    const irreversible = detectIrreversible(actionEnvelope.metadata.command_text);
    if (irreversible.is_irreversible && !result.requires_approval) {
      result.requires_approval = true;
      result.approval_reason = `Irreversible action detected: ${irreversible.pattern}`;
    }
  }
  
  // Auto-approval for known high-stakes types
  if (requiresApprovalByDefault(actionEnvelope.type) && !result.requires_approval) {
    result.requires_approval = true;
    result.approval_reason = `Action type '${actionEnvelope.type}' requires approval per T0 invariants`;
  }
  
  // High-risk auto-escalation
  if (actionEnvelope.risk === RISK_LEVELS.HIGH && actionEnvelope.tier < 2) {
    result.requires_approval = true;
    result.approval_reason = 'High-risk action at Tier < 2 requires approval';
  }
  
  return result;
}

/**
 * Check if action violates a hard block
 */
function checkHardBlock(block, action) {
  // Check for secret exposure in payload
  if (block.rule === 'secret_redaction') {
    const payloadStr = JSON.stringify(action.payload || {});
    if (/moltbook_sk_[a-zA-Z0-9]{20,}/.test(payloadStr)) {
      return {
        violated: true,
        details: 'Unredacted secret token detected in payload'
      };
    }
    if (/Authorization:\s*Bearer\s+[a-zA-Z0-9]{20,}/i.test(payloadStr)) {
      return {
        violated: true,
        details: 'Unredacted authorization header detected in payload'
      };
    }
  }
  
  return { violated: false };
}

/**
 * Check if action requires approval
 */
function checkApprovalRequired(constraints, action) {
  // Check against approval-required rules
  for (const rule of constraints.approval_required) {
    if (rule.examples && rule.examples.length > 0) {
      const actionText = `${action.type} ${action.summary || ''}`.toLowerCase();
      for (const example of rule.examples) {
        if (typeof example === 'string' && actionText.includes(example.toLowerCase())) {
          return {
            required: true,
            reason: `${rule.description} (matched: ${example})`
          };
        }
      }
    }
  }
  
  // Check high-stakes domains
  if (constraints.high_stakes_domains.size > 0) {
    const actionText = `${action.type} ${action.summary || ''}`.toLowerCase();
    for (const domain of constraints.high_stakes_domains) {
      if (actionText.includes(domain.toLowerCase())) {
        return {
          required: true,
          reason: `High-stakes domain '${domain}' requires approval`
        };
      }
    }
  }
  
  return { required: false };
}

/**
 * Check for tier override conflict
 */
function checkTierConflict(lowerTierAction, higherTierDirective) {
  if (lowerTierAction.tier > higherTierDirective.tier) {
    return {
      is_conflict: true,
      reason: `Tier ${lowerTierAction.tier} action attempted to override Tier ${higherTierDirective.tier} directive`,
      resolution: 'Lower tier wins'
    };
  }
  
  return { is_conflict: false };
}

module.exports = {
  loadActiveDirectives,
  mergeConstraints,
  validateAction,
  checkTierConflict,
  parseYaml,
  DIRECTIVES_DIR,
  validateTier1DirectiveQuality
};
