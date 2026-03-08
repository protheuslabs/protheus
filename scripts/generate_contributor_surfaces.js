#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const START = '<!-- EMPTY_FORT:START -->';
const END = '<!-- EMPTY_FORT:END -->';

function parseArgs(argv) {
  const args = {
    manifest: 'client/docs/community/contributors_manifest.json',
    readme: 'README.md',
    contributors: 'CONTRIBUTORS.md'
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--manifest=')) args.manifest = token.slice('--manifest='.length);
    else if (token.startsWith('--readme=')) args.readme = token.slice('--readme='.length);
    else if (token.startsWith('--contributors=')) args.contributors = token.slice('--contributors='.length);
    else if (token === '--help' || token === '-h') {
      console.log('Usage: node scripts/generate_contributor_surfaces.js [--manifest=...] [--readme=README.md] [--contributors=CONTRIBUTORS.md]');
      process.exit(0);
    }
  }
  return args;
}

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function contributorTable(contributors) {
  const rows = contributors.map((c) => {
    const login = c.login;
    const name = c.name || login;
    const roles = Array.isArray(c.contributions) ? c.contributions.join(', ') : '';
    const joined = c.joined_at || '';
    return `| ${name} | [@${login}](https://github.com/${login}) | ${roles} | ${joined} |`;
  });
  return [
    '| Name | GitHub | Roles | Joined |',
    '|---|---|---|---|',
    ...rows
  ].join('\n');
}

function avatarGrid(contributors) {
  const lines = contributors.map((c) => `- [![${c.login}](https://github.com/${c.login}.png?size=48)](https://github.com/${c.login}) @${c.login}`);
  return lines.join('\n');
}

function renderBlock(contributors) {
  const count = contributors.length;
  return [
    START,
    '## Contributor Signal',
    '',
    `**${count} verified contributors** (consent-backed manifest, generated).`,
    '',
    'Claims in this section are generated from `client/docs/community/contributors_manifest.json`.',
    '',
    avatarGrid(contributors),
    END
  ].join('\n');
}

function upsertReadmeSection(readmePath, block) {
  const content = fs.existsSync(readmePath) ? fs.readFileSync(readmePath, 'utf8') : '# Protheus\n\n';
  if (content.includes(START) && content.includes(END)) {
    const start = content.indexOf(START);
    const end = content.indexOf(END) + END.length;
    return content.slice(0, start) + block + content.slice(end);
  }

  const idx = content.indexOf('## What This Repo Includes');
  if (idx >= 0) {
    return `${content.slice(0, idx).trimEnd()}\n\n${block}\n\n${content.slice(idx)}`;
  }
  return `${content.trimEnd()}\n\n${block}\n`;
}

function main() {
  const args = parseArgs(process.argv);
  const manifestPath = path.resolve(args.manifest);
  const readmePath = path.resolve(args.readme);
  const contributorsPath = path.resolve(args.contributors);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const contributors = Array.isArray(manifest.contributors) ? manifest.contributors.slice() : [];
  contributors.sort((a, b) => String(a.login || '').localeCompare(String(b.login || '')));

  const readmeBlock = renderBlock(contributors);
  const nextReadme = upsertReadmeSection(readmePath, readmeBlock);
  fs.writeFileSync(readmePath, nextReadme);

  const contributorsDoc = [
    '# CONTRIBUTORS',
    '',
    `Generated from \`${path.relative(process.cwd(), manifestPath)}\` on ${new Date().toISOString()}.`,
    '',
    contributorTable(contributors),
    ''
  ].join('\n');
  ensureDir(contributorsPath);
  fs.writeFileSync(contributorsPath, contributorsDoc);

  console.log(JSON.stringify({
    ok: true,
    readme: path.relative(process.cwd(), readmePath),
    contributors: path.relative(process.cwd(), contributorsPath),
    contributor_count: contributors.length
  }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  }
}
