#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Rust cutover wrapper for model_router.
 *
 * - Preserves CLI path (`node systems/routing/model_router.js ...`)
 * - Delegates CLI execution to Rust domain in `crates/ops`
 * - Re-exports legacy JS/TS module API for interop callers
 */
const path = require('path');
const { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..', '..');
const legacy = require('./model_router_legacy.js');
function runRustCli() {
    const args = process.argv.slice(2);
    const cargoArgs = [
        'run',
        '--quiet',
        '--manifest-path',
        'crates/ops/Cargo.toml',
        '--bin',
        'protheus-ops',
        '--',
        'model-router',
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
if (require.main === module) {
    runRustCli();
}
module.exports = legacy;
