#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_POLICY_PATH = process.env.SELF_IMPROVEMENT_CADENCE_POLICY_PATH
    ? path.resolve(process.env.SELF_IMPROVEMENT_CADENCE_POLICY_PATH)
    : path.join(ROOT, 'config', 'self_improvement_cadence_policy.json');
function nowIso() {
    return new Date().toISOString();
}
function todayStr() {
    return nowIso().slice(0, 10);
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
function normalizeList(v, fallback = []) {
    if (Array.isArray(v)) {
        const out = v.map((row) => cleanText(row, 320)).filter(Boolean);
        return out.length ? Array.from(new Set(out)) : fallback;
    }
    const raw = cleanText(v || '', 2000);
    if (!raw)
        return fallback;
    const out = raw.split(',').map((row) => cleanText(row, 320)).filter(Boolean);
    return out.length ? Array.from(new Set(out)) : fallback;
}
function runJson(scriptPath, args, timeoutMs) {
    const proc = spawnSync('node', [scriptPath, ...args], {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: Math.max(5000, timeoutMs)
    });
    const stdout = String(proc.stdout || '').trim();
    const stderr = String(proc.stderr || '').trim();
    let payload = null;
    if (stdout) {
        try {
            payload = JSON.parse(stdout);
        }
        catch {
            const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
            for (let i = lines.length - 1; i >= 0; i -= 1) {
                try {
                    payload = JSON.parse(lines[i]);
                    break;
                }
                catch {
                    // Keep scanning.
                }
            }
        }
    }
    return {
        ok: Number(proc.status || 0) === 0,
        status: Number(proc.status || 0),
        stdout: cleanText(stdout, 3000),
        stderr: cleanText(stderr, 3000),
        payload
    };
}
function defaultPolicy() {
    return {
        version: '1.0',
        enabled: true,
        shadow_first: true,
        cadence_minutes: 60,
        max_cycles_per_run: 1,
        proposal_cap_per_cycle: 2,
        apply_cap_per_cycle: 1,
        objective_id: 'continuum_self_improvement',
        target_paths: [
            'systems/autonomy/autonomy_controller.ts',
            'systems/spine/spine.ts'
        ],
        timeout_ms_per_step: 20000,
        quiet_hours: {
            enabled: false,
            start_hour_local: 22,
            end_hour_local: 7
        },
        budget_guard: {
            max_cycles_per_day: 24,
            max_proposals_per_day: 64,
            max_applies_per_day: 12
        },
        scripts: {
            observer: 'systems/autonomy/observer_mirror.js',
            loop: 'systems/autonomy/gated_self_improvement_loop.js',
            distiller: 'systems/assimilation/trajectory_skill_distiller.js'
        },
        outputs: {
            state_path: 'state/autonomy/self_improvement_cadence/state.json',
            latest_path: 'state/autonomy/self_improvement_cadence/latest.json',
            receipts_path: 'state/autonomy/self_improvement_cadence/receipts.jsonl'
        }
    };
}
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
    const src = readJson(policyPath, {});
    const base = defaultPolicy();
    const quietHours = src.quiet_hours && typeof src.quiet_hours === 'object' ? src.quiet_hours : {};
    const budgetGuard = src.budget_guard && typeof src.budget_guard === 'object' ? src.budget_guard : {};
    const scripts = src.scripts && typeof src.scripts === 'object' ? src.scripts : {};
    const outputs = src.outputs && typeof src.outputs === 'object' ? src.outputs : {};
    return {
        version: cleanText(src.version || base.version, 40) || base.version,
        enabled: src.enabled !== false,
        shadow_first: src.shadow_first !== false,
        cadence_minutes: clampInt(src.cadence_minutes, 1, 24 * 60, base.cadence_minutes),
        max_cycles_per_run: clampInt(src.max_cycles_per_run, 1, 64, base.max_cycles_per_run),
        proposal_cap_per_cycle: clampInt(src.proposal_cap_per_cycle, 1, 128, base.proposal_cap_per_cycle),
        apply_cap_per_cycle: clampInt(src.apply_cap_per_cycle, 0, 128, base.apply_cap_per_cycle),
        objective_id: normalizeToken(src.objective_id || base.objective_id, 140) || base.objective_id,
        target_paths: normalizeList(src.target_paths, base.target_paths),
        timeout_ms_per_step: clampInt(src.timeout_ms_per_step, 5000, 10 * 60 * 1000, base.timeout_ms_per_step),
        quiet_hours: {
            enabled: toBool(quietHours.enabled, base.quiet_hours.enabled),
            start_hour_local: clampInt(quietHours.start_hour_local, 0, 23, base.quiet_hours.start_hour_local),
            end_hour_local: clampInt(quietHours.end_hour_local, 0, 23, base.quiet_hours.end_hour_local)
        },
        budget_guard: {
            max_cycles_per_day: clampInt(budgetGuard.max_cycles_per_day, 1, 4096, base.budget_guard.max_cycles_per_day),
            max_proposals_per_day: clampInt(budgetGuard.max_proposals_per_day, 1, 4096, base.budget_guard.max_proposals_per_day),
            max_applies_per_day: clampInt(budgetGuard.max_applies_per_day, 0, 4096, base.budget_guard.max_applies_per_day)
        },
        scripts: {
            observer: resolvePath(scripts.observer || base.scripts.observer, base.scripts.observer),
            loop: resolvePath(scripts.loop || base.scripts.loop, base.scripts.loop),
            distiller: resolvePath(scripts.distiller || base.scripts.distiller, base.scripts.distiller)
        },
        outputs: {
            state_path: resolvePath(outputs.state_path || base.outputs.state_path, base.outputs.state_path),
            latest_path: resolvePath(outputs.latest_path || base.outputs.latest_path, base.outputs.latest_path),
            receipts_path: resolvePath(outputs.receipts_path || base.outputs.receipts_path, base.outputs.receipts_path)
        },
        policy_path: path.resolve(policyPath)
    };
}
function defaultState() {
    return {
        schema_id: 'self_improvement_cadence_state',
        schema_version: '1.0',
        updated_at: nowIso(),
        by_day: {},
        last_run: null
    };
}
function loadState(policy) {
    const src = readJson(policy.outputs.state_path, null);
    if (!src || typeof src !== 'object')
        return defaultState();
    return {
        schema_id: 'self_improvement_cadence_state',
        schema_version: '1.0',
        updated_at: cleanText(src.updated_at || nowIso(), 64),
        by_day: src.by_day && typeof src.by_day === 'object' ? src.by_day : {},
        last_run: src.last_run && typeof src.last_run === 'object' ? src.last_run : null
    };
}
function saveState(policy, state) {
    writeJsonAtomic(policy.outputs.state_path, {
        schema_id: 'self_improvement_cadence_state',
        schema_version: '1.0',
        updated_at: nowIso(),
        by_day: state.by_day && typeof state.by_day === 'object' ? state.by_day : {},
        last_run: state.last_run && typeof state.last_run === 'object' ? state.last_run : null
    });
}
function ensureDayCounters(state, dateStr) {
    if (!state.by_day || typeof state.by_day !== 'object')
        state.by_day = {};
    if (!state.by_day[dateStr] || typeof state.by_day[dateStr] !== 'object') {
        state.by_day[dateStr] = {
            cycles: 0,
            proposals: 0,
            applies: 0
        };
    }
    return state.by_day[dateStr];
}
function isInQuietHours(policy, nowDate) {
    if (policy.quiet_hours.enabled !== true)
        return false;
    const start = Number(policy.quiet_hours.start_hour_local || 0);
    const end = Number(policy.quiet_hours.end_hour_local || 0);
    const h = nowDate.getHours();
    if (start === end)
        return false;
    if (start < end)
        return h >= start && h < end;
    return h >= start || h < end;
}
function cmdRun(args) {
    const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
    if (policy.enabled !== true) {
        const out = { ok: false, type: 'self_improvement_cadence_run', error: 'policy_disabled' };
        process.stdout.write(`${JSON.stringify(out)}\n`);
        process.exit(1);
    }
    const dateStr = /^\d{4}-\d{2}-\d{2}$/.test(String(args._[1] || '')) ? String(args._[1]) : todayStr();
    const now = new Date(String(process.env.SELF_IMPROVEMENT_CADENCE_NOW_ISO || nowIso()));
    const state = loadState(policy);
    const day = ensureDayCounters(state, dateStr);
    const out = {
        ok: true,
        type: 'self_improvement_cadence_run',
        ts: nowIso(),
        date: dateStr,
        policy_version: policy.version,
        shadow_first: policy.shadow_first === true,
        cycles: [],
        skipped: false,
        skip_reason: null,
        counters_before: {
            cycles: Number(day.cycles || 0),
            proposals: Number(day.proposals || 0),
            applies: Number(day.applies || 0)
        }
    };
    if (isInQuietHours(policy, now)) {
        out.skipped = true;
        out.skip_reason = 'quiet_hours';
    }
    if (!out.skipped && Number(day.cycles || 0) >= Number(policy.budget_guard.max_cycles_per_day || 0)) {
        out.skipped = true;
        out.skip_reason = 'daily_cycle_cap_reached';
    }
    if (!out.skipped) {
        const maxCycles = clampInt(args['max-cycles'], 1, 128, policy.max_cycles_per_run);
        const applyRequested = toBool(args.apply, false) && policy.shadow_first !== true;
        for (let i = 0; i < maxCycles; i += 1) {
            if (Number(day.cycles || 0) >= Number(policy.budget_guard.max_cycles_per_day || 0))
                break;
            const cycle = {
                cycle_index: i + 1,
                observe: null,
                proposals: [],
                runs: [],
                distill: null
            };
            cycle.observe = runJson(policy.scripts.observer, ['run', dateStr, '--days=1'], policy.timeout_ms_per_step);
            const trajectory = [
                {
                    step: 'observe',
                    ok: cycle.observe.ok && !!cycle.observe.payload && cycle.observe.payload.ok === true
                }
            ];
            const targets = Array.isArray(policy.target_paths) ? policy.target_paths : [];
            for (const target of targets) {
                if (cycle.proposals.length >= Number(policy.proposal_cap_per_cycle || 0))
                    break;
                if (Number(day.proposals || 0) >= Number(policy.budget_guard.max_proposals_per_day || 0))
                    break;
                const propose = runJson(policy.scripts.loop, [
                    'propose',
                    `--objective-id=${policy.objective_id}`,
                    `--target-path=${target}`,
                    `--summary=self_improvement_cadence_${normalizeToken(target, 80) || 'target'}`,
                    '--risk=medium'
                ], policy.timeout_ms_per_step);
                const proposalId = propose.payload && propose.payload.proposal_id ? String(propose.payload.proposal_id) : null;
                cycle.proposals.push({
                    target_path: target,
                    ok: propose.ok && !!propose.payload && propose.payload.ok === true,
                    proposal_id: proposalId,
                    stderr: propose.stderr || null
                });
                trajectory.push({ step: 'propose', ok: propose.ok === true, target_path: target });
                if (proposalId)
                    day.proposals = Number(day.proposals || 0) + 1;
            }
            for (const row of cycle.proposals) {
                if (!row || !row.proposal_id)
                    continue;
                const allowApply = applyRequested
                    && cycle.runs.filter((r) => r && r.apply_requested === true).length < Number(policy.apply_cap_per_cycle || 0)
                    && Number(day.applies || 0) < Number(policy.budget_guard.max_applies_per_day || 0);
                const runOut = runJson(policy.scripts.loop, [
                    'run',
                    `--proposal-id=${row.proposal_id}`,
                    `--apply=${allowApply ? '1' : '0'}`
                ], policy.timeout_ms_per_step);
                const runOk = runOut.ok && !!runOut.payload && runOut.payload.ok === true;
                const applied = allowApply && runOk;
                if (applied)
                    day.applies = Number(day.applies || 0) + 1;
                cycle.runs.push({
                    proposal_id: row.proposal_id,
                    ok: runOk,
                    apply_requested: allowApply,
                    applied,
                    stage: runOut.payload && runOut.payload.stage ? runOut.payload.stage : null
                });
                trajectory.push({ step: 'simulate_gate_apply', ok: runOk, apply_requested: allowApply, applied });
            }
            trajectory.push({ step: 'distill_prepare', ok: true });
            cycle.distill = runJson(policy.scripts.distiller, [
                'distill',
                `--profile-id=cadence_${dateStr.replace(/-/g, '')}_${i + 1}`,
                `--trajectory-json=${JSON.stringify(trajectory)}`
            ], policy.timeout_ms_per_step);
            trajectory.push({ step: 'distill', ok: cycle.distill.ok && !!cycle.distill.payload && cycle.distill.payload.ok === true });
            out.cycles.push(cycle);
            day.cycles = Number(day.cycles || 0) + 1;
        }
    }
    out.cycles_executed = Array.isArray(out.cycles) ? out.cycles.length : 0;
    out.proposals_created = Array.isArray(out.cycles)
        ? out.cycles.reduce((acc, cycle) => acc + Number(Array.isArray(cycle.proposals) ? cycle.proposals.filter((r) => !!(r && r.proposal_id)).length : 0), 0)
        : 0;
    out.applies_executed = Array.isArray(out.cycles)
        ? out.cycles.reduce((acc, cycle) => acc + Number(Array.isArray(cycle.runs) ? cycle.runs.filter((r) => r && r.applied === true).length : 0), 0)
        : 0;
    out.counters_after = {
        cycles: Number(day.cycles || 0),
        proposals: Number(day.proposals || 0),
        applies: Number(day.applies || 0)
    };
    state.last_run = {
        ts: out.ts,
        date: dateStr,
        ok: out.ok === true,
        skipped: out.skipped === true,
        skip_reason: out.skip_reason || null,
        cycles_executed: out.cycles_executed,
        proposals_created: out.proposals_created,
        applies_executed: out.applies_executed
    };
    saveState(policy, state);
    writeJsonAtomic(policy.outputs.latest_path, out);
    appendJsonl(policy.outputs.receipts_path, out);
    process.stdout.write(`${JSON.stringify(out)}\n`);
}
function cmdStatus(args) {
    const policy = loadPolicy(args.policy ? path.resolve(String(args.policy)) : DEFAULT_POLICY_PATH);
    const state = loadState(policy);
    const latest = readJson(policy.outputs.latest_path, null);
    const out = {
        ok: true,
        type: 'self_improvement_cadence_status',
        ts: nowIso(),
        policy: {
            version: policy.version,
            shadow_first: policy.shadow_first === true,
            cadence_minutes: policy.cadence_minutes,
            max_cycles_per_run: policy.max_cycles_per_run,
            proposal_cap_per_cycle: policy.proposal_cap_per_cycle,
            apply_cap_per_cycle: policy.apply_cap_per_cycle
        },
        counters_today: state.by_day && state.by_day[todayStr()] ? state.by_day[todayStr()] : { cycles: 0, proposals: 0, applies: 0 },
        latest: latest && typeof latest === 'object'
            ? {
                ts: latest.ts || null,
                date: latest.date || null,
                skipped: latest.skipped === true,
                cycles_executed: Number(latest.cycles_executed || 0),
                proposals_created: Number(latest.proposals_created || 0),
                applies_executed: Number(latest.applies_executed || 0)
            }
            : null,
        paths: {
            state_path: relPath(policy.outputs.state_path),
            latest_path: relPath(policy.outputs.latest_path),
            receipts_path: relPath(policy.outputs.receipts_path)
        }
    };
    process.stdout.write(`${JSON.stringify(out)}\n`);
}
function usage() {
    console.log('Usage:');
    console.log('  node systems/autonomy/self_improvement_cadence_orchestrator.js run [YYYY-MM-DD] [--apply=1|0] [--max-cycles=N] [--policy=path]');
    console.log('  node systems/autonomy/self_improvement_cadence_orchestrator.js status [--policy=path]');
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
    loadState,
    saveState,
    isInQuietHours
};
