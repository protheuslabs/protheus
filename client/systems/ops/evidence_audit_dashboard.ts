#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { nowIso, toBool } = require('../../lib/queued_backlog_runtime');
const { runStandardLane } = require('../../lib/upgrade_lane_runtime');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const POLICY_PATH = process.env.EVIDENCE_AUDIT_DASHBOARD_POLICY_PATH
  ? path.resolve(process.env.EVIDENCE_AUDIT_DASHBOARD_POLICY_PATH)
  : path.join(__dirname, '..', '..', 'config', 'evidence_audit_dashboard_policy.json');

function usage() {
  console.log('Usage:');
  console.log('  node systems/ops/evidence_audit_dashboard.js run [--strict=1]');
  console.log('  node systems/ops/evidence_audit_dashboard.js export [--format=json|md]');
  console.log('  node systems/ops/evidence_audit_dashboard.js status');
}

function safeReadJson(absPath: string) {
  if (!fs.existsSync(absPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(absPath, 'utf8'));
  } catch {
    return null;
  }
}

function claimStatus(claim: any) {
  const evidence = Array.isArray(claim.evidence) ? claim.evidence : [];
  const checks = evidence.map((relPath: string) => {
    const abs = path.isAbsolute(relPath) ? relPath : path.join(ROOT, relPath);
    const json = safeReadJson(abs);
    const ok = fs.existsSync(abs) && (json == null || json.ok !== false);
    return {
      path: relPath,
      exists: fs.existsSync(abs),
      ok,
      receipt_type: json && typeof json === 'object' ? String(json.type || json.schema_id || '') : ''
    };
  });
  const pass = checks.length > 0 && checks.every((row: any) => row.ok === true);
  return {
    id: String(claim.id || 'unknown_claim'),
    pass,
    checks
  };
}

function renderMarkdown(snapshot: any) {
  const lines = [
    '# Evidence Audit Dashboard Export',
    '',
    `- Generated: ${snapshot.ts}`,
    `- Total claims: ${snapshot.summary.total}`,
    `- Passing claims: ${snapshot.summary.passing}`,
    `- Failing claims: ${snapshot.summary.failing}`,
    '',
    '## Claim Drilldown'
  ];

  for (const claim of snapshot.claims || []) {
    lines.push('');
    lines.push(`### ${claim.id}`);
    lines.push(`- pass: ${claim.pass}`);
    for (const check of claim.checks || []) {
      lines.push(`- ${check.path} | exists=${check.exists} | ok=${check.ok} | receipt_type=${check.receipt_type || 'n/a'}`);
    }
  }
  lines.push('');
  return `${lines.join('\n')}\n`;
}

function loadPolicyExtras(policyPath: string) {
  try {
    const raw = JSON.parse(String(fs.readFileSync(policyPath, 'utf8') || '{}'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

runStandardLane({
  lane_id: 'V6-COMP-003',
  script_rel: 'systems/ops/evidence_audit_dashboard.js',
  policy_path: POLICY_PATH,
  stream: 'ops.evidence_audit_dashboard',
  paths: {
    memory_dir: 'client/local/state/ops/evidence_audit_dashboard/memory',
    adaptive_index_path: 'client/local/adaptive/ops/evidence_audit_dashboard/index.json',
    events_path: 'client/local/state/ops/evidence_audit_dashboard/events.jsonl',
    latest_path: 'client/local/state/ops/evidence_audit_dashboard/latest.json',
    receipts_path: 'client/local/state/ops/evidence_audit_dashboard/receipts.jsonl',
    export_json_path: 'client/local/state/ops/evidence_audit_dashboard/export.json',
    export_md_path: 'client/local/state/ops/evidence_audit_dashboard/export.md'
  },
  usage,
  handlers: {
    run(policy: any, args: any, ctx: any) {
      const extras = loadPolicyExtras(String(policy.policy_path || POLICY_PATH));
      const claimsRaw = Array.isArray(extras.claims) ? extras.claims : [];
      const claims = claimsRaw.map(claimStatus);
      const passing = claims.filter((row: any) => row.pass).length;
      const snapshot = {
        schema_id: 'evidence_audit_dashboard_snapshot_v1',
        ts: nowIso(),
        strict: toBool(args.strict, policy.strict_default !== false),
        claims,
        summary: {
          total: claims.length,
          passing,
          failing: claims.length - passing
        }
      };
      if (policy.paths.export_json_path) {
        fs.mkdirSync(path.dirname(policy.paths.export_json_path), { recursive: true });
        fs.writeFileSync(policy.paths.export_json_path, `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
      }
      if (policy.paths.export_md_path) {
        fs.mkdirSync(path.dirname(policy.paths.export_md_path), { recursive: true });
        fs.writeFileSync(policy.paths.export_md_path, renderMarkdown(snapshot), 'utf8');
      }
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'evidence_audit_dashboard_run',
        payload_json: JSON.stringify(snapshot)
      });
    },
    export(policy: any, args: any, ctx: any) {
      const latest = safeReadJson(policy.paths.latest_path) || {};
      const format = String(args.format || 'json').toLowerCase();
      if (format === 'md') {
        const markdown = renderMarkdown((latest && latest.payload) || { ts: nowIso(), claims: [], summary: { total: 0, passing: 0, failing: 0 } });
        fs.mkdirSync(path.dirname(policy.paths.export_md_path), { recursive: true });
        fs.writeFileSync(policy.paths.export_md_path, markdown, 'utf8');
      } else {
        fs.mkdirSync(path.dirname(policy.paths.export_json_path), { recursive: true });
        fs.writeFileSync(policy.paths.export_json_path, `${JSON.stringify(latest, null, 2)}\n`, 'utf8');
      }
      return ctx.cmdRecord(policy, {
        ...args,
        event: 'evidence_audit_dashboard_export',
        payload_json: JSON.stringify({
          format,
          export_json_path: policy.paths.export_json_path,
          export_md_path: policy.paths.export_md_path
        })
      });
    }
  }
});
