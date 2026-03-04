#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const { spawnSync } = require('child_process');

type AnyObj = Record<string, any>;

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const PERSONA_CLI = path.join(ROOT, 'systems', 'personas', 'cli.js');
const ASSIMILATE_CLI = path.join(ROOT, 'systems', 'tools', 'assimilate.js');
const CORE_FIVE = ['vikram_menon', 'rohan_kapoor', 'priya_venkatesh', 'aarav_singh', 'li_wei'];

type DetectResult = {
  detected: boolean,
  kind: 'url' | 'path' | 'tool_mention' | 'none',
  target: string | null,
  label: string | null,
  reason: string
};

function usage() {
  console.log('Usage:');
  console.log('  node systems/tools/proactive_assimilation.js scan --text="..." [--auto-confirm=1|0] [--dry-run=1] [--format=json|markdown] [--origin=main_cli|research]');
  console.log('  node systems/tools/proactive_assimilation.js scan --argv-json="{\"cmd\":\"...\",\"args\":[...] }" [--auto-confirm=1|0] [--dry-run=1]');
}

function cleanText(v: unknown, maxLen = 500) {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120) {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.:/-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false) {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on', 'y'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off', 'n'].includes(raw)) return false;
  return fallback;
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

function parseJsonText(raw: unknown): AnyObj | null {
  const text = String(raw == null ? '' : raw).trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {}
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && typeof parsed === 'object') return parsed;
    } catch {}
  }
  return null;
}

function detectCandidate(text: string): DetectResult {
  const raw = String(text || '');
  if (!raw.trim()) {
    return {
      detected: false,
      kind: 'none',
      target: null,
      label: null,
      reason: 'empty_input'
    };
  }

  const urlMatch = raw.match(/https?:\/\/[^\s)"'<>]+/i);
  if (urlMatch && urlMatch[0]) {
    const target = cleanText(urlMatch[0], 1000);
    return {
      detected: true,
      kind: 'url',
      target,
      label: target,
      reason: 'url_detected'
    };
  }

  const candidates = raw
    .split(/\s+/)
    .map((part) => part.replace(/["'`,;]+/g, '').trim())
    .filter(Boolean)
    .slice(0, 40);

  for (const candidate of candidates) {
    if (!(/[\/]|\.[a-z0-9]{1,6}$/i.test(candidate))) continue;
    const resolved = path.isAbsolute(candidate)
      ? path.resolve(candidate)
      : path.resolve(ROOT, candidate);
    if (fs.existsSync(resolved) && fs.statSync(resolved).isFile()) {
      return {
        detected: true,
        kind: 'path',
        target: candidate,
        label: candidate,
        reason: 'path_detected'
      };
    }
  }

  const mention = raw.match(/\b(?:i\s+just\s+used|i\s+used|using|used)\s+([a-zA-Z0-9_.-]{2,80})\b/i);
  if (mention && mention[1]) {
    const tool = cleanText(mention[1], 120);
    return {
      detected: true,
      kind: 'tool_mention',
      target: null,
      label: tool,
      reason: 'tool_mention_detected'
    };
  }

  return {
    detected: false,
    kind: 'none',
    target: null,
    label: null,
    reason: 'no_candidate'
  };
}

function preparePersonaSandbox() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-proactive-personas-'));
  const srcPersonasDir = path.join(ROOT, 'personas');
  const dstPersonasDir = path.join(tmpRoot, 'personas');
  fs.mkdirSync(dstPersonasDir, { recursive: true });
  if (fs.existsSync(path.join(srcPersonasDir, 'organization'))) {
    fs.cpSync(path.join(srcPersonasDir, 'organization'), path.join(dstPersonasDir, 'organization'), { recursive: true });
  }
  for (const personaId of CORE_FIVE) {
    const src = path.join(srcPersonasDir, personaId);
    const dst = path.join(dstPersonasDir, personaId);
    if (fs.existsSync(src)) fs.cpSync(src, dst, { recursive: true });
  }
  return tmpRoot;
}

function runCoreFiveSuggestionReview(candidate: DetectResult, text: string) {
  if (!fs.existsSync(PERSONA_CLI)) {
    return {
      ok: false,
      error: 'persona_cli_missing'
    };
  }
  const query = [
    'Review whether proactive assimilation should be suggested for this detected signal.',
    `Detected kind: ${candidate.kind}`,
    `Detected label: ${candidate.label || 'unknown'}`,
    `Detected target: ${candidate.target || 'none'}`,
    `Context text: ${cleanText(text, 600)}`,
    'Return deterministic recommendation and escalation path.'
  ].join('\n');

  const sandboxRoot = preparePersonaSandbox();
  const run = spawnSync(process.execPath, [
    PERSONA_CLI,
    'all',
    query,
    '--schema=json',
    '--context-budget-mode=trim',
    '--max-context-tokens=1200'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024,
    env: {
      ...process.env,
      OPENCLAW_WORKSPACE: sandboxRoot
    }
  });

  try {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
  } catch {}

  const payload = parseJsonText(run.stdout);
  if (Number.isFinite(run.status) && Number(run.status) === 0 && payload) {
    return {
      ok: true,
      winner: cleanText(payload.winner || payload?.arbitration?.winner || '', 120),
      disagreement: payload.disagreement === true,
      arbitration_rule: cleanText(payload?.arbitration?.rule || '', 220),
      suggested_resolution: cleanText(payload.suggested_resolution || '', 600),
      confidence: Number(payload?.persona_outputs?.[0]?.confidence || 0),
      raw: payload
    };
  }

  return {
    ok: false,
    error: cleanText(run.stderr || run.stdout || 'core5_suggestion_review_failed', 500)
  };
}

async function askYesNo(promptText: string) {
  if (!process.stdin.isTTY) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>((resolve) => {
    rl.question(`${promptText} `, (value) => resolve(String(value || '').trim()));
  });
  rl.close();
  const norm = answer.toLowerCase();
  if (['y', 'yes'].includes(norm)) return true;
  if (['n', 'no'].includes(norm)) return false;
  return null;
}

function appendCorrespondenceLog(personaId: string, entry: string) {
  const filePath = path.join(ROOT, 'personas', personaId, 'correspondence.md');
  if (!fs.existsSync(filePath)) {
    return {
      ok: false,
      persona_id: personaId,
      reason: 'correspondence_file_missing'
    };
  }
  const base = fs.readFileSync(filePath, 'utf8').replace(/\s+$/, '');
  fs.writeFileSync(filePath, `${base}\n${entry}\n`, 'utf8');
  return {
    ok: true,
    persona_id: personaId,
    correspondence_path: path.relative(ROOT, filePath).replace(/\\/g, '/')
  };
}

function appendPersonaFeed(personaId: string, snippet: string, dryRun = false) {
  if (!fs.existsSync(PERSONA_CLI)) {
    return {
      ok: false,
      persona_id: personaId,
      reason: 'persona_cli_missing'
    };
  }
  const args = [
    PERSONA_CLI,
    'feed',
    personaId,
    snippet,
    '--source=proactive_assimilation',
    '--tags=assimilate,suggestion'
  ];
  if (dryRun) args.push('--dry-run=1');

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  const payload = parseJsonText(run.stdout);
  return {
    ok: Number.isFinite(run.status) && Number(run.status) === 0,
    persona_id: personaId,
    payload: payload || null,
    reason: Number.isFinite(run.status) && Number(run.status) === 0
      ? null
      : cleanText(run.stderr || run.stdout || 'feed_append_failed', 300)
  };
}

function runAssimilate(target: string, dryRun: boolean) {
  if (!fs.existsSync(ASSIMILATE_CLI)) {
    return {
      ok: false,
      error: 'assimilate_cli_missing'
    };
  }

  const args = [ASSIMILATE_CLI, target, '--format=json'];
  if (dryRun) args.push('--dry-run=1');

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024
  });
  const payload = parseJsonText(run.stdout) || parseJsonText(run.stderr);
  if (Number.isFinite(run.status) && Number(run.status) === 0 && payload) {
    return {
      ok: true,
      payload
    };
  }

  return {
    ok: false,
    error: cleanText(run.stderr || run.stdout || 'assimilate_invocation_failed', 500),
    payload: payload || null
  };
}

async function scan(text: string, opts: {
  autoConfirm: boolean,
  autoReject: boolean,
  dryRun: boolean,
  origin: string,
  format: string
}) {
  const candidate = detectCandidate(text);
  const result: AnyObj = {
    ok: true,
    type: 'proactive_assimilation',
    ts: new Date().toISOString(),
    origin: cleanText(opts.origin || 'unknown', 40),
    detected: candidate,
    suggested: false,
    prompt: null,
    decision: {
      prompted: false,
      confirmed: false,
      mode: 'none'
    },
    core5_review: null,
    assimilation: null,
    logs: {
      correspondence: [],
      feed: []
    }
  };

  if (!candidate.detected) {
    return result;
  }

  const review = runCoreFiveSuggestionReview(candidate, text);
  result.core5_review = {
    ok: review.ok === true,
    winner: review.winner || null,
    disagreement: review.disagreement === true,
    arbitration_rule: review.arbitration_rule || null,
    suggested_resolution: review.suggested_resolution || null,
    confidence: Number(review.confidence || 0),
    error: review.ok ? null : review.error || 'core5_review_failed'
  };

  if (review.ok !== true) {
    result.suggested = false;
    result.decision = {
      prompted: false,
      confirmed: false,
      mode: 'blocked_core5'
    };
    return result;
  }

  result.suggested = true;
  const promptText = `I noticed you using ${candidate.label || 'an external tool'}. Assimilate it into the system? (y/n)`;
  result.prompt = promptText;

  let confirmed: boolean | null = null;
  if (opts.autoConfirm) {
    confirmed = true;
    result.decision.mode = 'auto_confirm';
  } else if (opts.autoReject) {
    confirmed = false;
    result.decision.mode = 'auto_reject';
  } else {
    result.decision.prompted = true;
    result.decision.mode = process.stdin.isTTY ? 'interactive' : 'non_interactive';
    if (process.stdin.isTTY) {
      if (opts.format === 'markdown') {
        process.stdout.write(`${promptText}\n`);
      }
      confirmed = await askYesNo(promptText);
    } else {
      confirmed = false;
    }
  }

  result.decision.confirmed = confirmed === true;

  const note = cleanText(
    `Proactive suggestion: detected=${candidate.kind}:${candidate.label || candidate.target || 'unknown'} confirmed=${confirmed === true ? 'yes' : 'no'} origin=${opts.origin}`,
    420
  );

  if (!opts.dryRun) {
    const ts = new Date().toISOString().slice(0, 10);
    const correspondenceEntry = [
      '',
      `## ${ts} - Re: proactive assimilation suggestion`,
      '',
      note,
      `Core-5 winner: ${review.winner || 'n/a'}.`,
      ''
    ].join('\n');
    for (const personaId of CORE_FIVE) {
      result.logs.correspondence.push(appendCorrespondenceLog(personaId, correspondenceEntry));
    }
  }

  for (const personaId of CORE_FIVE) {
    result.logs.feed.push(appendPersonaFeed(personaId, note, opts.dryRun));
  }

  if (confirmed === true) {
    if (!candidate.target) {
      result.assimilation = {
        ok: false,
        error: 'detected_tool_has_no_path_or_url_target'
      };
    } else {
      result.assimilation = runAssimilate(candidate.target, opts.dryRun);
    }
  }

  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = normalizeToken(args._[0] || 'scan', 40) || 'scan';
  if (cmd === 'help' || args.help) {
    usage();
    process.exit(0);
  }

  if (cmd !== 'scan') {
    process.stderr.write(`${JSON.stringify({ ok: false, type: 'proactive_assimilation', error: `unknown_command:${cmd}` }, null, 2)}\n`);
    process.exit(1);
  }

  let text = cleanText(args.text || args.message || '', 8000);
  const argvJson = parseJsonText(args['argv-json'] || args.argv_json || null);
  const cmdToken = normalizeToken(args.cmd || argvJson?.cmd || '', 60);
  const cmdArgs = Array.isArray(argvJson?.args) ? argvJson.args.map((row: unknown) => cleanText(row, 400)) : [];

  if (!text && cmdToken) {
    text = cleanText([cmdToken, ...cmdArgs].join(' '), 8000);
  }

  if (['assimilate'].includes(cmdToken)) {
    process.stdout.write(`${JSON.stringify({
      ok: true,
      type: 'proactive_assimilation',
      ts: new Date().toISOString(),
      origin: cleanText(args.origin || 'main_cli', 40),
      skipped: true,
      reason: `skip_command:${cmdToken}`
    }, null, 2)}\n`);
    process.exit(0);
  }

  const payload = await scan(text, {
    autoConfirm: toBool(args['auto-confirm'] ?? args.auto_confirm, false),
    autoReject: toBool(args['auto-reject'] ?? args.auto_reject, false),
    dryRun: toBool(args['dry-run'] ?? args.dry_run, false),
    origin: cleanText(args.origin || 'unknown', 40),
    format: normalizeToken(args.format || 'json', 20) || 'json'
  });

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${JSON.stringify({
      ok: false,
      type: 'proactive_assimilation',
      error: cleanText(err && err.message, 300)
    }, null, 2)}\n`);
    process.exit(1);
  });
}

module.exports = {
  detectCandidate,
  runCoreFiveSuggestionReview,
  scan
};
