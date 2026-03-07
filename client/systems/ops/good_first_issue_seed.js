#!/usr/bin/env node
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PACK_PATH = path.join(ROOT, 'docs', 'community', 'GOOD_FIRST_ISSUES.md');
const STATE_PATH = path.join(ROOT, 'state', 'ops', 'good_first_issue_seed', 'latest.json');

function parseArgs(argv) {
  const args = { apply: false };
  for (const raw of argv.slice(2)) {
    if (!raw.startsWith('--')) continue;
    const [key, value = '1'] = raw.slice(2).split('=');
    if (key === 'apply') args.apply = value === '1' || value === 'true';
  }
  return args;
}

function ensureDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function extractIssues(markdown) {
  const lines = markdown.split(/\r?\n/);
  const issues = [];
  let current = null;

  for (const line of lines) {
    const match = line.match(/^\d+\. \*\*(.+)\*\*$/);
    if (match) {
      if (current) issues.push(current);
      current = { title: match[1].trim(), body: [] };
      continue;
    }
    if (!current) continue;
    if (line.startsWith('- ') || line.trim().length === 0) {
      current.body.push(line);
    } else if (/^## /.test(line)) {
      break;
    }
  }
  if (current) issues.push(current);
  return issues.map((item) => ({
    title: item.title,
    body: item.body.join('\n').trim()
  }));
}

function runGhCreate(issue) {
  return spawnSync(
    'gh',
    [
      'issue',
      'create',
      '--title', issue.title,
      '--body', issue.body,
      '--label', 'good first issue',
      '--label', 'help wanted'
    ],
    {
      cwd: ROOT,
      encoding: 'utf8'
    }
  );
}

function main() {
  const args = parseArgs(process.argv);
  const markdown = fs.readFileSync(PACK_PATH, 'utf8');
  const issues = extractIssues(markdown);

  const report = {
    schema_id: 'good_first_issue_seed_result',
    schema_version: '1.0.0',
    generated_at: new Date().toISOString(),
    apply: args.apply,
    issue_count: issues.length,
    created: [],
    errors: []
  };

  if (args.apply) {
    for (const issue of issues) {
      const result = runGhCreate(issue);
      if (result.status === 0) {
        report.created.push({ title: issue.title, output: String(result.stdout || '').trim() });
      } else {
        report.errors.push({
          title: issue.title,
          stderr: String(result.stderr || '').trim(),
          stdout: String(result.stdout || '').trim()
        });
      }
    }
  }

  ensureDir(STATE_PATH);
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  if (args.apply && report.errors.length > 0) {
    process.exit(1);
  }
}

main();
