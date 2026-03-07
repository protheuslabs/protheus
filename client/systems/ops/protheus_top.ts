#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { spawnSync } = require('child_process');

function parseJson(text: string) {
  const raw = String(text || '').trim();
  if (!raw) return null;
  try { return JSON.parse(raw); } catch {}
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function run(script: string, args: string[]) {
  const r = spawnSync('node', [script, ...args], { encoding: 'utf8' });
  return {
    status: Number.isFinite(r.status) ? Number(r.status) : 1,
    stdout: String(r.stdout || ''),
    stderr: String(r.stderr || ''),
    payload: parseJson(String(r.stdout || ''))
  };
}

function main() {
  const argv = process.argv.slice(2);
  const mobile = argv.some((arg) => arg === '--mobile' || arg === 'mobile');
  const human = argv.some((arg) => arg === '--human' || arg === '--human=1' || arg === '--format=human');

  if (!mobile) {
    const script = path.join(__dirname, 'protheus_control_plane.js');
    const out = run(script, ['top', ...argv]);
    if (out.stdout) process.stdout.write(out.stdout);
    if (out.stderr) process.stderr.write(out.stderr);
    process.exit(out.status);
    return;
  }

  const mobileScript = path.join(__dirname, '..', 'edge', 'mobile_ops_top.js');
  const passthrough = argv.filter((arg) => arg !== '--mobile' && arg !== 'mobile' && arg !== '--human' && arg !== '--human=1' && arg !== '--format=human');
  const out = run(mobileScript, ['status', ...passthrough]);
  if (out.stderr) process.stderr.write(out.stderr);

  if (human && out.payload && out.payload.type === 'protheus_mobile_top') {
    const p = out.payload;
    console.log('MOBILE TOP');
    console.log(`edge active=${p.edge && p.edge.active ? 'yes' : 'no'} profile=${p.edge && p.edge.profile ? p.edge.profile : 'none'} online=${p.edge && p.edge.online ? 'yes' : 'no'} sync=${p.edge && p.edge.last_sync_at ? p.edge.last_sync_at : 'never'}`);
    console.log(`lifecycle action=${p.lifecycle && p.lifecycle.action ? p.lifecycle.action : 'unknown'} mode=${p.lifecycle && p.lifecycle.mode ? p.lifecycle.mode : 'unknown'} battery=${p.lifecycle && p.lifecycle.battery_pct != null ? p.lifecycle.battery_pct : 'n/a'} thermal=${p.lifecycle && p.lifecycle.thermal_c != null ? p.lifecycle.thermal_c : 'n/a'} survives_72h=${p.lifecycle && p.lifecycle.survives_72h_target ? 'yes' : 'no'}`);
    console.log(`swarm enrolled=${p.swarm ? Number(p.swarm.enrolled_nodes || 0) : 0} active=${p.swarm ? Number(p.swarm.active_nodes || 0) : 0} quarantined=${p.swarm ? Number(p.swarm.quarantined_nodes || 0) : 0}`);
    process.exit(out.status);
    return;
  }

  if (out.stdout) process.stdout.write(out.stdout);
  process.exit(out.status);
}

main();
