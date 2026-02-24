#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * systems/memory/eyes_memory_bridge.js
 *
 * Deterministic bridge from sensory eye output into memory nodes + pointer logs.
 * No LLM calls. Idempotent by item hash.
 *
 * Usage:
 *   node systems/memory/eyes_memory_bridge.js run [YYYY-MM-DD] [--max-nodes=3]
 *   node systems/memory/eyes_memory_bridge.js status [YYYY-MM-DD]
 *   node systems/memory/eyes_memory_bridge.js --help
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { enforceMutationProvenance, recordMutationAudit } = require('../../lib/mutation_provenance');
const SCRIPT_SOURCE = 'systems/memory/eyes_memory_bridge.js';
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MEMORY_DIR = process.env.MEMORY_BRIDGE_MEMORY_DIR
    ? path.resolve(String(process.env.MEMORY_BRIDGE_MEMORY_DIR))
    : path.join(REPO_ROOT, 'memory');
const PROPOSALS_DIR = process.env.MEMORY_BRIDGE_PROPOSALS_DIR
    ? path.resolve(String(process.env.MEMORY_BRIDGE_PROPOSALS_DIR))
    : path.join(REPO_ROOT, 'state', 'sensory', 'proposals');
const POINTERS_DIR = process.env.MEMORY_BRIDGE_POINTERS_DIR
    ? path.resolve(String(process.env.MEMORY_BRIDGE_POINTERS_DIR))
    : path.join(REPO_ROOT, 'state', 'memory', 'eyes_pointers');
const POINTER_INDEX_PATH = process.env.MEMORY_BRIDGE_POINTER_INDEX_PATH
    ? path.resolve(String(process.env.MEMORY_BRIDGE_POINTER_INDEX_PATH))
    : path.join(POINTERS_DIR, 'index.json');
const LEDGER_PATH = process.env.MEMORY_BRIDGE_LEDGER_PATH
    ? path.resolve(String(process.env.MEMORY_BRIDGE_LEDGER_PATH))
    : path.join(REPO_ROOT, 'state', 'memory', 'eyes_memory_bridge.jsonl');
const DEFAULT_MAX_NODES = clampInt(process.env.MEMORY_BRIDGE_MAX_NODES || 3, 1, 12);
const MIN_RELEVANCE = clampInt(process.env.MEMORY_BRIDGE_MIN_RELEVANCE || 60, 0, 100);
const MIN_SIGNAL = clampInt(process.env.MEMORY_BRIDGE_MIN_SIGNAL || 65, 0, 100);
const LOCAL_FALLBACK_MIN_COMPOSITE = clampInt(process.env.MEMORY_BRIDGE_LOCAL_FALLBACK_MIN_COMPOSITE || 70, 0, 100);
const ALLOWED_TYPES = new Set(String(process.env.MEMORY_BRIDGE_ALLOWED_TYPES || 'external_intel,cross_signal_opportunity,collector_remediation,infrastructure_outage,opportunity_capture')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean));
function usage() {
    console.log('Usage:');
    console.log('  node systems/memory/eyes_memory_bridge.js run [YYYY-MM-DD] [--max-nodes=3]');
    console.log('  node systems/memory/eyes_memory_bridge.js status [YYYY-MM-DD]');
    console.log('  node systems/memory/eyes_memory_bridge.js --help');
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
function clampInt(v, min, max) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return min;
    return Math.max(min, Math.min(max, Math.round(n)));
}
function nowIso() {
    return new Date().toISOString();
}
function toDate(v) {
    const raw = String(v || '').trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw))
        return raw;
    return new Date().toISOString().slice(0, 10);
}
function ensureDir(dirPath) {
    if (!fs.existsSync(dirPath))
        fs.mkdirSync(dirPath, { recursive: true });
}
function safeReadJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath))
            return fallback;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
    catch {
        return fallback;
    }
}
function appendJsonl(filePath, obj) {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, JSON.stringify(obj) + '\n', 'utf8');
}
function readJsonl(filePath) {
    if (!fs.existsSync(filePath))
        return [];
    return fs.readFileSync(filePath, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
        try {
            return JSON.parse(line);
        }
        catch {
            return null;
        }
    })
        .filter(Boolean);
}
function sha16(v) {
    return crypto.createHash('sha256').update(String(v || ''), 'utf8').digest('hex').slice(0, 16);
}
function uidAlnum(seed) {
    // Immutable alphanumeric uid (hex subset) for stable pointer identity.
    return crypto.createHash('sha256').update(String(seed || ''), 'utf8').digest('hex').slice(0, 24);
}
function cleanLine(v, maxLen = 220) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function normalizeToken(v) {
    return String(v || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
}
function parseProposalArray(raw) {
    if (Array.isArray(raw))
        return raw;
    if (raw && typeof raw === 'object' && Array.isArray(raw.proposals))
        return raw.proposals;
    return [];
}
function loadProposals(dateStr) {
    const filePath = path.join(PROPOSALS_DIR, `${dateStr}.json`);
    const raw = safeReadJson(filePath, []);
    return { filePath, proposals: parseProposalArray(raw) };
}
function firstEvidence(p) {
    const ev = Array.isArray(p && p.evidence) ? p.evidence : [];
    return ev.length ? ev[0] : {};
}
function eyeIdFromProposal(p) {
    const metaEye = cleanLine(p && p.meta && p.meta.source_eye, 64);
    if (metaEye)
        return metaEye;
    const ev = firstEvidence(p);
    const ref = cleanLine(ev && ev.evidence_ref, 100);
    const m = ref.match(/^eye:([A-Za-z0-9_.-]+)/);
    if (m && m[1])
        return m[1];
    return 'unknown_eye';
}
function itemHashFromProposal(p) {
    const ev = firstEvidence(p);
    const evidenceHash = cleanLine(ev && ev.evidence_item_hash, 80);
    if (evidenceHash)
        return evidenceHash;
    const url = cleanLine((p && p.meta && p.meta.url) || (ev && ev.evidence_url) || '', 320);
    if (url)
        return sha16(url);
    return sha16(`${cleanLine(p && p.id, 80)}|${cleanLine(p && p.title, 220)}`);
}
function numeric(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? n : fallback;
}
function computePriority(meta) {
    const composite = numeric(meta.composite_eligibility_score, 0);
    const relevance = numeric(meta.relevance_score, 0);
    const signal = numeric(meta.signal_quality_score, 0);
    return Number((composite * 0.5 + relevance * 0.3 + signal * 0.2).toFixed(2));
}
function makeCandidate(p) {
    if (!p || typeof p !== 'object')
        return null;
    const type = cleanLine(p.type, 80).toLowerCase();
    if (!ALLOWED_TYPES.has(type))
        return null;
    const title = cleanLine(p.title, 220);
    if (!title || /\[stub\]/i.test(title))
        return null;
    const meta = p.meta && typeof p.meta === 'object' ? p.meta : {};
    const eyeId = eyeIdFromProposal(p);
    const actionabilityPass = meta.actionability_pass === true;
    const compositePass = meta.composite_eligibility_pass === true;
    const relevance = numeric(meta.relevance_score, 0);
    const signal = numeric(meta.signal_quality_score, 0);
    const composite = numeric(meta.composite_eligibility_score, 0);
    let eligible = actionabilityPass || compositePass || relevance >= MIN_RELEVANCE || signal >= MIN_SIGNAL;
    const reasons = [];
    if (!eligible)
        reasons.push('below_bridge_threshold');
    if (eyeId === 'local_state_fallback' && !actionabilityPass && composite < LOCAL_FALLBACK_MIN_COMPOSITE) {
        eligible = false;
        reasons.push('local_fallback_low_composite');
    }
    const ev = firstEvidence(p);
    const url = cleanLine((meta && meta.url) || (ev && ev.evidence_url) || '', 320);
    const itemHash = itemHashFromProposal(p);
    const topics = Array.isArray(meta.topics) ? meta.topics.map((t) => cleanLine(t, 32)).filter(Boolean).slice(0, 6) : [];
    return {
        proposal: p,
        proposal_id: cleanLine(p.id, 80),
        type,
        title,
        eye_id: eyeId,
        url,
        item_hash: itemHash,
        topics,
        actionability_pass: actionabilityPass,
        composite_pass: compositePass,
        relevance_score: relevance,
        signal_quality_score: signal,
        composite_eligibility_score: composite,
        priority: computePriority(meta),
        eligible,
        reasons
    };
}
function loadPointerIndex() {
    const base = safeReadJson(POINTER_INDEX_PATH, { version: '1.0', updated_ts: null, item_hashes: {} });
    if (!base || typeof base !== 'object')
        return { version: '1.0', updated_ts: null, item_hashes: {} };
    if (!base.item_hashes || typeof base.item_hashes !== 'object')
        base.item_hashes = {};
    return base;
}
function savePointerIndex(index) {
    ensureDir(path.dirname(POINTER_INDEX_PATH));
    const next = { ...index, updated_ts: nowIso() };
    fs.writeFileSync(POINTER_INDEX_PATH, JSON.stringify(next, null, 2) + '\n', 'utf8');
}
function existingNodeIds(memoryPath) {
    if (!fs.existsSync(memoryPath))
        return new Set();
    const text = fs.readFileSync(memoryPath, 'utf8');
    const ids = new Set();
    const re = /^\s*node_id:\s*([A-Za-z0-9._-]+)\s*$/gm;
    let m = re.exec(text);
    while (m) {
        if (m[1])
            ids.add(String(m[1]));
        m = re.exec(text);
    }
    return ids;
}
function uniqueNodeId(base, seen) {
    if (!seen.has(base))
        return base;
    for (let i = 2; i <= 99; i++) {
        const next = `${base}-${i}`;
        if (!seen.has(next))
            return next;
    }
    return `${base}-${Date.now()}`;
}
function renderNode(dateStr, nodeId, c) {
    const uid = uidAlnum(`${dateStr}|${c.item_hash}|${c.proposal_id}|${c.eye_id}|v1`);
    const eyeTag = normalizeToken(c.eye_id) || 'unknown-eye';
    const tags = ['eyes', 'sensory', eyeTag, 'memory-bridge'];
    for (const t of c.topics.slice(0, 2)) {
        const n = normalizeToken(t);
        if (n && !tags.includes(n))
            tags.push(n);
    }
    const url = c.url || 'n/a';
    const summary = cleanLine(c.proposal && c.proposal.summary, 300);
    const notes = cleanLine(c.proposal && c.proposal.notes, 300);
    const suggested = cleanLine(c.proposal && c.proposal.suggested_next_command, 300);
    const lines = [
        '---',
        `date: ${dateStr}`,
        `node_id: ${nodeId}`,
        `uid: ${uid}`,
        `tags: [${tags.join(', ')}]`,
        'edges_to: []',
        '---',
        '',
        `# ${nodeId}`,
        '',
        '## Eye Signal',
        '',
        `- Source eye: ${c.eye_id}`,
        `- Proposal: ${c.proposal_id}`,
        `- Type: ${c.type}`,
        `- Title: ${c.title}`,
        `- URL: ${url}`,
        `- Item hash: ${c.item_hash}`,
        `- Priority: ${c.priority}`,
        `- Scores: composite=${c.composite_eligibility_score}, relevance=${c.relevance_score}, signal=${c.signal_quality_score}`,
        '',
        '## Why It Matters',
        '',
        summary ? `- ${summary}` : '- Derived from sensory proposal enrichment.',
        notes ? `- ${notes}` : '- Actionability and directive-fit metadata available in proposal payload.',
        suggested ? `- Suggested next command: \`${suggested}\`` : '- No suggested command.',
        ''
    ];
    return { text: lines.join('\n'), uid };
}
function appendNodeToMemory(dateStr, c) {
    ensureDir(MEMORY_DIR);
    const memoryPath = path.join(MEMORY_DIR, `${dateStr}.md`);
    const seen = existingNodeIds(memoryPath);
    const baseNodeId = `eye-${normalizeToken(c.eye_id || 'unknown')}-${String(c.item_hash || '').slice(0, 8)}`;
    const nodeId = uniqueNodeId(baseNodeId, seen);
    const rendered = renderNode(dateStr, nodeId, c);
    const text = rendered.text;
    const exists = fs.existsSync(memoryPath);
    if (!exists || fs.readFileSync(memoryPath, 'utf8').trim().length === 0) {
        fs.writeFileSync(memoryPath, text + '\n', 'utf8');
    }
    else {
        fs.appendFileSync(memoryPath, `\n\n<!-- NODE -->\n\n${text}\n`, 'utf8');
    }
    return { memoryPath, nodeId, uid: rendered.uid };
}
function writePointers(dateStr, rows) {
    if (!Array.isArray(rows) || rows.length === 0)
        return null;
    ensureDir(POINTERS_DIR);
    const fp = path.join(POINTERS_DIR, `${dateStr}.jsonl`);
    for (const row of rows) {
        appendJsonl(fp, row);
    }
    return fp;
}
function runBridge(dateStr, maxNodes) {
    const provenance = enforceMutationProvenance('memory', {
        source: SCRIPT_SOURCE,
        reason: 'eyes_memory_bridge_run'
    }, {
        fallbackSource: SCRIPT_SOURCE,
        defaultReason: 'eyes_memory_bridge_run',
        context: `run:${dateStr}`
    });
    const { filePath, proposals } = loadProposals(dateStr);
    const index = loadPointerIndex();
    const known = new Set(Object.keys(index.item_hashes || {}));
    const pointerPath = path.join(POINTERS_DIR, `${dateStr}.jsonl`);
    const existingPointerRows = fs.existsSync(pointerPath) ? readJsonl(pointerPath) : [];
    const alreadyPointeredToday = new Set(existingPointerRows
        .map((r) => String(r && r.item_hash || '').trim())
        .filter(Boolean));
    const eligible = proposals
        .map(makeCandidate)
        .filter(Boolean)
        .filter((c) => c.eligible)
        .filter((c, idx, arr) => arr.findIndex((x) => x.item_hash === c.item_hash) === idx)
        .filter((c) => !alreadyPointeredToday.has(c.item_hash))
        .sort((a, b) => {
        if (b.priority !== a.priority)
            return b.priority - a.priority;
        if (b.composite_eligibility_score !== a.composite_eligibility_score)
            return b.composite_eligibility_score - a.composite_eligibility_score;
        return String(a.proposal_id || '').localeCompare(String(b.proposal_id || ''));
    });
    const unseen = eligible.filter((c) => !known.has(c.item_hash));
    const seen = eligible.filter((c) => known.has(c.item_hash));
    const selected = [
        ...unseen.slice(0, maxNodes),
        ...seen.slice(0, Math.max(0, maxNodes - unseen.length))
    ].slice(0, maxNodes);
    const pointerRows = [];
    const created = [];
    let revisits = 0;
    for (const c of selected) {
        const knownMap = index.item_hashes[c.item_hash];
        const isRevisit = !!(knownMap && knownMap.node_id && knownMap.memory_file);
        const node = isRevisit
            ? {
                nodeId: String(knownMap.node_id),
                uid: String(knownMap.uid || ''),
                memoryPath: path.join(REPO_ROOT, String(knownMap.memory_file))
            }
            : appendNodeToMemory(dateStr, c);
        const pointer = {
            ts: nowIso(),
            date: dateStr,
            source: 'eyes_memory_bridge',
            proposal_id: c.proposal_id,
            eye_id: c.eye_id,
            type: c.type,
            item_hash: c.item_hash,
            title: c.title,
            url: c.url || null,
            topics: c.topics,
            node_id: node.nodeId,
            uid: node.uid,
            memory_file: path.relative(REPO_ROOT, node.memoryPath).replace(/\\/g, '/'),
            pointer_kind: isRevisit ? 'revisit' : 'new_node',
            priority: c.priority,
            composite_eligibility_score: c.composite_eligibility_score,
            relevance_score: c.relevance_score,
            signal_quality_score: c.signal_quality_score
        };
        pointerRows.push(pointer);
        if (isRevisit) {
            revisits += 1;
        }
        else {
            created.push(pointer);
        }
        index.item_hashes[c.item_hash] = {
            node_id: node.nodeId,
            uid: node.uid,
            memory_file: pointer.memory_file,
            date: dateStr,
            eye_id: c.eye_id,
            proposal_id: c.proposal_id,
            ts: pointer.ts
        };
    }
    savePointerIndex(index);
    const pointerFile = writePointers(dateStr, pointerRows);
    const result = {
        ok: true,
        type: 'eyes_memory_bridge',
        date: dateStr,
        proposals_path: path.relative(REPO_ROOT, filePath).replace(/\\/g, '/'),
        proposals_total: proposals.length,
        eligible_candidates: eligible.length,
        selected: selected.length,
        created_nodes: created.length,
        revisit_pointers: revisits,
        skipped_existing: Math.max(0, eligible.length - selected.length),
        memory_file: path.relative(REPO_ROOT, path.join(MEMORY_DIR, `${dateStr}.md`)).replace(/\\/g, '/'),
        pointers_file: pointerFile ? path.relative(REPO_ROOT, pointerFile).replace(/\\/g, '/') : null,
        pointer_index: path.relative(REPO_ROOT, POINTER_INDEX_PATH).replace(/\\/g, '/'),
        created: created.slice(0, 12)
    };
    appendJsonl(LEDGER_PATH, {
        ts: nowIso(),
        type: 'eyes_memory_bridge_run',
        date: dateStr,
        created_nodes: result.created_nodes,
        revisit_pointers: Number(result.revisit_pointers || 0),
        selected: result.selected,
        eligible_candidates: result.eligible_candidates,
        proposals_total: result.proposals_total
    });
    recordMutationAudit('memory', {
        type: 'controller_run',
        controller: SCRIPT_SOURCE,
        operation: 'eyes_memory_bridge_run',
        source: provenance.meta && provenance.meta.source || SCRIPT_SOURCE,
        reason: provenance.meta && provenance.meta.reason || 'eyes_memory_bridge_run',
        provenance_ok: provenance.ok === true,
        provenance_violations: Array.isArray(provenance.violations) ? provenance.violations : [],
        files_touched: [
            result.memory_file,
            result.pointers_file,
            result.pointer_index,
            path.relative(REPO_ROOT, LEDGER_PATH).replace(/\\/g, '/')
        ].filter(Boolean),
        metrics: {
            proposals_total: result.proposals_total,
            selected: result.selected,
            created_nodes: result.created_nodes,
            revisit_pointers: result.revisit_pointers
        }
    });
    return result;
}
function status(dateStr) {
    const index = loadPointerIndex();
    const pointerPath = path.join(POINTERS_DIR, `${dateStr}.jsonl`);
    const rows = readJsonl(pointerPath);
    return {
        ok: true,
        type: 'eyes_memory_bridge_status',
        date: dateStr,
        pointers_today: rows.length,
        pointer_index_entries: Object.keys(index.item_hashes || {}).length,
        pointers_file: fs.existsSync(pointerPath)
            ? path.relative(REPO_ROOT, pointerPath).replace(/\\/g, '/')
            : null
    };
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = String(args._[0] || '').toLowerCase();
    if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h' || args.help) {
        usage();
        process.exit(0);
    }
    if (cmd === 'run') {
        const dateStr = toDate(args._[1]);
        const maxNodes = clampInt(args['max-nodes'] == null ? DEFAULT_MAX_NODES : args['max-nodes'], 1, 12);
        const out = runBridge(dateStr, maxNodes);
        process.stdout.write(JSON.stringify(out) + '\n');
        return;
    }
    if (cmd === 'status') {
        const dateStr = toDate(args._[1]);
        process.stdout.write(JSON.stringify(status(dateStr)) + '\n');
        return;
    }
    usage();
    process.exit(2);
}
if (require.main === module) {
    main();
}
module.exports = {
    runBridge,
    status,
    makeCandidate,
    parseProposalArray,
    itemHashFromProposal
};
