#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Rust cutover wrapper for protheusctl.
 *
 * Behavior-preserving entrypoint:
 * - keeps existing CLI path (`node systems/ops/protheusctl.js ...`)
 * - delegates dispatch/gating to Rust implementation in crates/ops
 */
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
function main() {
    const args = process.argv.slice(2);
    const cargoArgs = [
        'run',
        '--quiet',
        '--manifest-path',
        'crates/ops/Cargo.toml',
        '--bin',
        'protheus-ops',
        '--',
        'protheusctl',
        ...args
    ];
    const run = spawnSync('cargo', cargoArgs, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            PROTHEUS_NODE_BINARY: process.execPath || 'node'
        },
        stdio: 'inherit'
    });
    process.exit(Number.isFinite(run.status) ? run.status : 1);
}
main();
