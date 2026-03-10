#!/usr/bin/env node
/* eslint-disable no-console */
import { readFileSync } from 'node:fs';

function count(re, text) {
  const m = text.match(re);
  return m ? m.length : 0;
}

const todoPath = 'docs/workspace/TODO.md';
const srsPath = 'docs/workspace/SRS.md';
const failOnActionable = process.argv.includes('--fail-on-actionable');

const todo = readFileSync(todoPath, 'utf8');
const srs = readFileSync(srsPath, 'utf8');

const todoUnchecked = count(/^- \[ \]/gm, todo);
const todoChecked = count(/^- \[x\]/gim, todo);
const srsQueued = count(/\|\s*queued\s*\|/gim, srs);
const srsInProgress = count(/\|\s*in_progress\s*\|/gim, srs);
const srsBlocked = count(/\|\s*blocked\s*\|/gim, srs);
const srsDone = count(/\|\s*done\s*\|/gim, srs);

const actionable = todoUnchecked + srsQueued + srsInProgress;
const report = {
  ok: failOnActionable ? actionable === 0 : true,
  type: 'backlog_actionable_report',
  actionable_count: actionable,
  todo: {
    unchecked: todoUnchecked,
    checked: todoChecked,
  },
  srs: {
    queued: srsQueued,
    in_progress: srsInProgress,
    blocked: srsBlocked,
    done: srsDone,
  },
};

console.log(JSON.stringify(report, null, 2));
if (failOnActionable && actionable > 0) {
  process.exit(1);
}
