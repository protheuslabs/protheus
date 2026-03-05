#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Rust cutover wrapper for runtime_efficiency_floor.
 *
 * Behavior-preserving entrypoint:
 * - keeps existing CLI path (`node systems/ops/runtime_efficiency_floor.js ...`)
 * - delegates execution to Rust implementation in crates/ops
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
        'runtime-efficiency-floor',
        ...args
    ];
    const run = spawnSync('cargo', cargoArgs, {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
            ...process.env,
            PROTHEUS_NODE_BINARY: process.execPath || 'node'
        }
    });
    if (run.stdout)
        process.stdout.write(run.stdout);
    if (run.stderr)
        process.stderr.write(run.stderr);
    process.exit(Number.isFinite(run.status) ? run.status : 1);
}
main();
