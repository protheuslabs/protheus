#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * rust50 migration bridge for idle_dream_cycle.
 * Rust owns the execution lane; legacy TS is an emergency fallback bridge.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const LEGACY_SCRIPT = path.join(ROOT, 'systems', 'memory', 'idle_dream_cycle_legacy.js');
const CRATE_MANIFEST = path.join(ROOT, 'systems', 'memory', 'rust', 'Cargo.toml');
const BIN_NAME = 'idle_dream_cycle';
function normalizedStatus(v) {
    return Number.isFinite(Number(v)) ? Number(v) : 1;
}
function resolveRustCommand(argv) {
    const explicitBin = String(process.env.PROTHEUS_IDLE_DREAM_RUST_BIN || '').trim();
    if (explicitBin && fs.existsSync(explicitBin)) {
        return [explicitBin, ...argv];
    }
    const releaseBin = path.join(ROOT, 'systems', 'memory', 'rust', 'target', 'release', process.platform === 'win32' ? `${BIN_NAME}.exe` : BIN_NAME);
    if (fs.existsSync(releaseBin)) {
        return [releaseBin, ...argv];
    }
    return ['cargo', 'run', '--quiet', '--manifest-path', CRATE_MANIFEST, '--bin', BIN_NAME, '--', ...argv];
}
function runCommand(command, extraEnv = {}) {
    const env = {
        ...process.env,
        ...extraEnv
    };
    const out = spawnSync(command[0], command.slice(1), {
        cwd: ROOT,
        env,
        stdio: 'inherit'
    });
    return normalizedStatus(out.status);
}
function main() {
    const argv = process.argv.slice(2);
    const rustStatus = runCommand(resolveRustCommand(argv));
    if (rustStatus === 0) {
        process.exit(0);
    }
    const allowLegacyFallback = String(process.env.PROTHEUS_MEMORY_LEGACY_FALLBACK || '1').trim() !== '0';
    if (!allowLegacyFallback) {
        process.exit(rustStatus);
    }
    const legacyStatus = runCommand([
        process.execPath,
        LEGACY_SCRIPT,
        ...argv
    ], {
        PROTHEUS_MEMORY_BRIDGE_FALLBACK: '1',
        PROTHEUS_MEMORY_BRIDGE_LANE: 'idle_dream_cycle',
        PROTHEUS_MEMORY_BRIDGE_RUST_STATUS: String(rustStatus)
    });
    process.exit(legacyStatus);
}
main();
