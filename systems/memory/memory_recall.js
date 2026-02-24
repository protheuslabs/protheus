#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const REPO_ROOT = process.env.MEMORY_RECALL_ROOT
    ? path.resolve(String(process.env.MEMORY_RECALL_ROOT))
    : path.resolve(__dirname, '..', '..');
const MEMORY_DIR = path.join(REPO_ROOT, 'memory');
const CACHE_DIR = process.env.MEMORY_RECALL_CACHE_DIR
    ? path.resolve(String(process.env.MEMORY_RECALL_CACHE_DIR))
    : path.join(REPO_ROOT, 'state', 'memory', 'working_set');
const DEFAULT_TOP = clampInt(process.env.MEMORY_RECALL_TOP || 5, 1, 20);
const DEFAULT_MAX_FILES = clampInt(process.env.MEMORY_RECALL_MAX_FILES || 1, 1, 10);
const DEFAULT_CONFIDENCE = clampNumber(process.env.MEMORY_RECALL_CONFIDENCE || 0.58, 0.05, 1);
const DEFAULT_CACHE_MAX_BYTES = clampInt(process.env.MEMORY_RECALL_CACHE_MAX_BYTES || (1024 * 1024), 65536, 8 * 1024 * 1024);
const DEFAULT_EXCERPT_LINES = clampInt(process.env.MEMORY_RECALL_EXCERPT_LINES || 14, 4, 100);
function clampInt(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return min;
    return Math.max(min, Math.min(max, Math.round(n)));
}
function clampNumber(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return min;
    return Math.max(min, Math.min(max, n));
}
function usage() {
    console.log('Usage:');
    console.log('  node systems/memory/memory_recall.js query --q="..." [--tags=t1,t2] [--top=N] [--expand=auto|none|always] [--confidence=0.58] [--max-files=1] [--session=name]');
    console.log('  node systems/memory/memory_recall.js get --node-id=<id> [--file=memory/YYYY-MM-DD.md] [--session=name]');
    console.log('  node systems/memory/memory_recall.js get --uid=<alnum_uid> [--file=memory/YYYY-MM-DD.md] [--session=name]');
    console.log('  node systems/memory/memory_recall.js clear-cache [--session=name]');
    console.log('  node systems/memory/memory_recall.js --help');
}
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i++) {
        const a = String(argv[i] || '');
        if (!a.startsWith('--')) {
            out._.push(a);
            continue;
        }
        const eq = a.indexOf('=');
        if (eq >= 0) {
            out[a.slice(2, eq)] = a.slice(eq + 1);
            continue;
        }
        const key = a.slice(2);
        const next = argv[i + 1];
        if (next != null && !String(next).startsWith('--')) {
            out[key] = next;
            i += 1;
            continue;
        }
        out[key] = true;
    }
    return out;
}
function nowIso() {
    return new Date().toISOString();
}
function ensureDir(p) {
    if (!fs.existsSync(p))
        fs.mkdirSync(p, { recursive: true });
}
function readTextSafe(p) {
    try {
        if (!fs.existsSync(p))
            return '';
        return fs.readFileSync(p, 'utf8');
    }
    catch {
        return '';
    }
}
function stripTicks(v) {
    return String(v || '').replace(/`/g, '').trim();
}
function cleanCell(v) {
    return stripTicks(String(v || '').replace(/^\s+|\s+$/g, ''));
}
function normalizeNodeId(v) {
    const raw = stripTicks(v);
    if (!raw)
        return '';
    if (!/^[A-Za-z0-9._-]+$/.test(raw))
        return '';
    return raw;
}
function normalizeTag(v) {
    const raw = stripTicks(v).toLowerCase().replace(/^#+/, '');
    return raw.replace(/[^a-z0-9_-]/g, '');
}
function normalizeUid(v) {
    const raw = stripTicks(v);
    if (!raw)
        return '';
    if (!/^[A-Za-z0-9]+$/.test(raw))
        return '';
    return raw;
}
function normalizeHeaderCell(v) {
    const s = cleanCell(v).toLowerCase().replace(/[^\w]+/g, '_');
    if (s.includes('node_id'))
        return 'node_id';
    if (s === 'uid' || s.endsWith('_uid'))
        return 'uid';
    if (s.startsWith('file'))
        return 'file';
    if (s.startsWith('summary') || s.startsWith('title'))
        return 'summary';
    if (s.startsWith('tags'))
        return 'tags';
    return s;
}
function normalizeFileRef(v) {
    let raw = cleanCell(v).replace(/^["']|["']$/g, '');
    if (!raw)
        return '';
    raw = raw.replace(/\\/g, '/');
    raw = raw.replace(/^\.\/+/, '');
    if (raw.startsWith('memory/'))
        return raw;
    if (/^\d{4}-\d{2}-\d{2}\.md$/.test(raw))
        return `memory/${raw}`;
    if (raw.startsWith('_archive/'))
        return `memory/${raw}`;
    if (raw.endsWith('.md'))
        return raw;
    return '';
}
function parseTagCell(v) {
    const out = [];
    const parts = String(v || '').split(/[\s,]+/).map(normalizeTag).filter(Boolean);
    for (const t of parts) {
        if (!out.includes(t))
            out.push(t);
    }
    return out;
}
function indexPaths() {
    return [
        path.join(REPO_ROOT, 'MEMORY_INDEX.md'),
        path.join(MEMORY_DIR, 'MEMORY_INDEX.md')
    ];
}
function tagsPaths() {
    return [
        path.join(REPO_ROOT, 'TAGS_INDEX.md'),
        path.join(MEMORY_DIR, 'TAGS_INDEX.md')
    ];
}
function parseIndexFile(filePath) {
    const text = readTextSafe(filePath);
    if (!text)
        return [];
    const lines = text.split('\n');
    const rows = [];
    let headers = null;
    for (const lineRaw of lines) {
        const line = String(lineRaw || '');
        const trimmed = line.trim();
        if (!trimmed.startsWith('|'))
            continue;
        const cells = trimmed.split('|').slice(1, -1).map(cleanCell);
        if (!cells.length)
            continue;
        if (cells.every(c => /^[-: ]+$/.test(c)))
            continue;
        const normalized = cells.map(normalizeHeaderCell);
        if (normalized.includes('node_id') && normalized.includes('file')) {
            headers = normalized;
            continue;
        }
        if (!headers)
            continue;
        const row = {};
        for (let i = 0; i < headers.length; i++)
            row[headers[i]] = cleanCell(cells[i] || '');
        const nodeId = normalizeNodeId(row.node_id);
        const fileRef = normalizeFileRef(row.file);
        if (!nodeId || !fileRef)
            continue;
        const uid = normalizeUid(row.uid || '');
        const summary = cleanCell(row.summary || '');
        const tags = parseTagCell(row.tags || '');
        rows.push({
            node_id: nodeId,
            uid,
            file_rel: fileRef,
            file_abs: path.join(REPO_ROOT, fileRef),
            summary,
            tags
        });
    }
    return rows;
}
function loadMemoryIndex() {
    const merged = new Map();
    const source = [];
    for (const p of indexPaths()) {
        if (!fs.existsSync(p))
            continue;
        source.push(path.relative(REPO_ROOT, p).replace(/\\/g, '/'));
        const rows = parseIndexFile(p);
        for (const row of rows) {
            const key = `${row.node_id}@${row.file_rel}`;
            const cur = merged.get(key);
            if (!cur) {
                merged.set(key, {
                    key,
                    node_id: row.node_id,
                    uid: row.uid || '',
                    file_rel: row.file_rel,
                    file_abs: row.file_abs,
                    summary: row.summary || '',
                    tags: Array.isArray(row.tags) ? row.tags.slice() : []
                });
                continue;
            }
            if (!cur.uid && row.uid)
                cur.uid = row.uid;
            if (!cur.summary && row.summary)
                cur.summary = row.summary;
            for (const t of row.tags || []) {
                if (!cur.tags.includes(t))
                    cur.tags.push(t);
            }
        }
    }
    return {
        source,
        entries: Array.from(merged.values())
    };
}
function parseTagsFile(filePath) {
    const text = readTextSafe(filePath);
    if (!text)
        return new Map();
    const map = new Map();
    const lines = text.split('\n');
    let currentTag = '';
    for (const lineRaw of lines) {
        const line = String(lineRaw || '').trim();
        const heading = line.match(/^##\s+`?([^`]+)`?\s*$/);
        if (heading) {
            currentTag = normalizeTag(heading[1]);
            if (currentTag && !map.has(currentTag))
                map.set(currentTag, new Set());
            continue;
        }
        const bullet = line.match(/^-\s+`?([A-Za-z0-9._-]+)`?\s*$/);
        if (currentTag && bullet) {
            const nodeId = normalizeNodeId(bullet[1]);
            if (nodeId)
                map.get(currentTag).add(nodeId);
            continue;
        }
        const arrow = line.match(/^#([a-zA-Z0-9_-]+)\s*[-=]>\s*(.+)$/);
        if (arrow) {
            const tag = normalizeTag(arrow[1]);
            if (!tag)
                continue;
            if (!map.has(tag))
                map.set(tag, new Set());
            const ids = arrow[2].split(',').map(x => normalizeNodeId(x)).filter(Boolean);
            for (const id of ids)
                map.get(tag).add(id);
            continue;
        }
    }
    return map;
}
function loadTagsIndex() {
    const out = new Map();
    const source = [];
    for (const p of tagsPaths()) {
        if (!fs.existsSync(p))
            continue;
        source.push(path.relative(REPO_ROOT, p).replace(/\\/g, '/'));
        const m = parseTagsFile(p);
        for (const [tag, ids] of m.entries()) {
            if (!out.has(tag))
                out.set(tag, new Set());
            for (const id of ids)
                out.get(tag).add(id);
        }
    }
    return { source, tags: out };
}
function tokenize(v) {
    return String(v || '')
        .toLowerCase()
        .replace(/[^a-z0-9_\-\s]/g, ' ')
        .split(/\s+/)
        .map(x => x.trim())
        .filter(x => x.length >= 2);
}
function uniqueSorted(arr) {
    return Array.from(new Set((arr || []).filter(Boolean))).sort();
}
function scoreEntry(entry, queryTokens, tagFilters, tagNodeIds) {
    let score = 0;
    const reasons = [];
    if (tagFilters.length) {
        const overlap = (entry.tags || []).filter(t => tagFilters.includes(t)).length;
        if (overlap > 0) {
            score += overlap * 6;
            reasons.push('tag_match');
        }
        if (tagNodeIds && tagNodeIds.has(entry.node_id)) {
            score += 4;
            reasons.push('tag_index_match');
        }
    }
    const nodeLower = String(entry.node_id || '').toLowerCase();
    const summaryLower = String(entry.summary || '').toLowerCase();
    const tagsLower = (entry.tags || []).join(' ').toLowerCase();
    const fileLower = String(entry.file_rel || '').toLowerCase();
    for (const tok of queryTokens) {
        if (nodeLower === tok)
            score += 8;
        else if (nodeLower.includes(tok))
            score += 4;
        if (summaryLower.includes(tok))
            score += 3;
        if (tagsLower.includes(tok))
            score += 2;
        if (fileLower.includes(tok))
            score += 1;
    }
    if (queryTokens.length && score > 0)
        reasons.push('query_match');
    return { score, reasons: uniqueSorted(reasons) };
}
function confidenceFromScores(top, second) {
    const a = Number(top || 0);
    const b = Number(second || 0);
    if (a <= 0)
        return 0;
    const base = Math.min(1, a / 16);
    const spread = Math.min(1, Math.max(0, a - b) / 8);
    return Number(((base * 0.7) + (spread * 0.3)).toFixed(3));
}
function parseListArg(v) {
    return uniqueSorted(String(v || '')
        .split(',')
        .map(normalizeTag)
        .filter(Boolean));
}
function safeSessionName(v) {
    const s = String(v || 'default').trim();
    if (!s)
        return 'default';
    return s.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64) || 'default';
}
function cachePathForSession(session) {
    return path.join(CACHE_DIR, `${safeSessionName(session)}.json`);
}
function baseCache(session) {
    return {
        version: 1,
        session_id: safeSessionName(session),
        updated_ts: nowIso(),
        nodes: {}
    };
}
function loadCache(session) {
    const p = cachePathForSession(session);
    if (!fs.existsSync(p))
        return baseCache(session);
    try {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (!parsed || typeof parsed !== 'object')
            return baseCache(session);
        if (!parsed.nodes || typeof parsed.nodes !== 'object')
            parsed.nodes = {};
        parsed.session_id = safeSessionName(session);
        return parsed;
    }
    catch {
        return baseCache(session);
    }
}
function cacheSizeBytes(cacheObj) {
    try {
        return Buffer.byteLength(JSON.stringify(cacheObj), 'utf8');
    }
    catch {
        return 0;
    }
}
function pruneCache(cacheObj, maxBytes) {
    if (cacheSizeBytes(cacheObj) <= maxBytes)
        return cacheObj;
    const keys = Object.keys(cacheObj.nodes || {});
    keys.sort((a, b) => String(cacheObj.nodes[a]?.last_hit_ts || '').localeCompare(String(cacheObj.nodes[b]?.last_hit_ts || '')));
    for (const key of keys) {
        if (cacheSizeBytes(cacheObj) <= maxBytes)
            break;
        delete cacheObj.nodes[key];
    }
    return cacheObj;
}
function saveCache(session, cacheObj, maxBytes) {
    const p = cachePathForSession(session);
    ensureDir(path.dirname(p));
    cacheObj.updated_ts = nowIso();
    const next = pruneCache(cacheObj, maxBytes);
    fs.writeFileSync(p, JSON.stringify(next, null, 2), 'utf8');
}
function cacheKeyFor(entry) {
    return `${entry.node_id}@${entry.file_rel}`;
}
function fileStamp(filePath) {
    try {
        const st = fs.statSync(filePath);
        return {
            mtime_ms: Math.trunc(Number(st.mtimeMs || 0)),
            size: Number(st.size || 0)
        };
    }
    catch {
        return null;
    }
}
function sha256(text) {
    return crypto.createHash('sha256').update(String(text || '')).digest('hex');
}
function escapeRe(v) {
    return String(v || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function extractNodeSection(fileContent, nodeId) {
    const pieces = String(fileContent || '').split(/<!--\s*NODE\s*-->/i).map(x => x.trim()).filter(Boolean);
    for (const piece of pieces) {
        const idMatch = piece.match(/^\s*node_id:\s*([A-Za-z0-9._-]+)\s*$/m);
        if (idMatch && String(idMatch[1]) === String(nodeId))
            return piece.trim();
    }
    const re = new RegExp(`---[\\s\\S]*?\\nnode_id:\\s*${escapeRe(nodeId)}\\s*\\n[\\s\\S]*?(?=\\n\\s*<!--\\s*NODE\\s*-->|\\n---\\s*\\ndate:\\s*\\d{4}-\\d{2}-\\d{2}\\s*\\nnode_id:|$)`, 'i');
    const m = String(fileContent || '').match(re);
    return m ? String(m[0]).trim() : '';
}
function excerpt(text, lines) {
    return String(text || '').split('\n').slice(0, lines).join('\n');
}
function loadSection(entry, cacheObj, metrics, fileContents, cacheMaxBytes) {
    const key = cacheKeyFor(entry);
    const stamp = fileStamp(entry.file_abs);
    if (!stamp) {
        return { ok: false, reason: 'file_missing', source: 'none', section: '', section_hash: null };
    }
    const cached = cacheObj.nodes && cacheObj.nodes[key];
    if (cached
        && Number(cached.mtime_ms || -1) === Number(stamp.mtime_ms)
        && typeof cached.section_text === 'string'
        && cached.section_text) {
        metrics.cache_hits += 1;
        cached.last_hit_ts = nowIso();
        return {
            ok: true,
            source: 'cache',
            section: cached.section_text,
            section_hash: String(cached.section_hash || sha256(cached.section_text)),
            mtime_ms: stamp.mtime_ms
        };
    }
    metrics.cache_misses += 1;
    let content = fileContents.get(entry.file_abs);
    if (content == null) {
        try {
            content = fs.readFileSync(entry.file_abs, 'utf8');
            metrics.file_reads += 1;
            fileContents.set(entry.file_abs, content);
        }
        catch {
            return { ok: false, reason: 'file_read_failed', source: 'none', section: '', section_hash: null };
        }
    }
    const section = extractNodeSection(content, entry.node_id);
    if (!section)
        return { ok: false, reason: 'node_not_found', source: 'file', section: '', section_hash: null };
    const hash = sha256(section);
    if (!cacheObj.nodes || typeof cacheObj.nodes !== 'object')
        cacheObj.nodes = {};
    cacheObj.nodes[key] = {
        key,
        node_id: entry.node_id,
        file_rel: entry.file_rel,
        mtime_ms: stamp.mtime_ms,
        section_hash: hash,
        section_text: section,
        loaded_ts: nowIso(),
        last_hit_ts: nowIso()
    };
    pruneCache(cacheObj, cacheMaxBytes);
    return {
        ok: true,
        source: 'file',
        section,
        section_hash: hash,
        mtime_ms: stamp.mtime_ms
    };
}
function sortByDateDesc(entries) {
    return entries.slice().sort((a, b) => {
        const da = String(a.file_rel || '').match(/(\d{4}-\d{2}-\d{2})/);
        const db = String(b.file_rel || '').match(/(\d{4}-\d{2}-\d{2})/);
        const va = da ? da[1] : '';
        const vb = db ? db[1] : '';
        if (vb !== va)
            return vb.localeCompare(va);
        const aa = String(a.file_rel || '').includes('/_archive/') ? 1 : 0;
        const bb = String(b.file_rel || '').includes('/_archive/') ? 1 : 0;
        if (aa !== bb)
            return aa - bb;
        return String(a.node_id || '').localeCompare(String(b.node_id || ''));
    });
}
function queryCmd(args) {
    const query = String(args.q || args.query || '').trim();
    const tagFilters = parseListArg(args.tags);
    const top = clampInt(args.top == null ? DEFAULT_TOP : args.top, 1, 20);
    const expandMode = String(args.expand || 'auto').trim().toLowerCase();
    const confidenceThreshold = clampNumber(args.confidence == null ? DEFAULT_CONFIDENCE : args.confidence, 0.05, 1);
    const maxFiles = clampInt(args['max-files'] == null ? (args.max_files == null ? DEFAULT_MAX_FILES : args.max_files) : args['max-files'], 1, 10);
    const session = safeSessionName(args.session || process.env.MEMORY_RECALL_SESSION || 'default');
    const cacheMaxBytes = clampInt(args['cache-max-bytes'] == null ? DEFAULT_CACHE_MAX_BYTES : args['cache-max-bytes'], 65536, 8 * 1024 * 1024);
    const excerptLines = clampInt(args['excerpt-lines'] == null ? DEFAULT_EXCERPT_LINES : args['excerpt-lines'], 4, 200);
    const index = loadMemoryIndex();
    const tagIndex = loadTagsIndex();
    const metrics = {
        candidates_total: index.entries.length,
        cache_hits: 0,
        cache_misses: 0,
        file_reads: 0
    };
    const tagNodeIds = new Set();
    for (const tag of tagFilters) {
        const ids = tagIndex.tags.get(tag);
        if (!ids)
            continue;
        for (const id of ids)
            tagNodeIds.add(id);
    }
    let candidates = index.entries.slice();
    if (tagFilters.length && tagNodeIds.size > 0) {
        candidates = candidates.filter(e => tagNodeIds.has(e.node_id));
    }
    const queryTokens = uniqueSorted(tokenize(query));
    const scored = candidates.map((entry) => {
        const s = scoreEntry(entry, queryTokens, tagFilters, tagNodeIds);
        return { entry, score: s.score, reasons: s.reasons };
    });
    scored.sort((a, b) => {
        if (b.score !== a.score)
            return b.score - a.score;
        if (a.entry.file_rel !== b.entry.file_rel)
            return String(a.entry.file_rel).localeCompare(String(b.entry.file_rel));
        return String(a.entry.node_id).localeCompare(String(b.entry.node_id));
    });
    const topScored = scored.slice(0, top);
    const topScore = Number(topScored[0] ? topScored[0].score : 0);
    const secondScore = Number(topScored[1] ? topScored[1].score : 0);
    const confidence = confidenceFromScores(topScore, secondScore);
    const shouldExpand = expandMode === 'always'
        || (expandMode === 'auto' && confidence < confidenceThreshold);
    const cacheObj = loadCache(session);
    const fileContents = new Map();
    const fileOrder = uniqueSorted(topScored.map(x => x.entry.file_rel));
    const expandFiles = new Set(fileOrder.slice(0, maxFiles));
    let expandedCount = 0;
    const hits = topScored.map((row, idx) => {
        const base = {
            rank: idx + 1,
            node_id: row.entry.node_id,
            uid: row.entry.uid || '',
            file: row.entry.file_rel,
            summary: row.entry.summary || '',
            tags: row.entry.tags || [],
            score: row.score,
            reasons: row.reasons
        };
        if (!shouldExpand)
            return { ...base, expanded: false };
        if (!expandFiles.has(row.entry.file_rel)) {
            return { ...base, expanded: false, expand_blocked: 'file_budget' };
        }
        const sec = loadSection(row.entry, cacheObj, metrics, fileContents, cacheMaxBytes);
        if (!sec.ok) {
            return { ...base, expanded: false, expand_error: sec.reason || 'unknown' };
        }
        expandedCount += 1;
        return {
            ...base,
            expanded: true,
            section_source: sec.source,
            section_hash: sec.section_hash,
            section_excerpt: excerpt(sec.section, excerptLines)
        };
    });
    saveCache(session, cacheObj, cacheMaxBytes);
    process.stdout.write(JSON.stringify({
        ok: true,
        type: 'memory_recall_query',
        query,
        tags: tagFilters,
        session,
        confidence,
        confidence_threshold: confidenceThreshold,
        expand_mode: expandMode,
        expanded_count: expandedCount,
        max_files: maxFiles,
        index_sources: index.source,
        tag_sources: tagIndex.source,
        metrics,
        hits
    }, null, 2) + '\n');
}
function getCmd(args) {
    const nodeId = normalizeNodeId(args['node-id'] || args.node_id || '');
    const uid = normalizeUid(args.uid || '');
    const fileFilter = normalizeFileRef(args.file || '');
    const session = safeSessionName(args.session || process.env.MEMORY_RECALL_SESSION || 'default');
    const cacheMaxBytes = clampInt(args['cache-max-bytes'] == null ? DEFAULT_CACHE_MAX_BYTES : args['cache-max-bytes'], 65536, 8 * 1024 * 1024);
    if (!nodeId && !uid) {
        process.stdout.write(JSON.stringify({
            ok: false,
            error: 'missing --node-id=<id> or --uid=<alnum_uid>'
        }) + '\n');
        process.exit(2);
    }
    const index = loadMemoryIndex();
    let matches = index.entries.slice();
    if (uid)
        matches = matches.filter(e => String(e.uid || '') === uid);
    if (nodeId)
        matches = matches.filter(e => e.node_id === nodeId);
    if (fileFilter)
        matches = matches.filter(e => e.file_rel === fileFilter);
    matches = sortByDateDesc(matches);
    const entry = matches[0];
    if (!entry) {
        process.stdout.write(JSON.stringify({
            ok: false,
            error: 'node_not_found',
            node_id: nodeId || null,
            uid: uid || null,
            file: fileFilter || null
        }) + '\n');
        process.exit(1);
    }
    const metrics = { cache_hits: 0, cache_misses: 0, file_reads: 0 };
    const cacheObj = loadCache(session);
    const fileContents = new Map();
    const sec = loadSection(entry, cacheObj, metrics, fileContents, cacheMaxBytes);
    saveCache(session, cacheObj, cacheMaxBytes);
    if (!sec.ok) {
        process.stdout.write(JSON.stringify({
            ok: false,
            error: sec.reason || 'section_unavailable',
            node_id: nodeId,
            file: entry.file_rel
        }) + '\n');
        process.exit(1);
    }
    process.stdout.write(JSON.stringify({
        ok: true,
        type: 'memory_recall_get',
        session,
        node_id: entry.node_id,
        uid: entry.uid || '',
        file: entry.file_rel,
        summary: entry.summary || '',
        tags: entry.tags || [],
        section_source: sec.source,
        section_hash: sec.section_hash,
        metrics,
        section: sec.section
    }, null, 2) + '\n');
}
function clearCacheCmd(args) {
    const session = safeSessionName(args.session || process.env.MEMORY_RECALL_SESSION || 'default');
    const p = cachePathForSession(session);
    if (fs.existsSync(p))
        fs.rmSync(p, { force: true });
    process.stdout.write(JSON.stringify({
        ok: true,
        type: 'memory_recall_clear_cache',
        session
    }) + '\n');
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = String(args._[0] || '').trim().toLowerCase();
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
        usage();
        process.exit(0);
    }
    if (cmd === 'query')
        return queryCmd(args);
    if (cmd === 'get')
        return getCmd(args);
    if (cmd === 'clear-cache' || cmd === 'clear_cache')
        return clearCacheCmd(args);
    usage();
    process.exit(2);
}
if (require.main === module)
    main();
module.exports = {
    parseIndexFile,
    parseTagsFile,
    extractNodeSection,
    scoreEntry,
    confidenceFromScores,
    normalizeFileRef,
    normalizeNodeId,
    normalizeUid
};
