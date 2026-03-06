#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const { parseArgs, normalizeToken, cleanText, emit } = require('../../lib/queued_backlog_runtime');
const {
  authorizeEgress,
  loadPolicy,
  loadState
} = require('../../lib/egress_gateway');

function parseCsv(raw: unknown) {
  const txt = cleanText(raw || '', 2000);
  if (!txt) return [];
  return txt.split(',').map((row: string) => cleanText(row, 160).toLowerCase()).filter(Boolean);
}

function usage() {
  console.log('Usage:');
  console.log('  node systems/security/egress_gateway.js authorize --scope=<id> --url=<https://...> [--method=GET] [--caller=id] [--runtime-allowlist=domain,domain] [--apply=1|0]');
  console.log('  node systems/security/egress_gateway.js status');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'status', 80) || 'status';
  if (args.help || cmd === 'help') {
    usage();
    emit({ ok: true, type: 'egress_gateway_help' }, 0);
  }

  if (cmd === 'status') {
    emit({
      ok: true,
      type: 'egress_gateway_status',
      policy: loadPolicy(),
      state: loadState()
    }, 0);
  }

  if (cmd === 'authorize') {
    const scope = cleanText(args.scope || '', 160);
    const url = cleanText(args.url || '', 2000);
    if (!scope || !url) {
      emit({ ok: false, type: 'egress_gateway_error', error: 'scope_and_url_required' }, 2);
    }
    const decision = authorizeEgress({
      scope,
      url,
      method: cleanText(args.method || 'GET', 20),
      caller: cleanText(args.caller || path.basename(__filename), 120),
      runtime_allowlist: parseCsv(args['runtime-allowlist'] || args.runtime_allowlist),
      apply: String(args.apply || '1') !== '0'
    });
    emit(decision, decision.allow ? 0 : 1);
  }

  emit({ ok: false, type: 'egress_gateway_error', error: 'unsupported_command', cmd }, 2);
}

main();
