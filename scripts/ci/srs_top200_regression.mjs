#!/usr/bin/env node
/* eslint-disable no-console */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const SRS_PATH = 'docs/workspace/SRS.md';
const TODO_PATH = 'docs/workspace/TODO.md';
const FULL_REGRESSION_JSON = 'core/local/artifacts/srs_full_regression_current.json';
const OUT_JSON = 'core/local/artifacts/srs_top200_regression_2026-03-10.json';
const OUT_MD = 'local/workspace/archive/docs-workspace/SRS_TOP_200_REGRESSION_2026-03-10.md';

function shell(cmd) {
  return execSync(cmd, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function read(path) {
  return readFileSync(resolve(path), 'utf8');
}

function parseSrsRows(markdown) {
  const rows = [];
  const lines = markdown.split('\n');
  let section = 'Uncategorized';
  for (const line of lines) {
    const h = line.match(/^##\s+(.+)$/);
    if (h) {
      section = h[1].trim();
      continue;
    }
    if (!line.startsWith('|')) continue;
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((c) => c.trim());
    if (cells.length < 5) continue;
    if (cells[0] === 'ID' || cells[0] === '---') continue;
    const id = cells[0];
    if (!/^V[0-9]+-/.test(id)) continue;
    rows.push({
      id,
      status: cells[1].toLowerCase(),
      upgrade: cells[2],
      why: cells[3],
      exitCriteria: cells[4],
      section,
    });
  }
  return rows;
}

function parseTodoUnchecked(todo) {
  const out = new Set();
  for (const m of todo.matchAll(/^- \[ \]\s+`([^`]+)`/gm)) {
    out.add(m[1]);
  }
  return out;
}

function parseTodoValidationCommands(todo) {
  const lines = todo.split('\n');
  const map = new Map();
  let currentId = null;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const idMatch = line.match(/^- \[[ x]\]\s+`([^`]+)`/);
    if (idMatch) {
      currentId = idMatch[1];
      if (!map.has(currentId)) map.set(currentId, []);
      continue;
    }
    if (!currentId) continue;
    if (/^- \[[ x]\]\s+`/.test(line)) continue;
    const commands = [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const c of commands) {
      if (
        c.startsWith('npm run') ||
        c.startsWith('node ') ||
        c.startsWith('cargo ') ||
        c.startsWith('bash ') ||
        c.startsWith('./')
      ) {
        map.get(currentId).push(c);
      }
    }
  }
  return map;
}

function idPrefixWeight(id) {
  const domain = id.split('-')[1] ?? '';
  const weights = {
    COCKPIT: 140,
    MEMORY: 135,
    SIMPLE: 132,
    PRIORITY: 130,
    INITIATIVE: 125,
    CONDUIT: 122,
    OBSERVABILITY: 118,
    SWARM: 115,
    ARCH: 112,
    COMP: 110,
    COMPANY: 108,
    AGENCY: 106,
    NETWORK: 104,
    STORAGE: 102,
    APP: 100,
    SUBSTRATE: 96,
    HERMES: 94,
    VBROWSER: 90,
    META: 86,
  };
  return weights[domain] ?? 70;
}

function statusWeight(status) {
  switch (status) {
    case 'in_progress':
      return 300;
    case 'blocked':
      return 240;
    case 'blocked_external_prepared':
      return 220;
    case 'queued':
      return 180;
    case 'done':
      return 40;
    default:
      return 120;
  }
}

function quoteForSingleShell(str) {
  return `'${str.replace(/'/g, `'\"'\"'`)}'`;
}

function countIdHits(id, nonBacklog = false) {
  const q = quoteForSingleShell(id);
  if (nonBacklog) {
    const out = shell(
      `rg -F --no-messages -n ${q} core client apps adapters scripts tests .github docs -g '!docs/workspace/SRS.md' -g '!docs/workspace/TODO.md' -g '!docs/workspace/UPGRADE_BACKLOG.md' -g '!docs/workspace/SRS_*REGRESSION*.md' -g '!core/local/artifacts/srs_*regression*.json' | wc -l | awk '{print $1}'`,
    );
    return Number(out.trim() || '0');
  }
  const out = shell(
    `rg -F --no-messages -n ${q} docs/workspace/SRS.md docs/workspace/TODO.md core client apps adapters scripts tests .github docs | wc -l | awk '{print $1}'`,
  );
  return Number(out.trim() || '0');
}

function loadFullRegressionCounts() {
  if (!existsSync(FULL_REGRESSION_JSON)) return null;
  try {
    const payload = JSON.parse(read(FULL_REGRESSION_JSON));
    const rows = Array.isArray(payload.rows) ? payload.rows : [];
    const map = new Map();
    for (const row of rows) {
      if (!row || typeof row.id !== 'string') continue;
      map.set(row.id, {
        evidenceCount: Number(row.evidenceCount ?? 0),
        nonBacklogEvidenceCount: Number(row.nonBacklogEvidenceCount ?? 0),
      });
    }
    return map;
  } catch {
    return null;
  }
}

function loadPackageScripts() {
  const pkg = JSON.parse(read('package.json'));
  return new Set(Object.keys(pkg.scripts ?? {}));
}

function extractNpmScriptName(cmd) {
  // Handles "npm run -s name" and "npm run name"
  const parts = cmd.split(/\s+/);
  if (parts[0] !== 'npm' || parts[1] !== 'run') return null;
  if (parts[2] === '-s') return parts[3] ?? null;
  return parts[2] ?? null;
}

function commandResolution(commandsById, packageScripts) {
  const out = new Map();
  for (const [id, cmds] of commandsById.entries()) {
    const resolved = [];
    const unresolved = [];
    for (const cmd of cmds) {
      if (cmd.startsWith('npm run')) {
        const name = extractNpmScriptName(cmd);
        if (name && packageScripts.has(name)) {
          resolved.push(cmd);
        } else {
          unresolved.push(cmd);
        }
        continue;
      }
      if (cmd.startsWith('node ')) {
        const file = cmd.split(/\s+/)[1];
        if (file && existsSync(file)) resolved.push(cmd);
        else unresolved.push(cmd);
        continue;
      }
      if (cmd.startsWith('bash ')) {
        const file = cmd.split(/\s+/)[1];
        if (file && existsSync(file)) resolved.push(cmd);
        else unresolved.push(cmd);
        continue;
      }
      if (cmd.startsWith('./')) {
        const file = cmd.split(/\s+/)[0];
        if (existsSync(file)) resolved.push(cmd);
        else unresolved.push(cmd);
        continue;
      }
      if (cmd.startsWith('cargo ')) {
        // Cargo commands are considered resolvable syntactically here.
        resolved.push(cmd);
        continue;
      }
    }
    out.set(id, { resolved, unresolved });
  }
  return out;
}

function regressionSummary(item, evidenceCount, nonBacklogEvidenceCount, todoUnchecked, cmdAudit, rank) {
  const findings = [];
  if (item.status === 'done' && nonBacklogEvidenceCount === 0) {
    findings.push('status_without_non_backlog_evidence');
  }
  if (item.status === 'in_progress' && nonBacklogEvidenceCount === 0 && evidenceCount === 0) {
    findings.push('in_progress_without_non_backlog_evidence');
  }
  if (item.status === 'done' && todoUnchecked) {
    findings.push('todo_conflicts_done_status');
  }
  if (item.status === 'queued' && nonBacklogEvidenceCount === 0 && rank <= 20) {
    findings.push('queued_without_artifact_footprint');
  }
  if (cmdAudit && cmdAudit.unresolved.length > 0) {
    findings.push('unresolved_validation_commands');
  }
  if (item.id.includes('..')) {
    findings.push('aggregate_id_range_requires_split_execution');
  }
  let severity = 'pass';
  if (findings.length > 0) severity = 'warn';
  if (
    findings.includes('unresolved_validation_commands') ||
    findings.includes('status_without_non_backlog_evidence')
  ) {
    severity = 'fail';
  }
  return { severity, findings };
}

function score(item, todoUnchecked) {
  let s = statusWeight(item.status) + idPrefixWeight(item.id);
  if (todoUnchecked.has(item.id)) s += 80;
  if (item.id.startsWith('V6-COCKPIT-008')) s += 60;
  if (item.id.startsWith('V6-COCKPIT-007')) s += 55;
  if (item.id.startsWith('V6-MEMORY-013') || item.id.startsWith('V6-MEMORY-014') || item.id.startsWith('V6-MEMORY-015')) s += 50;
  if (item.id.includes('..')) s -= 5;
  return s;
}

function main() {
  const srs = read(SRS_PATH);
  const todo = read(TODO_PATH);
  const srsRows = parseSrsRows(srs);
  const todoUnchecked = parseTodoUnchecked(todo);
  const commandsById = parseTodoValidationCommands(todo);
  const packageScripts = loadPackageScripts();
  const cmdResolution = commandResolution(commandsById, packageScripts);
  const fullCounts = loadFullRegressionCounts();

  const ranked = srsRows
    .map((row) => ({ ...row, score: score(row, todoUnchecked) }))
    .sort((a, b) => (b.score - a.score) || a.id.localeCompare(b.id))
    .slice(0, 200)
    .map((row, index) => {
      const fromFull = fullCounts?.get(row.id);
      const evidenceCount = fromFull?.evidenceCount ?? countIdHits(row.id, false);
      const nonBacklogEvidenceCount = fromFull?.nonBacklogEvidenceCount ?? countIdHits(row.id, true);
      const cmdAudit = cmdResolution.get(row.id) ?? { resolved: [], unresolved: [] };
      const regression = regressionSummary(
        row,
        evidenceCount,
        nonBacklogEvidenceCount,
        todoUnchecked.has(row.id),
        cmdAudit,
        index + 1,
      );
      return {
        rank: index + 1,
        ...row,
        evidenceCount,
        nonBacklogEvidenceCount,
        todoUnchecked: todoUnchecked.has(row.id),
        validationCommandsResolved: cmdAudit.resolved.length,
        validationCommandsUnresolved: cmdAudit.unresolved,
        regression,
      };
    });

  const summary = {
    generatedAt: new Date().toISOString(),
    source: { srs: SRS_PATH, todo: TODO_PATH },
    totalSrsRows: srsRows.length,
    top200Count: ranked.length,
    regression: {
      fail: ranked.filter((r) => r.regression.severity === 'fail').length,
      warn: ranked.filter((r) => r.regression.severity === 'warn').length,
      pass: ranked.filter((r) => r.regression.severity === 'pass').length,
    },
  };

  const payload = { summary, top200: ranked };
  mkdirSync(dirname(OUT_JSON), { recursive: true });
  writeFileSync(OUT_JSON, `${JSON.stringify(payload, null, 2)}\n`);

  const lines = [];
  lines.push('# SRS Top 200 Importance + Regression Audit (2026-03-10)');
  lines.push('');
  lines.push(`- Source SRS items scanned: **${summary.totalSrsRows}**`);
  lines.push(`- Ranked items emitted: **${summary.top200Count}**`);
  lines.push(`- Regression severities: **fail=${summary.regression.fail}**, **warn=${summary.regression.warn}**, **pass=${summary.regression.pass}**`);
  lines.push(`- Machine report: \`${OUT_JSON}\``);
  lines.push('');
  lines.push('| Rank | ID | Status | Score | Evidence Hits | Non-Backlog Evidence | Regression |');
  lines.push('|---:|---|---|---:|---:|---:|---|');
  for (const item of ranked) {
    lines.push(`| ${item.rank} | ${item.id} | ${item.status} | ${item.score} | ${item.evidenceCount} | ${item.nonBacklogEvidenceCount} | ${item.regression.severity} |`);
  }
  lines.push('');
  lines.push('## High-Priority Regression Findings (fail/warn)');
  lines.push('');
  for (const item of ranked.filter((r) => r.regression.severity !== 'pass')) {
    lines.push(`### ${item.rank}. ${item.id}`);
    lines.push(`- Status: \`${item.status}\``);
    lines.push(`- Findings: ${item.regression.findings.join(', ') || 'none'}`);
    if (item.validationCommandsUnresolved.length > 0) {
      lines.push('- Unresolved validation commands:');
      for (const cmd of item.validationCommandsUnresolved.slice(0, 8)) {
        lines.push(`  - \`${cmd}\``);
      }
    }
    lines.push('');
  }
  mkdirSync(dirname(OUT_MD), { recursive: true });
  writeFileSync(OUT_MD, `${lines.join('\n')}\n`);

  console.log(
    JSON.stringify(
      {
        ok: true,
        type: 'srs_top200_regression',
        out_json: OUT_JSON,
        out_markdown: OUT_MD,
        summary,
      },
      null,
      2,
    ),
  );
}

main();
