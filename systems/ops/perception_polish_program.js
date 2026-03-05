#!/usr/bin/env node
'use strict';
Object.defineProperty(exports, "__esModule", { value: true });
/**
 * Rust cutover wrapper for perception_polish_program.
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
        'perception-polish-program',
        ...args
    ];
    const run = spawnSync('cargo', cargoArgs, {
        cwd: ROOT,
        encoding: 'utf8',
        stdio: 'inherit',
        env: {
            ...process.env,
            PROTHEUS_NODE_BINARY: process.execPath || 'node'
        }
    });
    process.exit(Number.isFinite(run.status) ? run.status : 1);
}
main();
