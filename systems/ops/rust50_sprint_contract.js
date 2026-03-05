#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * V6-RUST50-CONF-002
 *
 * Sprint-mode enforcer + batch audit contract.
 * Enforces:
 * - Enforcer preamble acknowledgement before execution
 * - Single-batch ordered execution contract
 * - No-skip and no-premature-done rules
 * - End-of-sprint audit artifact
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { ROOT, nowIso, parseArgs, cleanText, normalizeToken, toBool, readJson, writeJsonAtomic, appendJsonl, resolvePath, stableHash, emit } = require('../../lib/queued_backlog_runtime');
const DEFAULT_POLICY_PATH = process.env.RUST50_SPRINT_CONTRACT_POLICY_PATH
    ? path.resolve(process.env.RUST50_SPRINT_CONTRACT_POLICY_PATH)
    : path.join(ROOT, 'config', 'rust50_sprint_contract_policy.json');
const EXECUTION_MANIFEST = path.join(ROOT, 'crates', 'execution', 'Cargo.toml');
function usage() {
    console.log('Usage:');
    console.log('  node systems/ops/rust50_sprint_contract.js run --sprint-id=<id> --batch-id=<id> [--plan-file=<path>|--plan-json=<json>] [--proof-refs=a,b] [--blockers=a,b] [--requested-status=in_progress|done] [--approval-recorded=1|0] [--enforcer-active=1|0] [--preamble-text=\"...\"] [--strict=1|0] [--apply=1|0]');
    console.log('  node systems/ops/rust50_sprint_contract.js status [--policy=<path>]');
}
function rel(absPath) {
    return path.relative(ROOT, absPath).replace(/\\/g, '/');
}
function normalizeList(v, maxLen = 260) {
    if (Array.isArray(v)) {
        return v.map((row) => cleanText(row, maxLen)).filter(Boolean);
    }
    const raw = cleanText(v || '', 8000);
    if (!raw)
        return [];
    return raw.split(',').map((row) => cleanText(row, maxLen)).filter(Boolean);
}
function parseJsonPayload(raw) {
    const text = String(raw == null ? '' : raw).trim();
    if (!text)
        return null;
    try {
        return JSON.parse(text);
    }
    catch { }
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
            return JSON.parse(lines[i]);
        }
        catch { }
    }
    return null;
}
function executionBinaryCandidates() {
    const explicit = cleanText(process.env.PROTHEUS_EXECUTION_RUST_BIN || '', 500);
    const out = [
        explicit,
        path.join(ROOT, 'target', 'release', 'execution_core'),
        path.join(ROOT, 'target', 'debug', 'execution_core'),
        path.join(ROOT, 'crates', 'execution', 'target', 'release', 'execution_core'),
        path.join(ROOT, 'crates', 'execution', 'target', 'debug', 'execution_core')
    ].filter(Boolean);
    return Array.from(new Set(out));
}
function runContractViaRust(payload) {
    const payloadText = JSON.stringify(payload && typeof payload === 'object' ? payload : {});
    const payloadB64 = Buffer.from(payloadText, 'utf8').toString('base64');
    for (const candidate of executionBinaryCandidates()) {
        try {
            if (!fs.existsSync(candidate))
                continue;
            const out = spawnSync(candidate, ['sprint-contract', `--payload-base64=${payloadB64}`], {
                cwd: ROOT,
                encoding: 'utf8',
                maxBuffer: 10 * 1024 * 1024
            });
            const parsed = parseJsonPayload(out.stdout);
            if (Number(out.status) === 0 && parsed && typeof parsed === 'object') {
                return { ok: true, engine: 'rust_bin', payload: parsed };
            }
        }
        catch {
            // continue to next candidate
        }
    }
    const out = spawnSync('cargo', [
        'run',
        '--quiet',
        '--manifest-path',
        EXECUTION_MANIFEST,
        '--bin',
        'execution_core',
        '--',
        'sprint-contract',
        `--payload-base64=${payloadB64}`
    ], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024
    });
    const parsed = parseJsonPayload(out.stdout);
    if (Number(out.status) === 0 && parsed && typeof parsed === 'object') {
        return { ok: true, engine: 'rust_cargo', payload: parsed };
    }
    return {
        ok: false,
        error: cleanText(out.stderr || out.stdout || 'rust_sprint_contract_failed', 260)
    };
}
function defaultPolicy() {
    return {
        version: '1.0',
        enabled: true,
        strict_default: true,
        sprint_id: 'V6-RUST50-CONF-002',
        accepted_preamble: 'ENFORCER RULES ACTIVE — READ codex_enforcer.md FIRST.',
        paths: {
            latest_path: 'state/ops/rust50_sprint_contract/latest.json',
            history_path: 'state/ops/rust50_sprint_contract/history.jsonl',
            audit_dir: 'state/ops/rust50_sprint_contract/audits'
        }
    };
}
function loadPolicy(policyPath = DEFAULT_POLICY_PATH) {
    const base = defaultPolicy();
    const raw = readJson(policyPath, {});
    const paths = raw.paths && typeof raw.paths === 'object' ? raw.paths : {};
    return {
        version: cleanText(raw.version || base.version, 24) || base.version,
        enabled: toBool(raw.enabled, true),
        strict_default: toBool(raw.strict_default, base.strict_default),
        sprint_id: cleanText(raw.sprint_id || base.sprint_id, 80) || base.sprint_id,
        accepted_preamble: cleanText(raw.accepted_preamble || base.accepted_preamble, 200) || base.accepted_preamble,
        paths: {
            latest_path: resolvePath(paths.latest_path, base.paths.latest_path),
            history_path: resolvePath(paths.history_path, base.paths.history_path),
            audit_dir: resolvePath(paths.audit_dir, base.paths.audit_dir)
        },
        policy_path: path.resolve(policyPath)
    };
}
function parsePlanFromArg(args) {
    const planFileRaw = args['plan-file'] ?? args.plan_file;
    if (planFileRaw) {
        const planFile = path.isAbsolute(String(planFileRaw))
            ? String(planFileRaw)
            : path.join(ROOT, String(planFileRaw));
        return readJson(planFile, null);
    }
    const planJsonRaw = args['plan-json'] ?? args.plan_json;
    if (planJsonRaw) {
        try {
            return JSON.parse(String(planJsonRaw));
        }
        catch {
            return null;
        }
    }
    if (args.tasks) {
        const rows = normalizeList(args.tasks, 320);
        const tasks = rows.map((row) => {
            const [idRaw, statusRaw] = String(row).split(':');
            return {
                id: normalizeToken(idRaw || '', 80) || 'task',
                status: normalizeToken(statusRaw || '', 40) || 'in_progress'
            };
        });
        return { tasks };
    }
    return null;
}
function normalizeTaskStatus(v) {
    const status = normalizeToken(v || '', 60);
    if (!status)
        return 'in_progress';
    if (status === 'done')
        return 'completed';
    return status;
}
function normalizePlan(rawPlan) {
    const plan = rawPlan && typeof rawPlan === 'object' ? rawPlan : {};
    const rawTasks = Array.isArray(plan.tasks) ? plan.tasks : [];
    const tasks = rawTasks
        .map((row, idx) => ({
        id: normalizeToken(row && row.id || `task_${idx + 1}`, 100) || `task_${idx + 1}`,
        title: cleanText(row && row.title || row && row.id || `Task ${idx + 1}`, 200),
        status: normalizeTaskStatus(row && row.status || 'in_progress')
    }));
    return {
        sprint_id: cleanText(plan.sprint_id || '', 80) || null,
        batch_mode: toBool(plan.batch_mode, true),
        tasks
    };
}
function summarizeTasks(tasks) {
    const counts = {};
    for (const task of tasks) {
        const k = normalizeTaskStatus(task.status);
        counts[k] = Number(counts[k] || 0) + 1;
    }
    return {
        total: tasks.length,
        by_status: counts
    };
}
function hasSkippedTasks(tasks) {
    return tasks.some((task) => normalizeTaskStatus(task.status) === 'skipped');
}
function validateOrderedExecution(tasks) {
    let firstNonCompletedSeen = false;
    for (const task of tasks) {
        const status = normalizeTaskStatus(task.status);
        const isCompleted = status === 'completed';
        if (!isCompleted)
            firstNonCompletedSeen = true;
        if (isCompleted && firstNonCompletedSeen) {
            return false;
        }
    }
    return true;
}
function runContract(policy, args) {
    const sprintId = cleanText(args['sprint-id'] || args.sprint_id || policy.sprint_id, 80) || policy.sprint_id;
    const batchId = normalizeToken(args['batch-id'] || args.batch_id || '', 120);
    const preambleText = cleanText(args['preamble-text'] || args.preamble_text || '', 220);
    const enforcerActive = toBool(args['enforcer-active'] ?? args.enforcer_active, false);
    const requestedStatus = normalizeToken(args['requested-status'] || args.requested_status || 'in_progress', 40) || 'in_progress';
    const approvalRecorded = toBool(args['approval-recorded'] ?? args.approval_recorded, false);
    const proofRefs = normalizeList(args['proof-refs'] || args.proof_refs || [], 320);
    const blockers = normalizeList(args.blockers || [], 320);
    const plan = normalizePlan(parsePlanFromArg(args));
    const taskSummary = summarizeTasks(plan.tasks);
    const checks = {
        enforcer_preamble_ack: enforcerActive && preambleText === policy.accepted_preamble,
        batch_id_present: !!batchId,
        single_batch_mode: plan.batch_mode === true,
        ordered_execution: validateOrderedExecution(plan.tasks),
        no_skip: plan.tasks.length > 0 && !hasSkippedTasks(plan.tasks),
        audit_artifact_ready: true
    };
    const allTasksCompleted = plan.tasks.length > 0 && plan.tasks.every((task) => normalizeTaskStatus(task.status) === 'completed');
    const noPrematureDone = requestedStatus !== 'done'
        || (allTasksCompleted && blockers.length === 0 && proofRefs.length > 0 && approvalRecorded === true);
    checks['no_premature_done'] = noPrematureDone;
    const violations = Object.entries(checks)
        .filter(([, ok]) => ok !== true)
        .map(([name]) => name);
    const contractOk = violations.length === 0;
    const effectiveStatus = contractOk
        ? (requestedStatus === 'done' ? 'DONE_READY_FOR_HUMAN_AUDIT' : 'IN_PROGRESS')
        : 'PAUSED';
    const now = nowIso();
    const auditSeed = `${sprintId}|${batchId}|${requestedStatus}|${taskSummary.total}|${violations.join(',')}|${proofRefs.join(',')}`;
    const auditId = `audit_${stableHash(auditSeed, 20)}`;
    const auditRow = {
        schema_id: 'rust50_sprint_contract_audit',
        schema_version: '1.0',
        type: 'rust50_sprint_contract',
        ts: now,
        ok: contractOk,
        sprint_id: sprintId,
        batch_id: batchId || null,
        requested_status: requestedStatus,
        effective_status: effectiveStatus,
        approval_recorded: approvalRecorded,
        enforcer: {
            active: enforcerActive,
            preamble_expected: policy.accepted_preamble,
            preamble_provided: preambleText
        },
        checks,
        violations,
        task_summary: taskSummary,
        tasks: plan.tasks,
        proof_refs: proofRefs,
        blockers,
        policy_path: rel(policy.policy_path),
        audit_id: auditId
    };
    return auditRow;
}
function cmdStatus(policy) {
    return {
        ok: true,
        type: 'rust50_sprint_contract_status',
        ts: nowIso(),
        policy_path: rel(policy.policy_path),
        latest: readJson(policy.paths.latest_path, null)
    };
}
function cmdRun(policy, args) {
    const strict = args.strict != null ? toBool(args.strict, policy.strict_default) : policy.strict_default;
    const apply = toBool(args.apply, true);
    const plan = normalizePlan(parsePlanFromArg(args));
    const rustPayload = {
        sprint_id: cleanText(args['sprint-id'] || args.sprint_id || policy.sprint_id, 80) || policy.sprint_id,
        batch_id: normalizeToken(args['batch-id'] || args.batch_id || '', 120),
        requested_status: normalizeToken(args['requested-status'] || args.requested_status || 'in_progress', 40) || 'in_progress',
        approval_recorded: toBool(args['approval-recorded'] ?? args.approval_recorded, false),
        enforcer_active: toBool(args['enforcer-active'] ?? args.enforcer_active, false),
        preamble_text: cleanText(args['preamble-text'] || args.preamble_text || '', 220),
        accepted_preamble: policy.accepted_preamble,
        proof_refs: normalizeList(args['proof-refs'] || args.proof_refs || [], 320),
        blockers: normalizeList(args.blockers || [], 320),
        strict,
        apply,
        policy_path: rel(policy.policy_path),
        plan
    };
    const rustRun = runContractViaRust(rustPayload);
    const out = rustRun.ok && rustRun.payload
        ? rustRun.payload
        : runContract(policy, args);
    if (rustRun.ok) {
        out.engine = rustRun.engine;
    }
    else {
        out.engine = 'ts_fallback';
        out.rust_error = rustRun.error || 'rust_run_failed';
    }
    out.strict = strict;
    out.apply = apply;
    if (apply) {
        const auditPath = path.join(policy.paths.audit_dir, `${out.audit_id}.json`);
        fs.mkdirSync(path.dirname(policy.paths.latest_path), { recursive: true });
        fs.mkdirSync(path.dirname(policy.paths.history_path), { recursive: true });
        fs.mkdirSync(policy.paths.audit_dir, { recursive: true });
        writeJsonAtomic(policy.paths.latest_path, out);
        writeJsonAtomic(auditPath, out);
        appendJsonl(policy.paths.history_path, out);
        out.audit_path = rel(auditPath);
    }
    return out;
}
function main() {
    const args = parseArgs(process.argv.slice(2));
    const cmd = normalizeToken(args._[0] || 'status', 60) || 'status';
    if (cmd === '--help' || cmd === '-h' || cmd === 'help') {
        usage();
        process.exit(0);
    }
    const policyPath = args.policy
        ? (path.isAbsolute(String(args.policy)) ? String(args.policy) : path.join(ROOT, String(args.policy)))
        : DEFAULT_POLICY_PATH;
    const policy = loadPolicy(policyPath);
    if (!policy.enabled)
        emit({ ok: false, error: 'rust50_sprint_contract_disabled' }, 1);
    if (cmd === 'status')
        emit(cmdStatus(policy), 0);
    if (cmd === 'run') {
        const out = cmdRun(policy, args);
        emit(out, out.strict && out.ok !== true ? 1 : 0);
    }
    usage();
    process.exit(1);
}
main();
