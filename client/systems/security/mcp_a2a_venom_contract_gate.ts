#!/usr/bin/env node
'use strict';
export {};

/**
 * V3-RACE-176
 * Ensure MCP/A2A routes pass venom + contract-lane checks (fail closed).
 */

const path = require('path');
const { spawnSync } = require('child_process');
const {
  ROOT,
  cleanText,
  normalizeToken,
  toBool,
  readJson
} = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const POLICY_PATH = process.env.MCP_A2A_VENOM_CONTRACT_GATE_POLICY_PATH
  ? path.resolve(process.env.MCP_A2A_VENOM_CONTRACT_GATE_POLICY_PATH)
  : path.join(ROOT, 'config', 'mcp_a2a_venom_contract_gate_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/mcp_a2a_venom_contract_gate.js configure --owner=<owner_id>');
  console.log('  node systems/security/mcp_a2a_venom_contract_gate.js verify --owner=<owner_id> [--strict=1] [--mock=0|1] [--apply=1]');
  console.log('  node systems/security/mcp_a2a_venom_contract_gate.js status [--owner=<owner_id>]');
}

function runNode(script: string, args: string[], timeoutMs = 120000, mock = false) {
  if (mock) {
    return {
      ok: true,
      status: 0,
      stdout: '',
      stderr: '',
      payload: {
        ok: true,
        type: 'mock',
        script,
        args
      }
    };
  }
  const proc = spawnSync(process.execPath, [script, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: timeoutMs
  });
  const payload = parseJson(proc.stdout || '');
  return {
    ok: Number(proc.status || 0) === 0,
    status: Number.isFinite(proc.status) ? Number(proc.status) : 1,
    stdout: String(proc.stdout || ''),
    stderr: cleanText(proc.stderr || '', 400),
    payload
  };
}

function parseJson(stdout: string) {
  const txt = String(stdout || '').trim();
  if (!txt) return null;
  try { return JSON.parse(txt); } catch {}
  const lines = txt.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try { return JSON.parse(lines[i]); } catch {}
  }
  return null;
}

function routeSpecs(policy: any) {
  const routes = policy.routes && typeof policy.routes === 'object' ? policy.routes : {};
  const out = [];
  for (const [idRaw, rowRaw] of Object.entries(routes)) {
    const id = normalizeToken(idRaw, 80);
    const row = rowRaw && typeof rowRaw === 'object' ? rowRaw : {};
    const script = cleanText((row as any).script || '', 260);
    const args = Array.isArray((row as any).args) ? (row as any).args.map((arg: unknown) => cleanText(arg, 220)).filter(Boolean) : [];
    if (!id || !script || args.length < 1) continue;
    out.push({ id, script: path.isAbsolute(script) ? script : path.join(ROOT, script), args });
  }
  return out;
}

function contractLaneSpecs(policy: any) {
  const rows = Array.isArray(policy.contract_lanes) ? policy.contract_lanes : [];
  return rows
    .map((row: any) => ({
      id: normalizeToken(row && row.id, 40).toUpperCase(),
      script: cleanText(row && row.script, 260),
      check_cmd: normalizeToken(row && row.check_cmd || row && row.check || 'check', 40) || 'check'
    }))
    .filter((row: any) => row.id && row.script)
    .map((row: any) => ({
      ...row,
      script: path.isAbsolute(row.script) ? row.script : path.join(ROOT, row.script)
    }));
}

function venomArgs(ownerId: string, routeId: string) {
  return [
    'evaluate',
    `--session-id=mcp_a2a_${ownerId}_${routeId}`,
    '--source=interop',
    `--action=${routeId}`,
    '--risk=low',
    '--runtime-class=desktop',
    '--unauthorized=0',
    '--apply=0'
  ];
}

runStandardLane({
  lane_id: 'V3-RACE-176',
  script_rel: 'systems/security/mcp_a2a_venom_contract_gate.js',
  policy_path: POLICY_PATH,
  stream: 'security.mcp_a2a_venom_gate',
  paths: {
    memory_dir: 'memory/security/mcp_a2a_venom_contract_gate',
    adaptive_index_path: 'adaptive/security/mcp_a2a_venom_contract_gate/index.json',
    events_path: 'state/security/mcp_a2a_venom_contract_gate/events.jsonl',
    latest_path: 'state/security/mcp_a2a_venom_contract_gate/latest.json',
    receipts_path: 'state/security/mcp_a2a_venom_contract_gate/receipts.jsonl'
  },
  usage,
  handlers: {
    verify(policy: any, args: any, ctx: any) {
      const ownerId = normalizeToken(args.owner || args.owner_id, 120);
      if (!ownerId) return { ok: false, error: 'missing_owner' };

      const mock = toBool(args.mock, false);
      const strict = toBool(args.strict, true);
      const apply = toBool(args.apply, true);

      const venomScript = policy.venom_script
        ? path.isAbsolute(String(policy.venom_script)) ? String(policy.venom_script) : path.join(ROOT, String(policy.venom_script))
        : path.join(ROOT, 'systems', 'security', 'venom_containment_layer.js');

      const routes = routeSpecs(policy);
      const contractLanes = contractLaneSpecs(policy);
      const laneChecks = contractLanes.map((lane: any) => {
        const run = runNode(lane.script, [lane.check_cmd, '--strict=1'], 120000, mock);
        return {
          lane_id: lane.id,
          script: lane.script.replace(`${ROOT}/`, ''),
          ok: run.ok,
          status: run.status
        };
      });
      const allLanesOk = laneChecks.every((row: any) => row.ok === true);

      const routeRuns = routes.map((route: any) => {
        const routeRun = runNode(route.script, route.args, 120000, mock);
        const venomRun = runNode(venomScript, venomArgs(ownerId, route.id), 120000, mock);
        const pass = routeRun.ok === true && venomRun.ok === true && allLanesOk;
        return {
          route_id: route.id,
          script: route.script.replace(`${ROOT}/`, ''),
          route_ok: routeRun.ok,
          venom_ok: venomRun.ok,
          contract_lanes_ok: allLanesOk,
          pass,
          route_status: routeRun.status,
          venom_status: venomRun.status
        };
      });

      const failClosed = policy.fail_closed !== false;
      const allPass = routeRuns.length > 0 && routeRuns.every((row: any) => row.pass === true);
      const deniedRoutes = routeRuns.filter((row: any) => row.pass !== true).map((row: any) => row.route_id);

      const receipt = ctx.cmdRecord(policy, {
        ...args,
        event: 'mcp_a2a_venom_contract_gate_verify',
        apply,
        payload_json: JSON.stringify({
          owner_id: ownerId,
          strict,
          fail_closed: failClosed,
          route_count: routeRuns.length,
          all_contract_lanes_ok: allLanesOk,
          lane_checks: laneChecks,
          route_runs: routeRuns,
          denied_routes: deniedRoutes
        })
      });

      if (strict && failClosed && !allPass) {
        return {
          ...receipt,
          ok: false,
          error: 'interop_route_denied',
          denied_routes: deniedRoutes,
          all_contract_lanes_ok: allLanesOk
        };
      }

      return {
        ...receipt,
        routes_ok: allPass,
        denied_routes: deniedRoutes,
        all_contract_lanes_ok: allLanesOk
      };
    }
  }
});
