#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const crypto = require('crypto');
const { evaluateSecurityGate } = require('../security/rust_security_gate.js');
const ROOT = path.resolve(__dirname, '..', '..');
const MEMORY_MANIFEST = path.join(ROOT, 'crates', 'memory', 'Cargo.toml');
function cleanText(v, maxLen = 240) {
    return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
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
function stableHash(v, len = 24) {
    return crypto.createHash('sha256').update(String(v == null ? '' : v), 'utf8').digest('hex').slice(0, len);
}
function memorySecurityGateEnabled(opts = {}) {
    if (opts.security_gate_enabled === false)
        return false;
    const env = String(process.env.PROTHEUS_MEMORY_SECURITY_GATE || '').trim().toLowerCase();
    if (!env)
        return true;
    if (['0', 'false', 'no', 'off'].includes(env))
        return false;
    if (['1', 'true', 'yes', 'on'].includes(env))
        return true;
    return true;
}
function buildMemorySecurityRequest(command, args, opts = {}) {
    const digest = `sha256:${stableHash(JSON.stringify([command, ...(args || [])]), 32)}`;
    return {
        operation_id: cleanText(opts.operation_id || `memory_${command}_${stableHash(`${Date.now()}_${digest}`, 14)}`, 160),
        subsystem: 'memory',
        action: cleanText(command || 'memory_op', 80),
        actor: cleanText(opts.actor || 'systems/memory/index.ts', 120),
        risk_class: cleanText(opts.risk_class || 'normal', 40),
        payload_digest: digest,
        tags: ['memory', 'rust_core_v6', 'foundation_lock'],
        covenant_violation: Boolean(opts.covenant_violation),
        tamper_signal: Boolean(opts.tamper_signal),
        key_age_hours: Number.isFinite(Number(opts.key_age_hours)) ? Math.max(0, Number(opts.key_age_hours)) : 1,
        operator_quorum: Number.isFinite(Number(opts.operator_quorum)) ? Math.max(0, Number(opts.operator_quorum)) : 2,
        audit_receipt_nonce: cleanText(opts.audit_receipt_nonce || `nonce-${stableHash(`${digest}_${Date.now()}`, 12)}`, 120),
        zk_proof: cleanText(opts.zk_proof || 'zk-memory-default', 220),
        ciphertext_digest: cleanText(opts.ciphertext_digest || digest, 220)
    };
}
function evaluateMemorySecurityGate(command, args, opts = {}) {
    if (!memorySecurityGateEnabled(opts)) {
        return { ok: true, skipped: true, reason: 'memory_security_gate_disabled' };
    }
    const stateRoot = cleanText(opts.state_root
        || process.env.PROTHEUS_SECURITY_STATE_ROOT
        || path.join(ROOT, 'state'), 500);
    const request = buildMemorySecurityRequest(command, args, opts);
    const gate = evaluateSecurityGate(request, {
        enforce: opts.security_enforce !== false,
        state_root: stateRoot,
        allow_fallback: opts.security_allow_fallback !== false
    });
    if (!gate || gate.ok !== true) {
        return {
            ok: false,
            reason: cleanText(gate && gate.error || 'security_gate_execution_failed', 220),
            gate
        };
    }
    const payload = gate.payload && typeof gate.payload === 'object' ? gate.payload : {};
    const decision = payload.decision && typeof payload.decision === 'object' ? payload.decision : null;
    if (!decision || decision.ok !== true || decision.fail_closed === true) {
        const reason = Array.isArray(decision && decision.reasons) && decision.reasons.length
            ? cleanText(decision.reasons[0], 220)
            : 'security_gate_blocked';
        return {
            ok: false,
            reason,
            gate
        };
    }
    return {
        ok: true,
        gate
    };
}
function binaryCandidates() {
    const explicit = cleanText(process.env.PROTHEUS_MEMORY_CORE_BIN || '', 500);
    const out = [
        explicit,
        path.join(ROOT, 'target', 'release', 'memory-cli'),
        path.join(ROOT, 'target', 'debug', 'memory-cli'),
        path.join(ROOT, 'crates', 'memory', 'target', 'release', 'memory-cli'),
        path.join(ROOT, 'crates', 'memory', 'target', 'debug', 'memory-cli')
    ].filter(Boolean);
    return Array.from(new Set(out));
}
function runMemoryCli(command, args = [], timeoutMs = 180000, opts = {}) {
    const securityGate = evaluateMemorySecurityGate(command, args, opts);
    if (!securityGate.ok) {
        return {
            ok: false,
            engine: 'security_gate_fail_closed',
            error: `security_gate_blocked:${cleanText(securityGate.reason || 'deny', 220)}`,
            payload: null,
            security_gate: securityGate.gate || null
        };
    }
    for (const candidate of binaryCandidates()) {
        try {
            if (!fs.existsSync(candidate))
                continue;
            const out = spawnSync(candidate, [command, ...args], {
                cwd: ROOT,
                encoding: 'utf8',
                timeout: Math.max(1000, timeoutMs),
                maxBuffer: 10 * 1024 * 1024
            });
            const payload = parseJsonPayload(out.stdout);
            if (Number(out.status) === 0 && payload && typeof payload === 'object') {
                return { ok: true, engine: 'rust_bin', binary_path: candidate, payload, security_gate: securityGate.gate || null };
            }
        }
        catch {
            // continue
        }
    }
    const cargoArgs = [
        'run',
        '--quiet',
        '--manifest-path',
        MEMORY_MANIFEST,
        '--bin',
        'memory-cli',
        '--',
        command,
        ...args
    ];
    const out = spawnSync('cargo', cargoArgs, {
        cwd: ROOT,
        encoding: 'utf8',
        timeout: Math.max(1000, timeoutMs),
        maxBuffer: 10 * 1024 * 1024
    });
    const payload = parseJsonPayload(out.stdout);
    if (Number(out.status) === 0 && payload && typeof payload === 'object') {
        return { ok: true, engine: 'rust_cargo', payload, security_gate: securityGate.gate || null };
    }
    return {
        ok: false,
        error: `memory_cli_failed:${cleanText(out.stderr || out.stdout || '', 220)}`,
        security_gate: securityGate.gate || null
    };
}
function recall(query, limit = 5) {
    return runMemoryCli('recall', [`--query=${cleanText(query, 400)}`, `--limit=${Math.max(1, Number(limit) || 5)}`]);
}
function ingest(id, content, tags = [], repetitions = 1, lambda = 0.02) {
    const tagArg = (Array.isArray(tags) ? tags : []).map((v) => cleanText(v, 80)).filter(Boolean).join(',');
    return runMemoryCli('ingest', [
        `--id=${cleanText(id || `memory://${Date.now()}`, 160)}`,
        `--content=${cleanText(content, 4000)}`,
        `--tags=${tagArg}`,
        `--repetitions=${Math.max(1, Number(repetitions) || 1)}`,
        `--lambda=${Number.isFinite(Number(lambda)) ? Number(lambda) : 0.02}`
    ]);
}
function get(id) {
    return runMemoryCli('get', [`--id=${cleanText(id, 200)}`]);
}
function compress(aggressive = false) {
    return runMemoryCli('compress', [`--aggressive=${aggressive ? '1' : '0'}`]);
}
function ebbinghausScore(ageDays, repetitions = 1, lambda = 0.02) {
    return runMemoryCli('ebbinghaus-score', [
        `--age-days=${Number.isFinite(Number(ageDays)) ? Number(ageDays) : 0}`,
        `--repetitions=${Math.max(1, Number(repetitions) || 1)}`,
        `--lambda=${Number.isFinite(Number(lambda)) ? Number(lambda) : 0.02}`
    ]);
}
function crdtExchange(payload) {
    const encoded = JSON.stringify(payload && typeof payload === 'object' ? payload : { left: {}, right: {} });
    return runMemoryCli('crdt-exchange', [`--payload=${encoded}`]);
}
function loadEmbeddedHeartbeat() {
    return runMemoryCli('load-embedded-heartbeat');
}
function loadEmbeddedObservabilityProfile() {
    return runMemoryCli('load-embedded-observability-profile');
}
function loadEmbeddedVaultPolicy() {
    return runMemoryCli('load-embedded-vault-policy');
}
module.exports = {
    runMemoryCli,
    recall,
    ingest,
    get,
    compress,
    ebbinghausScore,
    crdtExchange,
    loadEmbeddedHeartbeat,
    loadEmbeddedObservabilityProfile,
    loadEmbeddedVaultPolicy
};
