#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PERSONAS_DIR = path.join(ROOT, 'personas');
const { buildManifest } = require('./protheus_command_list.js');

type AnyObj = Record<string, any>;
type CompletionMeta = {
  subcommands: string[],
  flags: string[]
};

function usage() {
  console.log('Usage:');
  console.log('  protheus completion <bash|zsh|fish>');
  console.log('  protheus completion <bash|zsh|fish> --install-path=<path>');
  console.log('');
  console.log('Examples:');
  console.log('  protheus completion bash > ~/.local/share/bash-completion/completions/protheus');
  console.log('  protheus completion zsh > ~/.zfunc/_protheus');
  console.log('  protheus completion fish > ~/.config/fish/completions/protheus.fish');
}

function cleanText(v: unknown, maxLen = 300) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function parseArgs(argv: string[]) {
  const out: AnyObj = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const idx = token.indexOf('=');
    if (idx >= 0) {
      out[token.slice(2, idx)] = token.slice(idx + 1);
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

function listPersonas() {
  try {
    return fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
      .filter((entry: any) => entry && entry.isDirectory && entry.isDirectory())
      .map((entry: any) => String(entry.name || ''))
      .filter((name: string) => fs.existsSync(path.join(PERSONAS_DIR, name, 'profile.md')))
      .sort((a: string, b: string) => a.localeCompare(b));
  } catch {
    return [];
  }
}

const GLOBAL_FLAGS = ['--json', '--quiet', '--help', '--version', '--example'];

function completionMetadata(): Record<string, CompletionMeta> {
  return {
    completion: { subcommands: ['bash', 'zsh', 'fish'], flags: ['--install-path='] },
    status: { subcommands: ['raw'], flags: ['--json=1'] },
    debug: { subcommands: [], flags: ['--json=1', '--deep=1'] },
    setup: { subcommands: ['run', 'status', 'should-run'], flags: ['--skip=1', '--force=1', '--json=1'] },
    orchestrate: { subcommands: ['meeting', 'project', 'status', 'telemetry', 'audit', 'prune'], flags: ['--json=1', '--emotion=on', '--emotion=off'] },
    shadow: { subcommands: ['list', 'arise', 'pause', 'review', 'status'], flags: ['--json=1', '--reason=', '--note='] },
    tutorial: { subcommands: ['status', 'on', 'off'], flags: ['--json=1'] },
    toolkit: { subcommands: ['list', 'personas', 'dictionary', 'orchestration', 'blob-morphing', 'comment-mapper', 'assimilate', 'research'], flags: ['--json=1'] },
    diagram: { subcommands: ['cli', 'personas', 'rsi'], flags: ['--json=1'] },
    version: { subcommands: [], flags: ['--json=1'] },
    update: { subcommands: [], flags: ['--json=1', '--apply=1'] },
    demo: { subcommands: [], flags: ['--json=1'] },
    examples: { subcommands: [], flags: ['--json=1', '--command='] },
    assimilate: { subcommands: [], flags: ['--dry-run=1', '--apply=1', '--json=1'] },
    research: { subcommands: [], flags: ['--dry-run=1', '--json=1'] },
    lens: {
      subcommands: [],
      flags: [
        '--emotion=on',
        '--emotion=off',
        '--schema=json',
        '--surprise=on',
        '--surprise=off',
        '--include-feed',
        '--gap=10'
      ]
    },
    persona: { subcommands: ['feed', 'checkin', 'update-stream', 'list'], flags: ['--json=1'] },
    arbitrate: { subcommands: [], flags: ['--between=', '--issue=', '--json=1'] }
  };
}

function bashCase(meta: Record<string, CompletionMeta>) {
  const lines: string[] = [];
  const entries = Object.entries(meta).sort((a, b) => a[0].localeCompare(b[0]));
  for (const [cmd, row] of entries) {
    const sub = row.subcommands.join(' ');
    const flags = Array.from(new Set([...GLOBAL_FLAGS, ...row.flags])).join(' ');
    lines.push(`    ${cmd})`);
    lines.push('      if [[ "${cur}" == --* ]]; then');
    lines.push('        COMPREPLY=( $(compgen -W "' + flags + '" -- "${cur}") )');
    lines.push('        return 0');
    lines.push('      fi');
    if (sub) {
      lines.push('      if [[ ${COMP_CWORD} -eq 2 ]]; then');
      lines.push('        COMPREPLY=( $(compgen -W "' + sub + '" -- "${cur}") )');
      lines.push('        return 0');
      lines.push('      fi');
    }
    lines.push('      ;;');
  }
  return lines;
}

function buildBashScript(commands: string[], personas: string[], meta: Record<string, CompletionMeta>) {
  const commandList = commands.join(' ');
  const personaList = personas.join(' ');
  const globalFlags = GLOBAL_FLAGS.join(' ');
  return [
    '# bash completion for protheus',
    '_protheus_complete() {',
    '  local cur prev',
    '  cur="${COMP_WORDS[COMP_CWORD]}"',
    '  prev="${COMP_WORDS[COMP_CWORD-1]}"',
    `  local commands="${commandList}"`,
    `  local personas="${personaList}"`,
    `  local global_flags="${globalFlags}"`,
    '  if [[ ${COMP_CWORD} -eq 1 ]]; then',
    '    COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )',
    '    return 0',
    '  fi',
    '  if [[ "${cur}" == --* ]]; then',
    '    COMPREPLY=( $(compgen -W "${global_flags}" -- "${cur}") )',
    '    return 0',
    '  fi',
    '  case "${COMP_WORDS[1]}" in',
    '    lens)',
    '      if [[ ${COMP_CWORD} -eq 2 && "${cur}" != --* ]]; then',
    '      COMPREPLY=( $(compgen -W "${personas}" -- "${cur}") )',
    '      return 0',
    '      fi',
    '      ;;',
    ...bashCase(meta),
    '  esac',
    '  return 0',
    '}',
    'complete -F _protheus_complete protheus',
    ''
  ].join('\n');
}

function buildZshScript(commands: string[], personas: string[], meta: Record<string, CompletionMeta>) {
  const commandSpec = commands.map((cmd) => `"${cmd}:${cmd} command"`).join(' ');
  const personaSpec = personas.map((persona) => `"${persona}:persona"`).join(' ');
  const lines: string[] = [
    '#compdef protheus',
    '',
    '_protheus() {',
    '  local -a command_descriptions',
    '  local -a persona_descriptions',
    `  command_descriptions=(${commandSpec})`,
    `  persona_descriptions=(${personaSpec})`,
    '  local -a global_flags',
    `  global_flags=(${GLOBAL_FLAGS.map((flag) => `"${flag}:${flag}"`).join(' ')})`,
    '  if (( CURRENT == 2 )); then',
    "    _describe 'command' command_descriptions",
    '    return 0',
    '  fi',
    '  if [[ "${words[CURRENT]}" == --* ]]; then',
    "    _describe 'flag' global_flags",
    '    return 0',
    '  fi',
    '  case "${words[2]}" in',
    '    lens)',
    '      if (( CURRENT == 3 )) && [[ "${words[CURRENT]}" != --* ]]; then',
    "        _describe 'persona' persona_descriptions",
    '        return 0',
    '      fi',
    '      ;;'
  ];
  for (const [cmd, row] of Object.entries(meta).sort((a, b) => a[0].localeCompare(b[0]))) {
    const subSpec = row.subcommands.map((sub) => `"${sub}:${sub}"`).join(' ');
    const flagSpec = Array.from(new Set([...GLOBAL_FLAGS, ...row.flags]))
      .map((flag) => `"${flag}:${flag}"`)
      .join(' ');
    lines.push(`    ${cmd})`);
    lines.push('      if [[ "${words[CURRENT]}" == --* ]]; then');
    lines.push(`        local -a local_flags; local_flags=(${flagSpec})`);
    lines.push("        _describe 'flag' local_flags");
    lines.push('        return 0');
    lines.push('      fi');
    if (subSpec) {
      lines.push('      if (( CURRENT == 3 )); then');
      lines.push(`        local -a local_subs; local_subs=(${subSpec})`);
      lines.push("        _describe 'subcommand' local_subs");
      lines.push('        return 0');
      lines.push('      fi');
    }
    lines.push('      ;;');
  }
  lines.push('  esac');
  lines.push('}');
  lines.push('');
  lines.push('_protheus "$@"');
  lines.push('');
  return lines.join('\n');
}

function fishConditionForSubcommands(command: string) {
  return `__fish_seen_subcommand_from ${command}`;
}

function buildFishScript(commands: string[], personas: string[], meta: Record<string, CompletionMeta>) {
  const lines: string[] = [];
  lines.push('# fish completion for protheus');
  lines.push('complete -c protheus -f');
  for (const cmd of commands) {
    lines.push(`complete -c protheus -n "__fish_use_subcommand" -a "${cmd}"`);
  }
  for (const flag of GLOBAL_FLAGS) {
    lines.push(`complete -c protheus -n "__fish_use_subcommand" -a "${flag}"`);
  }
  for (const persona of personas) {
    lines.push(`complete -c protheus -n "__fish_seen_subcommand_from lens" -a "${persona}"`);
  }
  for (const [cmd, row] of Object.entries(meta).sort((a, b) => a[0].localeCompare(b[0]))) {
    for (const sub of row.subcommands || []) {
      lines.push(`complete -c protheus -n "${fishConditionForSubcommands(cmd)}" -a "${sub}"`);
    }
    for (const flag of Array.from(new Set([...GLOBAL_FLAGS, ...(row.flags || [])]))) {
      lines.push(`complete -c protheus -n "${fishConditionForSubcommands(cmd)}" -a "${flag}"`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

function shellScript(shell: string, commands: string[], personas: string[], meta: Record<string, CompletionMeta>) {
  const token = normalizeToken(shell, 20);
  if (token === 'bash') return buildBashScript(commands, personas, meta);
  if (token === 'zsh') return buildZshScript(commands, personas, meta);
  if (token === 'fish') return buildFishScript(commands, personas, meta);
  throw new Error(`unsupported_shell:${shell}`);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h) {
    usage();
    process.exit(0);
  }
  const shell = normalizeToken(args.shell || args._[0] || '', 20);
  if (!shell) {
    usage();
    process.exit(2);
  }
  const manifest = buildManifest();
  const commands = Array.from(new Set(
    (manifest.categories || [])
      .flatMap((category: AnyObj) => (category.commands || []).map((row: AnyObj) => normalizeToken(row.command, 80)))
      .filter((token: string) => token && !token.startsWith('--') && !token.startsWith('-'))
  )).sort((a, b) => a.localeCompare(b));
  const personas = listPersonas();
  const meta = completionMetadata();
  const script = shellScript(shell, commands, personas, meta);

  const installPath = cleanText(args['install-path'] ?? args.install_path, 400);
  if (installPath) {
    fs.mkdirSync(path.dirname(installPath), { recursive: true });
    fs.writeFileSync(installPath, script, 'utf8');
  } else {
    process.stdout.write(script);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  shellScript,
  listPersonas,
  completionMetadata
};
