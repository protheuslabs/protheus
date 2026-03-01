#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SELF_MOD_REVERSION_DRILL_POLICY_PATH
    ? path.resolve(process.env.SELF_MOD_REVERSION_DRILL_POLICY_PATH)
    : path.join(ROOT, 'config', 'self_mod_reversion_drill_policy.json');
function nowIso() {
    return String(process.env.SELF_MOD_REVERSION_NOW_ISO || new Date().toISOString());
}
function cleanText(v, maxLen = 260) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}
function normalizeToken(v, maxLen = 140) {
    return cleanText(v, maxLen)
        .toLowerCase()
        .replace(/[^a-z0-9_.:/-]+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_+|_+$/g, '');
}
function toBool(v, fallback = false) {
    if (v == null)
        return fallback;
    const raw = String(v).trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(raw))
        return true;
    if (['0', 'false', 'no', 'off'].includes(raw))
        return false;
    return fallback;
}
function clampInt(v, lo, hi, fallback) {
    const n = Number(v);
    if (!Number.isFinite(n))
        return fallback;
    const i = Math.floor(n);
    if (i < lo)
        return lo;
    if (i > hi)
        return hi;
    return i;
}
function parseArgs(argv) {
    const out = { _: [] };
    for (let i = 0; i < argv.length; i += 1) {
        const tok = String(argv[i] || '');
        if (!tok.startsWith('--')) {
            out._.push(tok);
            continue;
        }
        const idx = tok.indexOf('=');
        if (idx >= 0) {
            out[tok.slice(2, idx)] = tok.slice(idx + 1);
            continue;
        }
        const key = tok.slice(2);
        const next = argv[i + 1];
        if (next != null && !String(next).startsWith('--')) {
            out[key] = String(next);
            i += 1;
            continue;
        }
        out[key] = true;
    }
    return out;
}
function ensureDir(dirPath) {
    fs.mkdirSync(dirPath, { recursive: true });
}
function readJson(filePath, fallback) {
    try {
        if (!fs.existsSync(filePath))
            return fallback;
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return parsed == null ? fallback : parsed;
    }
    catch {
        return fallback;
    }
}
function writeJsonAtomic(filePath, value) {
    ensureDir(path.dirname(filePath));
    const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, filePath);
}
function appendJsonl(filePath, row) {
    ensureDir(path.dirname(filePath));
    fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}
function relPath(filePath) {
    return path.relative(ROOT, filePath).replace(/\\/g, '/');
}
function resolvePath(raw, fallbackRel) {
    const txt = cleanText(raw || '', 520);
    if (!txt)
        return path.join(ROOT, fallbackRel);
    return path.isAbsolute(txt) ? txt : path.join(ROOT, txt);
}
function parseJsonSafe(text) {
    const raw = String(text || '').trim();
    if (!raw)
        return null;
    try {
        return JSON.parse(raw);
    }
    catch { }
    const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
            return JSON.parse(lines[i]);
        }
        catch { }
    }
    return null;
}
function runJson(scriptPath, args, timeoutMs) {
    const proc = spawnSync('node', [scriptPath, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: Math.max(5000, timeoutMs)
    });
    const stdout = String(proc.stdout || '').trim();
    const stderr = String(proc.stderr || '').trim();
    return {
        ok: Number(proc.status || 0) === 0,
        status: Number(proc.status || 0),
        stdout: cleanText(stdout, 3000),
        stderr: cleanText(stderr, 3000),
        payload: parseJsonSafe(stdout)
    };
}
function defaultPolicy() {
    return {
        version: '1.0',
        enabled: true,
        shadow_only: true,
        sla_minutes: 15,
        freshness_days: 35,
        timeout_ms: 30000,
        scripts: {
            loop: 'systems/autonomy/gated_self_improvement_loop.js'
        },
        latest_state_paths: {
            gated_self_improvement_policy_path: 'config/gated_self_improvement_policy.json'
        },
        outputs: {
            latest_path: 'state/autonomy/self_mod_reversion_drill/latest.json',
            receipts_path: 'state/autonomy/self_mod_reversion_drill/receipts.jsonl'
        }
    };
}
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
    const src = readJson(policyPath, {});
    const base = defaultPolicy();
    const scripts = src.scripts && typeof src.scripts === 'object' ? src.scripts : {};
    const latestState = src.latest_state_paths && typeof src.latest_state_paths === 'object' ? src.latest_state_paths : {};
    const outputs = src.outputs && typeof src.outputs === 'object' ? src.outputs : {};
    return {
        version: cleanText(src.version || base.version, 40) || base.version,
        enabled: src.enabled !== false,
        shadow_only: src.shadow_only !== false,
        sla_minutes: clampInt(src.sla_minutes, 1, 24 * 60, base.sla_minutes),
        freshness_days: clampInt(src.freshness_days, 1, 365, base.freshness_days),
        timeout_ms: clampInt(src.timeout_ms, 5000, 10 * 60 * 1000, base.timeout_ms),
        scripts: {
            loop: resolvePath(scripts.loop || base.scripts.loop, base.scripts.loop)
        },
        latest_state_paths: {
            gated_self_improvement_policy_path: resolvePath(latestState.gated_self_improvement_policy_path || base.latest_state_paths.gated_self_improvement_policy_path, base.latest_state_paths.gated_self_improvement_policy_path)
        },
        outputs: {
            latest_path: resolvePath(outputs.latest_path || base.outputs.latest_path, base.outputs.latest_path),
            receipts_path: resolvePath(outputs.receipts_path || base.outputs.receipts_path, base.outputs.receipts_path)
        },
        policy_path: path.resolve(policyPath)
    };
}
function discoverLatestProposalId(policy) {
    const gatedPolicy = readJson(policy.latest_state_paths.gated_self_improvement_policy_path, {});
    const statePath = gatedPolicy && gatedPolicy.paths && gatedPolicy.paths.state_path
        ? resolvePath(gatedPolicy.paths.state_path, 'state/autonomy/gated_self_improvement/state.json')
        : resolvePath('state/autonomy/gated_self_improvement/state.json', 'state/autonomy/gated_self_improvement/state.json');
    const state = readJson(statePath, {});
    const proposals = state && state.proposals && typeof state.proposals === 'object'
        ? Object.entries(state.proposals)
        : [];
    const rows = proposals
        .map(([proposalId, row]) => ({
        proposal_id: proposalId,
        ts: Date.parse(String(row && row.updated_at || row && row.created_at || '')),
        stage: normalizeToken(row && row.stage || '', 80)
    }))
        .filter((row) => !!row.proposal_id)
        .sort((a, b) => Number(b.ts || 0) - Number(a.ts || 0));
    return rows.length ? rows[0].proposal_id : null;
}
function cmdRun(args) {
    const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
    if (policy.enabled !== true) {
        const out = { ok: false, type: 'self_mod_reversion_drill', error: 'policy_disabled' };
        process.stdout.write(`${JSON.stringify(out)}\n`);
        process.exit(1);
    }
    const proposalId = normalizeToken(args['proposal-id'] || args.proposal_id || discoverLatestProposalId(policy), 160);
    if (!proposalId) {
        const out = { ok: false, type: 'self_mod_reversion_drill', error: 'proposal_id_required' };
        process.stdout.write(`${JSON.stringify(out)}\n`);
        process.exit(1);
    }
    const applyRequested = toBool(args.apply, false) && policy.shadow_only !== true;
    const started = Date.now();
    const rollback = runJson(policy.scripts.loop, [
        'rollback',
        `--proposal-id=${proposalId}`,
        `--reason=${cleanText(args.reason || 'monthly_reversion_drill', 140)}`,
        `--apply=${applyRequested ? '1' : '0'}`
    ], policy.timeout_ms);
    const elapsedMs = Date.now() - started;
    const rollbackOk = rollback.ok && !!rollback.payload && rollback.payload.ok === true;
    const withinSla = elapsedMs <= (Number(policy.sla_minutes || 0) * 60 * 1000);
    const out = {
        ok: rollbackOk && withinSla,
        type: 'self_mod_reversion_drill',
        ts: nowIso(),
        proposal_id: proposalId,
        shadow_only: policy.shadow_only === true,
        apply_requested: applyRequested,
        rollback_ok: rollbackOk,
        rollback_stage: rollback.payload && rollback.payload.stage ? rollback.payload.stage : null,
        rollback_receipt_id: rollback.payload && rollback.payload.receipt_id ? rollback.payload.receipt_id : null,
        elapsed_ms: elapsedMs,
        sla_minutes: Number(policy.sla_minutes || 0),
        within_sla: withinSla,
        freshness_days: Number(policy.freshness_days || 0),
        promotion_blocked: !(rollbackOk && withinSla),
        reason: rollbackOk
            ? (withinSla ? null : 'sla_exceeded')
            : String(rollback.stderr || rollback.stdout || 'rollback_failed').slice(0, 220)
    };
    writeJsonAtomic(policy.outputs.latest_path, out);
    appendJsonl(policy.outputs.receipts_path, out);
    process.stdout.write(`${JSON.stringify(out)}\n`);
    if (out.ok !== true)
        process.exit(1);
}
function cmdStatus(args) {
    const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
    const latest = readJson(policy.outputs.latest_path, null);
    const nowMs = Date.parse(nowIso());
    const latestMs = latest && latest.ts ? Date.parse(String(latest.ts)) : NaN;
    const ageDays = Number.isFinite(latestMs)
        ? Number(((nowMs - latestMs) / (24 * 60 * 60 * 1000)).toFixed(3))
        : null;
    const stale = ageDays == null ? true : ageDays > Number(policy.freshness_days || 0);
    const out = {
        ok: true,
        type: 'self_mod_reversion_drill_status',
        ts: nowIso(),
        policy: {
            version: policy.version,
            shadow_only: policy.shadow_only === true,
            sla_minutes: policy.sla_minutes,
            freshness_days: policy.freshness_days
        },
        latest: latest && typeof latest === 'object'
            ? {
                ts: latest.ts || null,
                proposal_id: latest.proposal_id || null,
                ok: latest.ok === true,
                elapsed_ms: Number(latest.elapsed_ms || 0),
                within_sla: latest.within_sla === true
            }
            : null,
        freshness: {
            stale,
            age_days: ageDays,
            promotion_blocked: stale || !(latest && latest.ok === true)
        },
        paths: {
            latest_path: relPath(policy.outputs.latest_path),
            receipts_path: relPath(policy.outputs.receipts_path)
        }
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
}
function usage() {
    console.log('Usage:');
    console.log('  node systems/autonomy/self_mod_reversion_drill.js run [--proposal-id=<id>] [--reason=<text>] [--apply=1|0] [--policy=path]');
    console.log('  node systems/autonomy/self_mod_reversion_drill.js status [--policy=path]');
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = normalizeToken(args._[0] || '', 64);
    if (!cmd || cmd === 'help' || args.help) {
        usage();
        process.exit(0);
    }
    if (cmd === 'run')
        return cmdRun(args);
    if (cmd === 'status')
        return cmdStatus(args);
    usage();
    process.exit(2);
}
if (require.main === module) {
    main();
}
module.exports = {
    loadPolicy,
    discoverLatestProposalId
};
