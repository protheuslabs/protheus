#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PERSONA_CLI = path.join(ROOT, 'systems', 'personas', 'cli.js');
const ORCHESTRATION_CLI = path.join(ROOT, 'systems', 'personas', 'orchestration.js');
const ASSIMILATE_CLI = path.join(ROOT, 'systems', 'tools', 'assimilate.js');
const RESEARCH_CLI = path.join(ROOT, 'systems', 'tools', 'research.js');
const DICTIONARY_MD = path.join(ROOT, 'docs', 'dictionary', 'dictionary.md');
const BLOB_DIR = path.join(ROOT, 'crates', 'memory', 'src', 'blobs');

type ParsedArgs = {
  _: string[];
  [k: string]: any;
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq >= 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
      continue;
    }
    const key = token.slice(2);
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

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function nowIso() {
  return new Date().toISOString();
}

function sha256HexFile(filePath: string) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function emit(payload: any, exitCode = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(exitCode);
}

function usage() {
  console.log('Usage:');
  console.log('  protheus toolkit list');
  console.log('  protheus toolkit personas [<persona args...>]');
  console.log('  protheus toolkit dictionary [list|show|term "<name>"]');
  console.log('  protheus toolkit orchestration [<orchestrate args...>]');
  console.log('  protheus toolkit blob-morphing [status|verify]');
  console.log('  protheus toolkit comment-mapper --persona=<id> --query="<text>" [--lens=decision|strategic|full] [--gap=<seconds>] [--active=1] [--intercept="<override>"] [--emotion=on|off] [--values=on|off]');
  console.log('  protheus toolkit assimilate <path|url> [--dry-run=1]');
  console.log('  protheus toolkit research "<query>" [--dry-run=1]');
}

function relayNode(script: string, args: string[], options: { forwardStdin?: boolean } = {}) {
  let childInput: any = undefined;
  let childStdio: any = undefined;
  if (options.forwardStdin) {
    if (process.stdin.isTTY) {
      childStdio = ['inherit', 'pipe', 'pipe'];
    } else {
      try {
        childInput = fs.readFileSync(0);
      } catch {
        childInput = undefined;
      }
    }
  }
  const proc = spawnSync('node', [script, ...args], {
    encoding: 'utf8',
    stdio: childStdio,
    input: childInput
  });
  if (proc.stdout) process.stdout.write(proc.stdout);
  if (proc.stderr) process.stderr.write(proc.stderr);
  process.exit(Number.isFinite(proc.status) ? Number(proc.status) : 1);
}

function parseDictionaryEntries(markdown: string) {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  const entries: Array<{ term: string, body: string }> = [];
  let current: { term: string, body: string[] } | null = null;
  for (const line of lines) {
    if (line.startsWith('## ')) {
      if (current) {
        entries.push({ term: current.term, body: current.body.join('\n').trim() });
      }
      current = { term: cleanText(line.slice(3), 200), body: [] };
      continue;
    }
    if (current) current.body.push(line);
  }
  if (current) entries.push({ term: current.term, body: current.body.join('\n').trim() });
  return entries;
}

function routeDictionary(rest: string[]) {
  const sub = String(rest[0] || 'list').trim().toLowerCase();
  if (!fs.existsSync(DICTIONARY_MD)) {
    emit({
      ok: false,
      type: 'cognitive_toolkit',
      tool: 'dictionary',
      error: 'dictionary_not_found',
      path: path.relative(ROOT, DICTIONARY_MD).replace(/\\/g, '/')
    }, 1);
  }
  const body = fs.readFileSync(DICTIONARY_MD, 'utf8');
  const entries = parseDictionaryEntries(body);
  if (sub === 'list' || sub === 'show' || !sub) {
    emit({
      ok: true,
      type: 'cognitive_toolkit',
      tool: 'dictionary',
      action: 'list',
      ts: nowIso(),
      path: path.relative(ROOT, DICTIONARY_MD).replace(/\\/g, '/'),
      terms: entries.map((entry) => entry.term)
    }, 0);
  }
  if (sub === 'term') {
    const requested = cleanText(rest.slice(1).join(' '), 200);
    if (!requested) {
      emit({ ok: false, type: 'cognitive_toolkit', tool: 'dictionary', error: 'term_required' }, 1);
    }
    const normalized = requested.toLowerCase();
    const hit = entries.find((entry) => entry.term.toLowerCase() === normalized);
    if (!hit) {
      emit({
        ok: false,
        type: 'cognitive_toolkit',
        tool: 'dictionary',
        error: 'term_not_found',
        term: requested,
        available_terms: entries.map((entry) => entry.term)
      }, 1);
    }
    emit({
      ok: true,
      type: 'cognitive_toolkit',
      tool: 'dictionary',
      action: 'term',
      ts: nowIso(),
      term: hit.term,
      path: path.relative(ROOT, DICTIONARY_MD).replace(/\\/g, '/'),
      body: hit.body
    }, 0);
  }
  emit({
    ok: false,
    type: 'cognitive_toolkit',
    tool: 'dictionary',
    error: `unknown_subcommand:${cleanText(sub, 40)}`
  }, 1);
}

function routeBlobMorphing(rest: string[]) {
  const sub = String(rest[0] || 'status').trim().toLowerCase();
  const files = [
    'heartbeat_sample.blob',
    'execution_replay.blob',
    'vault_policy.blob',
    'observability_profile.blob',
    'manifest.blob'
  ];
  const artifacts = files.map((name) => {
    const filePath = path.join(BLOB_DIR, name);
    if (!fs.existsSync(filePath)) {
      return {
        name,
        path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        exists: false,
        bytes: 0,
        sha256: null
      };
    }
    const stat = fs.statSync(filePath);
    return {
      name,
      path: path.relative(ROOT, filePath).replace(/\\/g, '/'),
      exists: true,
      bytes: stat.size,
      sha256: sha256HexFile(filePath)
    };
  });
  const manifestExists = artifacts.find((row) => row.name === 'manifest.blob')?.exists === true;
  const allPresent = artifacts.every((row) => row.exists);
  const nonEmpty = artifacts.every((row) => row.exists && row.bytes > 0);

  if (sub === 'status') {
    emit({
      ok: true,
      type: 'cognitive_toolkit',
      tool: 'blob-morphing',
      action: 'status',
      ts: nowIso(),
      manifest_exists: manifestExists,
      all_present: allPresent,
      all_non_empty: nonEmpty,
      artifacts
    }, 0);
  }
  if (sub === 'verify') {
    if (!manifestExists || !allPresent || !nonEmpty) {
      emit({
        ok: false,
        type: 'cognitive_toolkit',
        tool: 'blob-morphing',
        action: 'verify',
        error: 'blob_artifact_verification_failed',
        manifest_exists: manifestExists,
        all_present: allPresent,
        all_non_empty: nonEmpty,
        artifacts
      }, 1);
    }
    emit({
      ok: true,
      type: 'cognitive_toolkit',
      tool: 'blob-morphing',
      action: 'verify',
      ts: nowIso(),
      verification: 'manifest_present_all_blob_assets_non_empty',
      artifacts
    }, 0);
  }
  emit({
    ok: false,
    type: 'cognitive_toolkit',
    tool: 'blob-morphing',
    error: `unknown_subcommand:${cleanText(sub, 40)}`
  }, 1);
}

function routeCommentMapper(rest: string[]) {
  const args = parseArgs(rest);
  const persona = cleanText(args.persona || args._[0] || 'vikram_menon', 80) || 'vikram_menon';
  const query = cleanText(
    args.query || (args._.length > 1 ? args._.slice(1).join(' ') : ''),
    1000
  );
  if (!query) {
    emit({
      ok: false,
      type: 'cognitive_toolkit',
      tool: 'comment-mapper',
      error: 'query_required',
      hint: 'Use --query="<text>" or positional query text.'
    }, 1);
  }
  const routed: string[] = [persona];
  const lens = cleanText(args.lens || '', 20).toLowerCase();
  if (['decision', 'strategic', 'full'].includes(lens)) routed.push(lens);
  if (args.gap != null) routed.push(`--gap=${cleanText(args.gap, 10)}`);
  if (args.active != null) routed.push(`--active=${cleanText(args.active, 10)}`);
  if (args.intercept != null) routed.push(`--intercept=${cleanText(args.intercept, 600)}`);
  if (args.emotion != null) routed.push(`--emotion=${cleanText(args.emotion, 8)}`);
  if (args.values != null) routed.push(`--values=${cleanText(args.values, 8)}`);
  routed.push(query);
  relayNode(PERSONA_CLI, routed, { forwardStdin: true });
}

function toolManifest() {
  return [
    {
      id: 'personas',
      label: 'Personas',
      route: 'protheus toolkit personas',
      summary: 'Red-team and alignment lenses through persona CLI.'
    },
    {
      id: 'dictionary',
      label: 'Dictionary',
      route: 'protheus toolkit dictionary',
      summary: 'Novel concept glossary lookup and term retrieval.'
    },
    {
      id: 'orchestration',
      label: 'Orchestration',
      route: 'protheus toolkit orchestration',
      summary: 'Deterministic meeting/project control-plane operations.'
    },
    {
      id: 'blob-morphing',
      label: 'Blob Morphing',
      route: 'protheus toolkit blob-morphing',
      summary: 'Blob asset status + verification for fold/unfold surfaces.'
    },
    {
      id: 'comment-mapper',
      label: 'Comment Mapper',
      route: 'protheus toolkit comment-mapper',
      summary: 'Stream-of-thought mapping with optional intercept controls.'
    },
    {
      id: 'assimilate',
      label: 'Assimilate',
      route: 'protheus toolkit assimilate',
      summary: 'Ingest local/web source, run Core-5 review, and emit a Codex-ready sprint prompt.'
    },
    {
      id: 'research',
      label: 'Research',
      route: 'protheus toolkit research',
      summary: 'Run research organ + Core-5 arbitration for a natural-language query.'
    }
  ];
}

function main() {
  const rawArgv = process.argv.slice(2);
  const sub = String(rawArgv[0] || 'list').trim().toLowerCase();
  const rawRest = rawArgv.slice(1);
  const parsedRest = parseArgs(rawRest);

  if (sub === 'help' || sub === '--help' || sub === '-h') {
    usage();
    process.exit(0);
  }

  if (sub === 'list') {
    emit({
      ok: true,
      type: 'cognitive_toolkit',
      action: 'list',
      ts: nowIso(),
      guide: 'docs/cognitive_toolkit.md',
      tools: toolManifest()
    }, 0);
  }

  if (sub === 'personas') {
    const routed = rawRest.length ? rawRest : ['--list'];
    relayNode(PERSONA_CLI, routed, { forwardStdin: true });
  }

  if (sub === 'dictionary') {
    routeDictionary(parsedRest._);
  }

  if (sub === 'orchestration') {
    const routed = rawRest.length ? rawRest : ['status'];
    relayNode(ORCHESTRATION_CLI, routed, { forwardStdin: true });
  }

  if (sub === 'blob-morphing') {
    routeBlobMorphing(parsedRest._);
  }

  if (sub === 'comment-mapper') {
    routeCommentMapper(rawRest);
  }

  if (sub === 'assimilate') {
    const routed = rawRest.length ? rawRest : ['--help'];
    relayNode(ASSIMILATE_CLI, routed);
  }

  if (sub === 'research') {
    const routed = rawRest.length ? rawRest : ['--help'];
    relayNode(RESEARCH_CLI, routed);
  }

  emit({
    ok: false,
    type: 'cognitive_toolkit',
    error: `unknown_tool:${cleanText(sub, 60)}`,
    available_tools: toolManifest().map((tool) => tool.id)
  }, 1);
}

if (require.main === module) {
  main();
}
