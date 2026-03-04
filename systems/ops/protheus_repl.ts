#!/usr/bin/env node
'use strict';
export {};

const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');
const { colorize, supportsColor } = require('./cli_ui.js');
const { buildManifest } = require('./protheus_command_list.js');

const ROOT = path.resolve(__dirname, '..', '..');
const PROTHEUS_BIN = path.join(ROOT, 'bin', 'protheus');

function cleanText(v: unknown, maxLen = 400) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function parseTokens(line: string) {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

async function ask(rl: readline.Interface, label: string, fallback = '') {
  const prompt = `${label}${fallback ? ` (${fallback})` : ''}: `;
  return await new Promise<string>((resolve) => {
    rl.question(prompt, (value) => {
      const picked = cleanText(value, 800);
      resolve(picked || fallback);
    });
  });
}

async function maybeWizard(tokens: string[], rl: readline.Interface) {
  if (!tokens.length) return tokens;
  if (tokens[0] === 'orchestrate' && tokens[1] === 'project' && tokens.length <= 2) {
    const name = await ask(rl, 'Project name');
    const goal = await ask(rl, 'Project goal');
    if (!name || !goal) return tokens;
    return ['orchestrate', 'project', name, goal];
  }
  if (tokens[0] === 'assimilate' && tokens.length <= 1) {
    const target = await ask(rl, 'Path or URL to assimilate');
    if (!target) return tokens;
    return ['assimilate', target];
  }
  if (tokens[0] === 'research' && tokens.length <= 1) {
    const query = await ask(rl, 'Research query');
    if (!query) return tokens;
    return ['research', query];
  }
  return tokens;
}

function runCommand(args: string[]) {
  const run = spawnSync(PROTHEUS_BIN, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      PROTHEUS_REPL_ACTIVE: '1'
    }
  });
  if (run.stdout) process.stdout.write(run.stdout);
  if (run.stderr) process.stderr.write(run.stderr);
  return Number.isFinite(run.status) ? Number(run.status) : 1;
}

function showHelp() {
  const title = supportsColor() ? colorize('accent', 'Protheus Interactive Mode') : 'Protheus Interactive Mode';
  process.stdout.write(`${title}\n`);
  process.stdout.write('Commands: help, list, exit, quit\n');
  process.stdout.write('Tip: type full CLI commands, e.g. `research "creating a quant trading software"`\n');
}

async function main() {
  const manifest = buildManifest();
  const commands = Array.from(new Set(
    (manifest.categories || [])
      .flatMap((category: any) => (category.commands || []).map((row: any) => cleanText(row.command, 80)))
      .filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  showHelp();
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'protheus> '
  });

  rl.prompt();
  rl.on('line', async (line: string) => {
    const raw = cleanText(line, 2000);
    if (!raw) {
      rl.prompt();
      return;
    }

    const token = raw.toLowerCase();
    if (token === 'exit' || token === 'quit') {
      rl.close();
      return;
    }
    if (token === 'help') {
      showHelp();
      rl.prompt();
      return;
    }
    if (token === 'list') {
      runCommand(['list']);
      rl.prompt();
      return;
    }

    let tokens = parseTokens(raw);
    tokens = await maybeWizard(tokens, rl);
    if (!tokens.length) {
      rl.prompt();
      return;
    }
    if (!commands.includes(tokens[0])) {
      process.stderr.write(`Unknown command in REPL: ${tokens[0]}. Try \`list\`.\n`);
      rl.prompt();
      return;
    }
    runCommand(tokens);
    rl.prompt();
  });

  rl.on('close', () => {
    process.stdout.write('Exiting Protheus interactive mode.\n');
    process.exit(0);
  });
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`repl_error:${cleanText(err && err.message, 220)}\n`);
    process.exit(1);
  });
}
