const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const memoryDir = process.env.MEMORY_DIR || '/Users/jay/.openclaw/workspace/memory';
const whitelistRegex = /^\d{4}-\d{2}-\d{2}\.md$/;
const UID_PATTERN = /^[A-Za-z0-9]+$/;
const UID_ENFORCE_SINCE = normalizeDate(process.env.MEMORY_UID_ENFORCE_SINCE || '2026-02-22');

const TOKEN_CAPS = {
  default: 200,
  controlPlane: 200,
  metrics: 250
};

const CONTROL_PLANE_NODES = ['project-registry', 'mode-restrictions', 'query-mode-toggle', 'bloat-safeguards', 'test-noise-quarantine', 'bridge-templates', 'graph-bridge-policy', 'creative-mode-spec', 'node-format-policy', 'snippet-index-policy', 'tagging-policy', 'topic-registry', 'pin-policy', 'hyper-creative-mode-spec', 'capture-policy', 'agent-portability-spec'];

// Snippet scanning configuration
const SNIPPET_WINDOW = 8;
const EXCLUDE_PATHS = ['node_modules', 'dist', 'build', '.git', '.next', 'out', 'coverage'];
const INCLUDE_EXTENSIONS = ['.md', '.txt', '.js', '.ts', '.json', '.yaml', '.yml', '.sh', '.py', '.rb', '.go', '.rs', '.c', '.cpp', '.h', '.java', '.kt', '.swift', '.php', '.pl', '.r', '.scala', '.groovy', '.clj', '.erl', '.ex', '.exs', '.lua', '.vim', '.el', '.lisp', '.scm', '.hs', '.ml', '.sql', '.css', '.scss', '.less', '.html', '.xml', '.toml', '.ini', '.cfg', '.conf', '.dockerfile', '.tf', '.hcl'];
const WORKSPACE_ROOT = '/Users/jay/.openclaw/workspace';
const DELTA_CACHE_PATH = path.join(memoryDir, '.rebuild_delta_cache.json');

function sha1Text(content) {
  return crypto.createHash('sha1').update(String(content || '')).digest('hex');
}

function normalizeDate(v) {
  const s = String(v || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '2026-02-22';
}

function requiresUid(nodeDate) {
  const d = normalizeDate(nodeDate);
  return d >= UID_ENFORCE_SINCE;
}

function loadDeltaCache() {
  try {
    if (!fs.existsSync(DELTA_CACHE_PATH)) return { version: 1, files: {} };
    const parsed = JSON.parse(fs.readFileSync(DELTA_CACHE_PATH, 'utf8'));
    if (!parsed || typeof parsed !== 'object') return { version: 1, files: {} };
    if (!parsed.files || typeof parsed.files !== 'object') parsed.files = {};
    return parsed;
  } catch {
    return { version: 1, files: {} };
  }
}

function saveDeltaCache(cache) {
  const payload = cache && typeof cache === 'object' ? cache : { version: 1, files: {} };
  payload.version = 1;
  payload.updated_at = new Date().toISOString();
  if (!payload.files || typeof payload.files !== 'object') payload.files = {};
  fs.writeFileSync(DELTA_CACHE_PATH, JSON.stringify(payload, null, 2));
}

function getProjectRegistryFromNodes() {
  const registry = { 'active-core': [], 'active-test': [], paused: [], retired: [] };
  const owners = {};
  let needsRewrite = false;
  let latestFile = null;

  const dailyFiles = fs.readdirSync(memoryDir)
    .filter(f => whitelistRegex.test(f))
    .sort();

  let latestRegistry = null;
  let latestDate = '';

  for (const file of dailyFiles) {
    const filePath = path.join(memoryDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const date = file.replace('.md', '');

    const registryNodePattern = /(---\s*\ndate:\s*\d{4}-\d{2}-\d{2}\s*\nnode_id:\s*project-registry\s*\ntags:[\s\S]*?---\s*\n#\s*project-registry\n)([\s\S]*?)(?=\s*<!-- NODE -->|---\s*\ndate:|\.{3}|$)/;
    const registryMatch = content.match(registryNodePattern);
    if (registryMatch) {
      if (date > latestDate) {
        latestDate = date;
        latestRegistry = registryMatch[2];
        latestFile = filePath;
      }
    }
  }

  if (!latestRegistry) {
    return { registry, owners, needsRewrite, latestFile };
  }

  if (/activeCore:|activeTest:/.test(latestRegistry)) {
    needsRewrite = true;
  }

  function parseListItems(content, hyphenatedKey, camelCaseKey) {
    const items = [];
    const patterns = [
      new RegExp(`${hyphenatedKey}:([\\s\\S]*?)(?=\\n(?:active-core:|active-test:|activeCore:|activeTest:|paused:|retired:|owners:|rules:|$))`),
      new RegExp(`${camelCaseKey}:([\\s\\S]*?)(?=\\n(?:active-core:|active-test:|activeCore:|activeTest:|paused:|retired:|owners:|rules:|$))`)
    ];

    for (const pattern of patterns) {
      const match = content.match(pattern);
      if (match) {
        const lines = match[1].split('\n');
        for (const line of lines) {
          const itemMatch = line.match(/^-\s*([a-zA-Z0-9_-]+)/);
          if (itemMatch && itemMatch[1].trim() && !itemMatch[1].includes('none')) {
            items.push(itemMatch[1].trim());
          }
        }
        break;
      }
    }
    return items;
  }

  registry['active-core'] = parseListItems(latestRegistry, 'active-core', 'activeCore');
  registry['active-test'] = parseListItems(latestRegistry, 'active-test', 'activeTest');

  const pausedMatch = latestRegistry.match(/paused:([\s\S]*?)(?=\n(?:active-core:|active-test:|activeCore:|activeTest:|retired:|owners:|rules:|$))/);
  if (pausedMatch) {
    const lines = pausedMatch[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s*([a-zA-Z0-9_-]+)/);
      if (match && match[1].trim() && !match[1].includes('none')) {
        registry.paused.push(match[1].trim());
      }
    }
  }

  const retiredMatch = latestRegistry.match(/retired:([\s\S]*?)(?=\n(?:active-core:|active-test:|activeCore:|activeTest:|paused:|owners:|rules:|$))/);
  if (retiredMatch) {
    const lines = retiredMatch[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s*([a-zA-Z0-9_-]+)/);
      if (match && match[1].trim() && !match[1].includes('none')) {
        registry.retired.push(match[1].trim());
      }
    }
  }

  const ownersMatch = latestRegistry.match(/owners:([\s\S]*?)(?=\n(?:rules:|$))/);
  if (ownersMatch) {
    const lines = ownersMatch[1].split('\n');
    for (const line of lines) {
      const match = line.match(/^-\s*([a-zA-Z0-9_-]+):\s*(.+)/);
      if (match) {
        owners[match[1].trim()] = match[2].trim();
      }
    }
  }

  return { registry, owners, needsRewrite, latestFile, date: latestDate };
}

// Snapshot backup function
function createSnapshotBackups() {
  const snapshotDir = path.join(memoryDir, '_snapshots');
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }

  const now = new Date();
  // America/Denver local time: YYYY-MM-DD-HHMM
  const options = { timeZone: 'America/Denver', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false };
  const formatter = new Intl.DateTimeFormat('en-US', options);
  const parts = formatter.formatToParts(now);
  const year = parts.find(p => p.type === 'year').value;
  const month = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  const hour = parts.find(p => p.type === 'hour').value;
  const minute = parts.find(p => p.type === 'minute').value;
  const timestamp = `${year}-${month}-${day}-${hour}${minute}`;

  const filesToBackup = ['MEMORY_INDEX.md', 'TAGS_INDEX.md', 'SNIPPET_INDEX.md'];
  const backedUp = [];

  for (const file of filesToBackup) {
    const sourcePath = path.join(memoryDir, file);
    if (fs.existsSync(sourcePath)) {
      const backupPath = path.join(snapshotDir, file.replace('.md', `-${timestamp}.md`));
      fs.copyFileSync(sourcePath, backupPath);
      backedUp.push(path.basename(backupPath));
    }
  }

  return backedUp;
}

// Scan for inline tag snippets in workspace files
function scanForSnippets() {
  const snippets = [];
  const tagCounts = new Map();

  const tagPatterns = [
    /<!--\s*TAGS:\s*(#[a-z0-9-]+(?:\s+#[a-z0-9-]+)*)\s*-->/i,
    /#\s*TAGS:\s*(#[a-z0-9-]+(?:\s+#[a-z0-9-]+)*)$/im,
    /\[TAGS:\s*(#[a-z0-9-]+(?:\s+#[a-z0-9-]+)*)\]/i
  ];

  function isExcluded(filePath) {
    return EXCLUDE_PATHS.some(ex => filePath.includes(ex));
  }

  function hasValidExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath);
    const hasDockerfile = base.toLowerCase().includes('dockerfile');
    return INCLUDE_EXTENSIONS.includes(ext) || hasDockerfile;
  }

  function scanDirectory(dir, baseDir = WORKSPACE_ROOT) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!isExcluded(fullPath)) {
          scanDirectory(fullPath, baseDir);
        }
      } else if (entry.isFile() && !isExcluded(fullPath) && hasValidExtension(fullPath)) {
        if (whitelistRegex.test(entry.name)) continue;

        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const relativePath = path.relative(baseDir, fullPath);

          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            let match = null;

            for (const pattern of tagPatterns) {
              match = line.match(pattern);
              if (match) break;
            }

            if (match) {
              const tagList = match[1].split(/\s+/).filter(t => t.startsWith('#'));
              
              const lineStart = Math.max(0, i - SNIPPET_WINDOW);
              const lineEnd = Math.min(lines.length - 1, i + SNIPPET_WINDOW);
              const previewLines = lines.slice(lineStart, lineEnd + 1);
              const preview = previewLines.join(' ').substring(0, 60).replace(/\s+/g, ' ');

              for (const tag of tagList) {
                const cleanTag = tag.toLowerCase();
                snippets.push({
                  tag: cleanTag,
                  file: relativePath,
                  line_start: lineStart + 1,
                  line_end: lineEnd + 1,
                  preview: preview
                });

                tagCounts.set(cleanTag, (tagCounts.get(cleanTag) || 0) + 1);
              }
            }
          }
        } catch (err) {
          // Skip files that can't be read as text
        }
      }
    }
  }

  scanDirectory(WORKSPACE_ROOT);
  return { snippets, tagCounts };
}

// Scan for @tag blocks in all workspace files
function scanForTaggedBlocks() {
  const taggedBlocks = [];
  const tagPattern = /@tags:\s*(#[a-z0-9-]+(?:\s+#[a-z0-9-]+)*)\s+@id:\s*(\S+)\s+@date:\s*(\d{4}-\d{2}-\d{2})\s+@scope:\s*(snippet|node|log|draft)/i;
  const topicTagPattern = /#topic-[a-z0-9-]+/g;

  function isExcluded(filePath) {
    return EXCLUDE_PATHS.some(ex => filePath.includes(ex));
  }

  function hasValidExtension(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath);
    const hasDockerfile = base.toLowerCase().includes('dockerfile');
    return INCLUDE_EXTENSIONS.includes(ext) || hasDockerfile;
  }

  function scanDirectory(dir, baseDir = WORKSPACE_ROOT) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        if (!isExcluded(fullPath)) {
          scanDirectory(fullPath, baseDir);
        }
      } else if (entry.isFile() && !isExcluded(fullPath) && hasValidExtension(fullPath)) {
        try {
          const content = fs.readFileSync(fullPath, 'utf8');
          const lines = content.split('\n');
          const relativePath = path.relative(baseDir, fullPath);

          for (let i = 0; i < lines.length; i++) {
            const match = lines[i].match(tagPattern);
            if (match) {
              const tags = match[1].split(/\s+/).filter(t => t.startsWith('#'));
              const id = match[2];
              const date = match[3];
              const scope = match[4].toLowerCase();
              const topicTags = tags.filter(t => t.startsWith('#topic-'));

              const lineStart = Math.max(0, i - 3);
              const lineEnd = Math.min(lines.length - 1, i + 3);

              taggedBlocks.push({
                tags,
                id,
                date,
                scope,
                topicTags,
                file: relativePath,
                line: i + 1,
                context: lines.slice(lineStart, lineEnd + 1).join('\n')
              });
            }
          }
        } catch (err) {
          // Skip files that can't be read
        }
      }
    }
  }

  scanDirectory(WORKSPACE_ROOT);

  const summary = {
    total: taggedBlocks.length,
    byScope: {},
    topicTags: new Set(),
    topicTagCount: 0
  };

  for (const block of taggedBlocks) {
    summary.byScope[block.scope] = (summary.byScope[block.scope] || 0) + 1;
    for (const tt of block.topicTags) {
      summary.topicTags.add(tt);
      summary.topicTagCount++;
    }
  }

  summary.topicTags = Array.from(summary.topicTags);
  return summary;
}

const { registry: projectRegistry, needsRewrite, latestFile } = getProjectRegistryFromNodes();

if (needsRewrite && latestFile) {
  console.log('CANONICALIZATION: Normalizing project-registry keys...');
  let content = fs.readFileSync(latestFile, 'utf8');
  content = content.replace(/activeCore:/g, 'active-core:');
  content = content.replace(/activeTest:/g, 'active-test:');
  fs.writeFileSync(latestFile, content);
}

// Create snapshots BEFORE writing new indices
console.log('╔════════════════════════════════════════════════════════════╗');
console.log('║              CREATING SNAPSHOT BACKUPS                     ║');
console.log('╚════════════════════════════════════════════════════════════╝');
const backedUpFiles = createSnapshotBackups();
console.log(`Backed up: ${backedUpFiles.join(', ') || 'none'}`);
console.log(`Snapshot location: client/memory/_snapshots/`);
console.log();

const allRegisteredProjects = [...projectRegistry['active-core'], ...projectRegistry.paused, ...projectRegistry.retired];
const dailyFiles = fs.readdirSync(memoryDir).filter(f => whitelistRegex.test(f)).sort();

console.log('Whitelisted daily files:', dailyFiles);

const allNodes = [];
const allTags = new Map();
const seenNodes = new Set();
const seenUids = new Set();
const formatViolations = [];
const bloatWarnings = [];
const registryWarnings = []; // NEW: For tag/registry mismatches

let projectsFromRegistry = 0;
let projectsFromTag = 0;
const registryForcedChanges = [];

function estimateTokens(text) {
  const wordCount = text.trim().split(/\s+/).length;
  return Math.round(wordCount / 0.75);
}

function getNodeCap(nodeId) {
  if (CONTROL_PLANE_NODES.includes(nodeId)) return TOKEN_CAPS.controlPlane;
  if (nodeId.includes('metrics') || nodeId.includes('weekly')) return TOKEN_CAPS.metrics;
  return TOKEN_CAPS.default;
}

function getBaselineCategory(node) {
  if (node.node_id === 'project-registry') return 'System';
  if (node.tags.includes('project')) return 'Projects';
  if (node.tags.includes('workflow') || node.tags.includes('comms') || node.tags.includes('calibration')) return 'Rules';
  if (node.tags.includes('architecture') || node.tags.includes('income') || node.tags.includes('platform') || node.tags.includes('concept')) return 'Concepts';
  if (node.tags.includes('system') || node.tags.includes('protocol') || node.tags.includes('capabilities') || node.tags.includes('registry')) return 'System';
  return 'Ops/Logs';
}

function validateNode(chunk, file, expectedDate) {
  const violations = [];
  let nodeId = '(undetectable)';
  let uid = null;

  const frontmatterMatch = chunk.match(/---\s*\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) {
    violations.push('missing frontmatter block');
    return { valid: false, nodeId, violations };
  }

  const fm = frontmatterMatch[1];

  const dateMatch = fm.match(/date:\s*(\d{4}-\d{2}-\d{2})/);
  const nodeDate = dateMatch ? dateMatch[1] : expectedDate;
  if (!dateMatch) {
    violations.push('missing date in frontmatter');
  } else if (dateMatch[1] !== expectedDate) {
    violations.push(`date mismatch: ${dateMatch[1]} != ${expectedDate}`);
  }

  const nodeIdMatch = fm.match(/node_id:\s*(\S+)/);
  if (!nodeIdMatch) {
    violations.push('missing node_id in frontmatter');
  } else {
    nodeId = nodeIdMatch[1];
  }

  const tagsMatch = fm.match(/tags:\s*\[([^\]]*)\]/);
  if (!tagsMatch) {
    violations.push('missing tags array in frontmatter');
  }

  const uidMatch = fm.match(/uid:\s*(\S+)/);
  if (!uidMatch) {
    if (requiresUid(nodeDate)) {
      violations.push(`missing uid in frontmatter (required since ${UID_ENFORCE_SINCE})`);
    }
  } else {
    uid = String(uidMatch[1] || '').trim();
    if (!UID_PATTERN.test(uid)) {
      violations.push(`uid not alphanumeric: ${uid}`);
    }
  }

  const h1Match = chunk.match(/\n#\s*(\S+)/);
  if (!h1Match) {
    violations.push('missing H1 title line');
  } else if (nodeIdMatch && h1Match[1] !== nodeIdMatch[1]) {
    violations.push(`H1 mismatch: "${h1Match[1]}" != "${nodeIdMatch[1]}"`);
  }

  return {
    valid: violations.length === 0,
    nodeId,
    uid,
    violations,
    date: dateMatch ? dateMatch[1] : null,
    tags: tagsMatch ? tagsMatch[1].split(',').map(t => t.trim()).filter(t => t) : [],
    body: chunk.replace(/---\s*\n[\s\S]*?\n---\s*\n#[^\n]+\n/, '').replace(/\s*<!--\s*NODE\s*-->\s*$/, '')
  };
}

function parseDailyFileRecords(file, content, expectedDate) {
  const records = [];
  const formatViolationsLocal = [];
  const chunks = String(content || '').split(/\s*<!--\s*NODE\s*-->\s*/).filter(c => c.trim());

  for (const chunk of chunks) {
    const trimmed = chunk.trim();
    if (!trimmed) continue;

    const validation = validateNode(trimmed, file, expectedDate);
    if (!validation.valid) {
      formatViolationsLocal.push({
        file,
        node_id: validation.nodeId,
        reasons: validation.violations.join(', ')
      });
      continue;
    }

    const { nodeId, uid, tags, body } = validation;
    const tokenEstimate = estimateTokens(trimmed);
    const firstBullet = body.match(/[-*]\s*(.+?)(?=\n|$)/);
    const firstLine = body.split('\n')[0];
    const summary = firstBullet ? firstBullet[1].trim().substring(0, 60)
      : firstLine ? firstLine.substring(0, 60)
        : 'Node content';

    records.push({
      node_id: nodeId,
      uid: uid || null,
      tags,
      file,
      date: expectedDate,
      token_estimate: tokenEstimate,
      summary
    });
  }

  return {
    records,
    format_violations: formatViolationsLocal
  };
}

// Parse files with delta cache (changed files only).
const priorDeltaCache = loadDeltaCache();
const nextDeltaCache = { version: 1, files: {} };
let deltaHits = 0;
let deltaMisses = 0;

for (const file of dailyFiles) {
  const filePath = path.join(memoryDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const expectedDate = file.replace('.md', '');
  const fileHash = sha1Text(content);

  const cached = priorDeltaCache.files && priorDeltaCache.files[file] ? priorDeltaCache.files[file] : null;
  let parsed = null;
  if (cached && cached.sha1 === fileHash && cached.parsed && Array.isArray(cached.parsed.records) && Array.isArray(cached.parsed.format_violations)) {
    parsed = cached.parsed;
    deltaHits++;
  } else {
    parsed = parseDailyFileRecords(file, content, expectedDate);
    deltaMisses++;
  }

  const safeParsed = {
    records: Array.isArray(parsed && parsed.records) ? parsed.records : [],
    format_violations: Array.isArray(parsed && parsed.format_violations) ? parsed.format_violations : []
  };
  nextDeltaCache.files[file] = {
    sha1: fileHash,
    parsed: safeParsed
  };

  formatViolations.push(...safeParsed.format_violations);

  for (const rec of safeParsed.records) {
    const nodeId = String(rec && rec.node_id || '').trim();
    if (!nodeId) continue;
    if (seenNodes.has(nodeId)) continue;
    seenNodes.add(nodeId);
    const uid = String(rec && rec.uid || '').trim();
    if (uid) {
      if (seenUids.has(uid)) {
        formatViolations.push({
          file: String(rec && rec.file || file),
          node_id: nodeId,
          reasons: `duplicate uid: ${uid}`
        });
        continue;
      }
      seenUids.add(uid);
    }

    const tags = Array.isArray(rec.tags) ? rec.tags.map(t => String(t || '').trim()).filter(Boolean) : [];
    const inActiveCore = projectRegistry['active-core'].includes(nodeId);
    const hasProjectTag = tags.includes('project');

    if (!inActiveCore && hasProjectTag) {
      registryWarnings.push({
        node_id: nodeId,
        warning: 'PROJECT_TAG_NOT_IN_CORE',
        details: 'Node has #project tag but is not in project-registry.active-core'
      });
    }
    if (inActiveCore && !hasProjectTag) {
      registryWarnings.push({
        node_id: nodeId,
        warning: 'CORE_MISSING_PROJECT_TAG',
        details: 'Node is in project-registry.active-core but missing #project tag'
      });
    }

    const tokenEstimate = Number.isFinite(Number(rec.token_estimate)) ? Number(rec.token_estimate) : 0;
    const cap = getNodeCap(nodeId);
    if (tokenEstimate > cap) {
      bloatWarnings.push({
        node_id: nodeId,
        file: rec.file || file,
        tokens: tokenEstimate,
        cap,
        excess: tokenEstimate - cap
      });
    }

    allNodes.push({
      node_id: nodeId,
      uid: uid || null,
      tags,
      file: rec.file || file,
      summary: String(rec.summary || 'Node content'),
      date: rec.date || expectedDate,
      token_estimate: tokenEstimate,
      in_active_core: inActiveCore
    });

    for (const tag of tags) {
      if (!allTags.has(tag)) {
        allTags.set(tag, new Set());
      }
      allTags.get(tag).add(nodeId);
    }
  }
}

saveDeltaCache(nextDeltaCache);
console.log(`Delta cache: hits=${deltaHits} misses=${deltaMisses}`);

console.log(`Valid nodes indexed: ${allNodes.length}`);
if (formatViolations.length > 0) {
  console.log(`Skipped nodes: ${formatViolations.length} (FORMAT_VIOLATIONS)`);
}

const projects = [];
const rules = [];
const concepts = [];
const systems = [];
const ops = [];
const assigned = new Set();

for (const node of allNodes) {
  if (assigned.has(node.node_id)) continue;

  const baselineCategory = getBaselineCategory(node);
  let finalCategory = baselineCategory;
  let overrideReason = null;

  if (node.node_id === 'project-registry') {
    systems.push(node);
    assigned.add(node.node_id);
    continue;
  }

  // STRICT REGISTRY CLASSIFICATION: registry takes precedence over ALL tags
  if (projectRegistry['active-core'].includes(node.node_id)) {
    finalCategory = 'Projects';
    overrideReason = 'active-core';
    projects.push(node);
    assigned.add(node.node_id);
    projectsFromRegistry++;
  } else if (projectRegistry['active-test'].includes(node.node_id) ||
             projectRegistry.paused.includes(node.node_id) ||
             projectRegistry.retired.includes(node.node_id)) {
    // All non-active-core registry entries go to Ops/Logs, regardless of tags
    finalCategory = 'Ops/Logs';
    if (projectRegistry['active-test'].includes(node.node_id)) overrideReason = 'active-test';
    else if (projectRegistry.paused.includes(node.node_id)) overrideReason = 'paused';
    else if (projectRegistry.retired.includes(node.node_id)) overrideReason = 'retired';
    ops.push(node);
    assigned.add(node.node_id);
  } else {
    // Not in registry - use tag-based classification
    if (node.tags.includes('project')) {
      // This is now a WARNING case since we have a registry
      projectsFromTag++;
      projects.push(node);
      assigned.add(node.node_id);
    } else if (node.tags.includes('workflow') || node.tags.includes('comms') || node.tags.includes('calibration')) {
      rules.push(node);
      assigned.add(node.node_id);
    } else if (node.tags.includes('architecture') || node.tags.includes('income') || node.tags.includes('platform') || node.tags.includes('concept')) {
      concepts.push(node);
      assigned.add(node.node_id);
    } else if (node.tags.includes('system') || node.tags.includes('protocol') || node.tags.includes('capabilities') || node.tags.includes('registry')) {
      systems.push(node);
      assigned.add(node.node_id);
    } else {
      ops.push(node);
      assigned.add(node.node_id);
    }
  }

  if (overrideReason && baselineCategory !== finalCategory) {
    registryForcedChanges.push({
      node_id: node.node_id,
      baseline: baselineCategory,
      final: finalCategory,
      reason: overrideReason
    });
  }
}

console.log(`\nCategory counts:`);
console.log(`- Projects: ${projects.length}`);
console.log(`- Rules: ${rules.length}`);
console.log(`- Concepts: ${concepts.length}`);
console.log(`- System: ${systems.length}`);
console.log(`- Ops/Logs: ${ops.length}`);

// Build indices
let memIndex = `# MEMORY_INDEX.md
# Last regenerated: ${new Date().toISOString().split('T')[0]}
# Whitelist: YYYY-MM-DD.md top-level; parsed by "<!-- NODE -->" separators

## Projects
| node_id | uid | tags | file | summary |
|---------|-----|------|------|---------|
${projects.map(n => `| ${n.node_id} | ${n.uid || ''} | ${n.tags.map(t => '#'+t).join(' ')} | ${n.file} | ${n.summary} |`).join('\n') || '| | | | | |'}

## Rules
| node_id | uid | tags | file | summary |
|---------|-----|------|------|---------|
${rules.map(n => `| ${n.node_id} | ${n.uid || ''} | ${n.tags.map(t => '#'+t).join(' ')} | ${n.file} | ${n.summary} |`).join('\n') || '| | | | | |'}

## Concepts
| node_id | uid | tags | file | summary |
|---------|-----|------|------|---------|
${concepts.map(n => `| ${n.node_id} | ${n.uid || ''} | ${n.tags.map(t => '#'+t).join(' ')} | ${n.file} | ${n.summary} |`).join('\n') || '| | | | | |'}

## System
| node_id | uid | tags | file | summary |
|---------|-----|------|------|---------|
${systems.map(n => `| ${n.node_id} | ${n.uid || ''} | ${n.tags.map(t => '#'+t).join(' ')} | ${n.file} | ${n.summary} |`).join('\n') || '| | | | | |'}

## Ops/Logs
| node_id | uid | tags | file | summary |
|---------|-----|------|------|---------|
${ops.map(n => `| ${n.node_id} | ${n.uid || ''} | ${n.tags.map(t => '#'+t).join(' ')} | ${n.file} | ${n.summary} |`).join('\n') || '| | | | | |'}
`;

fs.writeFileSync(path.join(memoryDir, 'MEMORY_INDEX.md'), memIndex);
console.log('\nMEMORY_INDEX.md rebuilt');

let tagIndex = `# TAGS_INDEX.md
# Last regenerated: ${new Date().toISOString().split('T')[0]}

${Array.from(allTags.entries())
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([tag, nodeIds]) => `#${tag} → ${Array.from(nodeIds).join(', ')}`)
  .join('\n')}
`;

fs.writeFileSync(path.join(memoryDir, 'TAGS_INDEX.md'), tagIndex);
console.log('TAGS_INDEX.md rebuilt');

// Scan for @decision entries in daily files
function scanForDecisions() {
  const decisions = [];
  const decisionWarnings = [];
  const decisionPattern = /^@decision\s+id:(\S+)\s+date:(\d{4}-\d{2}-\d{2})\s+domain:(\S+)\s+context:(.+?)\s+action:(.+?)\s+expected:(.+?)\s+metric:(.+?)\s+check_on:(\d{4}-\d{2}-\d{2})\s+status:(\S+)(?:\s+next:(.*))?$/;

  for (const file of dailyFiles) {
    const filePath = path.join(memoryDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (line.startsWith('@decision ')) {
        const match = line.match(decisionPattern);
        if (match) {
          const tokenCount = Math.round(line.split(/\s+/).length / 0.75);
          if (tokenCount > 120) {
            decisionWarnings.push({
              file,
              line: i + 1,
              id: match[1],
              tokens: tokenCount,
              warning: 'OVERSIZE_DECISION'
            });
          }
          
          decisions.push({
            id: match[1],
            date: match[2],
            domain: match[3],
            context: match[4].trim(),
            action: match[5].trim(),
            expected: match[6].trim(),
            metric: match[7].trim(),
            check_on: match[8],
            status: match[9],
            next: match[10] ? match[10].trim() : '',
            file,
            line: i + 1,
            tokens: tokenCount
          });
        }
      }
    }
  }

  return { decisions, decisionWarnings };
}

// Scan for decisions
const { decisions, decisionWarnings } = scanForDecisions();

// Build DECISIONS_INDEX.md (open decisions only, sorted by check_on)
const openDecisions = decisions
  .filter(d => d.status === 'open')
  .sort((a, b) => a.check_on.localeCompare(b.check_on));

let decisionsIndex = `# DECISIONS_INDEX.md
# Last regenerated: ${new Date().toISOString().split('T')[0]}
# Only open decisions, sorted by check_on

| id | date | domain | check_on | metric | file | preview |
|----|------|--------|----------|--------|------|---------|
${openDecisions.map(d => `| ${d.id} | ${d.date} | ${d.domain} | ${d.check_on} | ${d.metric.substring(0, 30)} | ${d.file} | ${d.context.substring(0, 60)} |`).join('\n') || '| | | | | | | |'}

## Stats
- Total decisions: ${decisions.length}
- Open decisions: ${openDecisions.length}
- Due today/overdue: ${openDecisions.filter(d => d.check_on <= new Date().toISOString().split('T')[0]).length}
- Oversized (>120 tokens): ${decisionWarnings.length}
`;

fs.writeFileSync(path.join(memoryDir, 'DECISIONS_INDEX.md'), decisionsIndex);
console.log('DECISIONS_INDEX.md rebuilt');

// Generate SNIPPET_INDEX.md
const { snippets, tagCounts } = scanForSnippets();

let snippetIndex = `# SNIPPET_INDEX.md
# Last regenerated: ${new Date().toISOString().split('T')[0]}
# Snippet markers found via: <!-- TAGS: #tag1 #tag2 --> | # TAGS: #tag1 #tag2 | [TAGS: #tag1 #tag2]
# Window: ±${SNIPPET_WINDOW} lines around marker
# Source paths: workspace (excluding node_modules, dist, build, .git, binaries)

## Stats
- Total markers: ${snippets.length}
- Unique tags: ${tagCounts.size}

## Snippets by Tag
| tag | file | line_start | line_end | preview |
|-----|------|------------|----------|---------|
${snippets.map(s => `| ${s.tag} | ${s.file} | ${s.line_start} | ${s.line_end} | ${s.preview} |`).join('\n')}

## Top Tags by Frequency
${Array.from(tagCounts.entries())
  .sort((a, b) => b[1] - a[1])
  .slice(0, 10)
  .map(([tag, count], i) => `${i + 1}. ${tag}: ${count} occurrences`)
  .join('\n')}
`;

fs.writeFileSync(path.join(memoryDir, 'SNIPPET_INDEX.md'), snippetIndex);
console.log('SNIPPET_INDEX.md rebuilt');

console.log('\n=== FORMAT VIOLATIONS ===');
console.log(`Count: ${formatViolations.length}`);
if (formatViolations.length > 0) {
  console.log('| file | node_id | reasons |');
  console.log('|------|---------|---------|');
  formatViolations.slice(0, 10).forEach(v => {
    console.log(`| ${v.file} | ${v.node_id} | ${v.reasons} |`);
  });
  if (formatViolations.length > 10) {
    console.log(`... and ${formatViolations.length - 10} more`);
  }
}

console.log('\n=== REGISTRY-FORCED CATEGORY CHANGES ===');
console.log(`Count: ${registryForcedChanges.length}`);
if (registryForcedChanges.length > 0) {
  registryForcedChanges.forEach(c => {
    console.log(`- ${c.node_id}: ${c.baseline} → ${c.final} (${c.reason})`);
  });
}

// NEW: Registry warnings
console.log('\n=== REGISTRY WARNINGS ===');
console.log(`Count: ${registryWarnings.length}`);
if (registryWarnings.length > 0) {
  registryWarnings.forEach(w => {
    console.log(`- ${w.node_id}: ${w.warning} - ${w.details}`);
  });
} else {
  console.log('No registry/tag mismatches detected.');
}

console.log('\n=== BLOAT VIOLATIONS ===');
console.log(`Count: ${bloatWarnings.length}`);
if (bloatWarnings.length > 0) {
  bloatWarnings.forEach(b => {
    console.log(`- ${b.node_id}: ${b.tokens}/${b.cap} tokens (+${b.excess})`);
  });
}

const totalTokens = allNodes.reduce((sum, n) => sum + n.token_estimate, 0);
const avgTokens = allNodes.length > 0 ? Math.round(totalTokens / allNodes.length) : 0;

console.log('\n=== SNIPPET INDEX ===');
console.log(`Markers found: ${snippets.length}`);
console.log(`Unique tags: ${tagCounts.size}`);
if (tagCounts.size > 0) {
  const topTags = Array.from(tagCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([tag, count]) => `${tag}(${count})`)
    .join(', ');
  console.log(`Top tags: ${topTags}`);
}

// Generate tagged blocks summary
const taggedBlocks = scanForTaggedBlocks();
console.log('\n=== TAGGED BLOCKS ===');
console.log(`Total @tag blocks: ${taggedBlocks.total}`);
if (taggedBlocks.total > 0) {
  console.log(`By scope: ${Object.entries(taggedBlocks.byScope).map(([k, v]) => `${k}=${v}`).join(', ')}`);
  console.log(`Topic tags minted: ${taggedBlocks.topicTagCount} (${taggedBlocks.topicTags.join(', ') || 'none'})`);
}

console.log('\n=== DECISION JOURNAL ===');
console.log(`Total decisions: ${decisions.length}`);
console.log(`Open decisions: ${openDecisions.length}`);
const dueTodayOrOverdue = openDecisions.filter(d => d.check_on <= new Date().toISOString().split('T')[0]).length;
console.log(`Due today/overdue: ${dueTodayOrOverdue}`);
console.log(`Oversized warnings: ${decisionWarnings.length}`);
if (decisionWarnings.length > 0) {
  decisionWarnings.slice(0, 3).forEach(w => {
    console.log(`- ${w.id}: ${w.tokens} tokens (>120 cap)`);
  });
}

console.log('\n=== SMOKE TEST SUMMARY ===');
console.log(`Files: ${dailyFiles.length} | Valid nodes: ${allNodes.length} | Skipped: ${formatViolations.length}`);
console.log(`Snippet markers: ${snippets.length} | Tagged blocks: ${taggedBlocks.total}`);
console.log(`Projects: ${projects.length} | Ops/Logs: ${ops.length}`);
console.log(`Tokens: ${totalTokens} (${avgTokens}/node avg)`);
console.log(`forced_changes: ${registryForcedChanges.length} | bloat: ${bloatWarnings.length} | registry_warnings: ${registryWarnings.length}`);
console.log(`decisions: ${decisions.length} | open: ${openDecisions.length} | due: ${dueTodayOrOverdue}`);
console.log(`Snapshots: ${backedUpFiles.length} created`);
console.log('\nEnforcement: ACTIVE (separator-parsed, validated, snippet-indexed, tag-contract-active, snapshot-backup-active, decision-journal-active)');
console.log('=== COMPLETE ===');
