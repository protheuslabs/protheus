#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');

const script = path.join(__dirname, 'protheus_control_plane.js');
const r = spawnSync('node', [script, 'top', ...process.argv.slice(2)], { encoding: 'utf8' });
if (r.stdout) process.stdout.write(r.stdout);
if (r.stderr) process.stderr.write(r.stderr);
process.exit(Number.isFinite(r.status) ? r.status : 1);
