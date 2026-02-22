#!/usr/bin/env node
'use strict';

/**
 * proposal_template.js
 *
 * Emit proposal JSON templates that can be ingested by sensory_queue
 * and selected by autonomy for generic actuation execution.
 *
 * Usage:
 *   node systems/actuation/proposal_template.js generic --kind=<adapter_id> [--params='{"k":"v"}'] --title="..."
 *   node systems/actuation/proposal_template.js --help
 */

const crypto = require('crypto');

function nowIso() { return new Date().toISOString(); }
function todayStr() { return nowIso().slice(0, 10); }

function usage() {
  console.log('Usage:');
  console.log('  node systems/actuation/proposal_template.js generic --kind=<adapter_id> --title="..." [--params=\'{"k":"v"}\']');
  console.log('  node systems/actuation/proposal_template.js --help');
}

function parseArgs(argv) {
  const out = { _: [] } as Record<string, any>;
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const i = a.indexOf('=');
    if (i === -1) out[a.slice(2)] = true;
    else out[a.slice(2, i)] = a.slice(i + 1);
  }
  return out;
}

function safeJson(raw, fallback) {
  try { return JSON.parse(String(raw || '')); } catch { return fallback; }
}

function mkProposalId(prefix, title) {
  const h = crypto.createHash('sha256').update(`${prefix}|${title}|${nowIso()}`).digest('hex').slice(0, 16);
  return `ACT-${h}`;
}

function baseProposal({ id, title, kind, params }) {
  const ts = nowIso();
  return {
    id,
    type: 'actuation_task',
    title,
    summary: `Actuation request via adapter ${kind}`,
    expected_impact: 'medium',
    risk: 'medium',
    suggested_next_command: `node systems/actuation/actuation_executor.js run --kind=${kind} --params='<json>'`,
    evidence: [
      {
        source: 'actuation_template',
        evidence_ref: 'actuation:template',
        path: `state/sensory/proposals/${todayStr()}.json`,
        title: `Template for ${kind}`
      }
    ],
    meta: {
      source_eye: 'manual_actuation',
      collected_at: ts,
      relevance_score: 70,
      relevance_tier: 'medium',
      signal_quality_score: 70,
      signal_quality_tier: 'medium',
      directive_fit_score: 70,
      directive_fit_pass: true,
      actionability_score: 80,
      actionability_pass: true,
      actuation: {
        kind,
        params
      }
    }
  };
}

function cmdGeneric(args) {
  const kind = String(args.kind || '').trim();
  const title = String(args.title || '').trim();
  const params = safeJson(args.params, null);
  if (!kind || !title) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'generic requires --kind and --title' }) + '\n');
    process.exit(2);
  }
  if (params == null && args.params != null) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'invalid --params JSON' }) + '\n');
    process.exit(2);
  }
  const p = baseProposal({
    id: mkProposalId(kind, title),
    title: `[Actuation:${kind}] ${title}`.slice(0, 120),
    kind,
    params: params || {}
  });
  process.stdout.write(JSON.stringify({ ok: true, date: todayStr(), proposal: p }, null, 2) + '\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || '';
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }
  if (cmd === 'generic') return cmdGeneric(args);
  usage();
  process.exit(2);
}

main();
export {};
