#!/usr/bin/env node
'use strict';
export {};

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 80) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function parseArgs(argv: string[]) {
  const out: Record<string, any> = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const tok = String(argv[i] || '');
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const idx = tok.indexOf('=');
    if (idx >= 0) {
      out[tok.slice(2, idx)] = tok.slice(idx + 1);
      continue;
    }
    const key = tok.slice(2);
    const next = argv[i + 1];
    if (next != null && !String(next).startsWith('--')) {
      out[key] = String(next);
      i += 1;
      continue;
    }
    out[key] = true;
  }
  return out;
}

function usage() {
  console.log('Usage:');
  console.log('  protheus diagram [cli|personas|rsi] [--json=1]');
}

function buildDiagram(mode: string) {
  if (mode === 'personas') {
    return [
      'flowchart TD',
      '  Q[Query] --> L[protheus lens]',
      '  L --> C5[Core 5 personas]',
      '  C5 --> A[arbitration_rules.json]',
      '  A --> O[Structured recommendation]',
      '  O --> M[correspondence/feed memory]'
    ].join('\n');
  }
  if (mode === 'rsi') {
    return [
      'flowchart TD',
      '  P[Proposed self-change] --> G[Conclave gate]',
      '  G -->|pass| Apply[Apply change]',
      '  G -->|high risk| Escalate[Escalate to Monarch]',
      '  Apply --> Audit[Receipts + telemetry]'
    ].join('\n');
  }
  return [
    'flowchart TD',
    '  U[User] --> CLI[protheus CLI]',
    '  CLI --> Tools[research/assimilate/toolkit]',
    '  CLI --> Personas[lens/orchestrate]',
    '  CLI --> Ops[status/rust/suite]',
    '  Tools --> Memory[receipts + memory]',
    '  Personas --> Memory',
    '  Ops --> Memory'
  ].join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = normalizeToken(args.mode || args._[0] || 'cli', 40) || 'cli';
  if (args.help || mode === 'help' || mode === '--help' || mode === '-h') {
    usage();
    process.exit(0);
  }

  const mermaid = buildDiagram(mode);
  const payload = {
    ok: true,
    type: 'protheus_diagram',
    mode,
    mermaid
  };

  if (toBool(args.json ?? process.env.PROTHEUS_GLOBAL_JSON, false)) {
    process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${mermaid}\n`);
}

if (require.main === module) {
  main();
}
