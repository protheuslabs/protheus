#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawnSync } = require('child_process');
const { createSpinner } = require('../ops/cli_ui.js');

type AnyObj = Record<string, any>;

type ResearchPolicy = {
  version: string,
  enabled: boolean,
  proposal_only: boolean,
  require_human_confirmation_for_execute: boolean,
  query_budget: {
    max_query_tokens: number,
    mode: 'trim' | 'reject'
  },
  extraction: {
    max_local_hits: number,
    max_tokens_per_summary: number
  },
  logging: {
    append_to_persona_correspondence: boolean,
    append_to_persona_feed: boolean,
    write_state_receipts: boolean
  }
};

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const POLICY_PATH = process.env.PROTHEUS_RESEARCH_POLICY_PATH
  ? path.resolve(process.env.PROTHEUS_RESEARCH_POLICY_PATH)
  : path.join(ROOT, 'config', 'research_tool_policy.json');
const STATE_DIR = process.env.PROTHEUS_RESEARCH_STATE_DIR
  ? path.resolve(process.env.PROTHEUS_RESEARCH_STATE_DIR)
  : path.join(ROOT, 'state', 'tools', 'research');
const RUNS_DIR = path.join(STATE_DIR, 'runs');
const RECEIPTS_PATH = path.join(STATE_DIR, 'receipts.jsonl');
const LATEST_PATH = path.join(STATE_DIR, 'latest.json');
const PERSONA_CLI = path.join(ROOT, 'systems', 'personas', 'cli.js');
const RESEARCH_ORGAN_CLI = path.join(ROOT, 'systems', 'research', 'research_organ.js');
const PROACTIVE_ASSIMILATION_CLI = path.join(ROOT, 'systems', 'tools', 'proactive_assimilation.js');

const CORE_FIVE = ['vikram_menon', 'rohan_kapoor', 'priya_venkatesh', 'aarav_singh', 'li_wei'];

function usage() {
  console.log('Usage:');
  console.log('  protheus research "<query>" [--dry-run=1] [--format=json|markdown]');
  console.log('  protheus research "<query>" --apply=1 --confirm-execution=1');
}

function nowIso() {
  return new Date().toISOString();
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
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function clampInt(v: unknown, lo: number, hi: number, fallback: number) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  const i = Math.floor(n);
  if (i < lo) return lo;
  if (i > hi) return hi;
  return i;
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

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function readJson(filePath: string, fallback: any) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed == null ? fallback : parsed;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(filePath: string, value: AnyObj) {
  ensureDir(path.dirname(filePath));
  const tmpPath = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmpPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function appendJsonl(filePath: string, row: AnyObj) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(row)}\n`, 'utf8');
}

function relPath(filePath: string) {
  return path.relative(ROOT, filePath).replace(/\\/g, '/');
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

function estimateTokens(text: string) {
  const raw = String(text || '').trim();
  if (!raw) return 0;
  return Math.max(1, Math.ceil(raw.length / 4));
}

function defaultPolicy(): ResearchPolicy {
  return {
    version: '1.0',
    enabled: true,
    proposal_only: true,
    require_human_confirmation_for_execute: true,
    query_budget: {
      max_query_tokens: 2000,
      mode: 'trim'
    },
    extraction: {
      max_local_hits: 12,
      max_tokens_per_summary: 900
    },
    logging: {
      append_to_persona_correspondence: true,
      append_to_persona_feed: true,
      write_state_receipts: true
    }
  };
}

function loadPolicy(args: AnyObj): ResearchPolicy {
  const raw = readJson(POLICY_PATH, {});
  const base = defaultPolicy();
  const queryBudget = raw.query_budget && typeof raw.query_budget === 'object' ? raw.query_budget : {};
  const extraction = raw.extraction && typeof raw.extraction === 'object' ? raw.extraction : {};
  const logging = raw.logging && typeof raw.logging === 'object' ? raw.logging : {};

  const cliMaxTokens = args['max-query-tokens'] ?? args.max_query_tokens;
  const cliMode = normalizeToken(args['token-budget-mode'] ?? args.token_budget_mode ?? '', 20);

  const mode = cliMode === 'reject'
    ? 'reject'
    : cleanText(queryBudget.mode || base.query_budget.mode, 20).toLowerCase() === 'reject'
      ? 'reject'
      : 'trim';

  return {
    version: cleanText(raw.version || base.version, 40) || base.version,
    enabled: raw.enabled !== false,
    proposal_only: raw.proposal_only !== false,
    require_human_confirmation_for_execute: raw.require_human_confirmation_for_execute !== false,
    query_budget: {
      max_query_tokens: clampInt(cliMaxTokens ?? queryBudget.max_query_tokens, 64, 12000, base.query_budget.max_query_tokens),
      mode
    },
    extraction: {
      max_local_hits: clampInt(extraction.max_local_hits, 1, 100, base.extraction.max_local_hits),
      max_tokens_per_summary: clampInt(extraction.max_tokens_per_summary, 120, 8000, base.extraction.max_tokens_per_summary)
    },
    logging: {
      append_to_persona_correspondence: logging.append_to_persona_correspondence !== false,
      append_to_persona_feed: logging.append_to_persona_feed !== false,
      write_state_receipts: logging.write_state_receipts !== false
    }
  };
}

function enforceQueryBudget(query: string, policy: ResearchPolicy) {
  const maxTokens = Number(policy.query_budget.max_query_tokens || 2000);
  const mode = policy.query_budget.mode === 'reject' ? 'reject' : 'trim';
  const before = estimateTokens(query);
  if (before <= maxTokens) {
    return {
      ok: true,
      mode,
      max_tokens: maxTokens,
      estimated_tokens_before: before,
      estimated_tokens_after: before,
      trimmed: false,
      over_budget: false,
      query
    };
  }
  if (mode === 'reject') {
    return {
      ok: false,
      mode,
      max_tokens: maxTokens,
      estimated_tokens_before: before,
      estimated_tokens_after: before,
      trimmed: false,
      over_budget: true,
      query
    };
  }
  const chars = Math.max(1, maxTokens * 4);
  const trimmedQuery = String(query || '').slice(0, chars).trim();
  return {
    ok: true,
    mode,
    max_tokens: maxTokens,
    estimated_tokens_before: before,
    estimated_tokens_after: estimateTokens(trimmedQuery),
    trimmed: true,
    over_budget: true,
    query: trimmedQuery
  };
}

function queryTerms(query: string) {
  return Array.from(new Set(
    String(query || '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .map((part) => part.trim())
      .filter((part) => part.length >= 4)
  )).slice(0, 6);
}

function localHybridSearch(query: string, policy: ResearchPolicy) {
  const terms = queryTerms(query);
  const hits: Array<{ path: string, line: number, text: string, score: number, term: string }> = [];
  const seen = new Set<string>();
  const maxHits = Number(policy.extraction.max_local_hits || 12);

  for (const term of terms) {
    const run = spawnSync('rg', [
      '--no-heading',
      '--line-number',
      '--max-count',
      String(maxHits),
      '--fixed-strings',
      term,
      'docs',
      'systems',
      'memory'
    ], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 15 * 1024 * 1024
    });

    const lines = String(run.stdout || '').split('\n').map((row) => row.trim()).filter(Boolean);
    for (const row of lines) {
      const m = row.match(/^([^:]+):(\d+):(.*)$/);
      if (!m) continue;
      const key = `${m[1]}:${m[2]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const hitPath = cleanText(m[1], 240);
      const hitText = cleanText(m[3], 280);
      const line = clampInt(m[2], 1, 100000000, 1);
      const base = hitPath.startsWith('systems/') ? 0.85 : hitPath.startsWith('docs/') ? 0.7 : 0.6;
      const density = Math.min(0.15, (hitText.toLowerCase().split(term).length - 1) * 0.05);
      const score = Number(Math.min(1, base + density).toFixed(3));
      hits.push({ path: hitPath, line, text: hitText, score, term });
      if (hits.length >= maxHits) break;
    }
    if (hits.length >= maxHits) break;
  }

  hits.sort((a, b) => b.score - a.score);
  return {
    terms,
    hits: hits.slice(0, maxHits)
  };
}

function runResearchOrgan(query: string, hybrid: AnyObj) {
  if (!fs.existsSync(RESEARCH_ORGAN_CLI)) {
    return {
      ok: false,
      error: 'research_organ_missing'
    };
  }

  const capabilityId = normalizeToken(`research_${Date.now()}_${crypto.createHash('sha256').update(query).digest('hex').slice(0, 10)}`, 120);
  const metadata = {
    docs_urls: [],
    edge_cases: (hybrid.hits || []).slice(0, 8).map((row: AnyObj) => `${row.path}:${row.line} ${row.text}`),
    auth_model: 'unknown',
    rate_limits: []
  };

  const run = spawnSync(process.execPath, [
    RESEARCH_ORGAN_CLI,
    'run',
    `--objective=${cleanText(query, 220)}`,
    `--capability-id=${capabilityId}`,
    `--metadata-json=${JSON.stringify(metadata)}`
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 25 * 1024 * 1024
  });

  const payload = parseJsonText(run.stdout);
  if (Number.isFinite(run.status) && Number(run.status) === 0 && payload) {
    return {
      ok: true,
      run_id: cleanText(payload.run_id || '', 120),
      probe_confidence: Number(payload?.probe?.confidence || 0),
      proposal_count: Array.isArray(payload?.proposals) ? payload.proposals.length : 0,
      blocked_count: Array.isArray(payload?.blocked) ? payload.blocked.length : 0,
      proposals: Array.isArray(payload?.proposals) ? payload.proposals.slice(0, 6) : [],
      runs_path: cleanText(payload?.runs_path || '', 220),
      receipts_path: cleanText(payload?.receipts_path || '', 220)
    };
  }

  return {
    ok: false,
    error: cleanText(run.stderr || run.stdout || 'research_organ_failed', 500)
  };
}

function preparePersonaSandbox() {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'protheus-research-personas-'));
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

function runCoreFiveReview(query: string, synthesis: AnyObj) {
  if (!fs.existsSync(PERSONA_CLI)) {
    return {
      ok: false,
      error: 'persona_cli_missing'
    };
  }

  const brief = [
    `Research query: ${query}`,
    `Top findings: ${(synthesis.findings || []).slice(0, 3).join(' | ') || 'none'}`,
    `Research confidence: ${synthesis.research_confidence}`,
    'Return recommendation and escalation path.'
  ].join('\n');

  const sandboxRoot = preparePersonaSandbox();
  const run = spawnSync(process.execPath, [
    PERSONA_CLI,
    'all',
    brief,
    '--schema=json',
    '--context-budget-mode=trim',
    '--max-context-tokens=2000'
  ], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024,
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
    error: cleanText(run.stderr || run.stdout || 'core5_review_failed', 500)
  };
}

function runProactiveAssimilationSuggestion(
  query: string,
  opts: { dryRun: boolean, autoConfirm: boolean, autoReject: boolean }
) {
  if (!fs.existsSync(PROACTIVE_ASSIMILATION_CLI)) {
    return {
      ok: false,
      error: 'proactive_assimilation_cli_missing'
    };
  }
  const args = [
    PROACTIVE_ASSIMILATION_CLI,
    'scan',
    `--text=${query}`,
    '--origin=research',
    '--format=json'
  ];
  if (opts.dryRun) args.push('--dry-run=1');
  if (opts.autoConfirm) args.push('--auto-confirm=1');
  if (opts.autoReject) args.push('--auto-reject=1');

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 30 * 1024 * 1024
  });
  const payload = parseJsonText(run.stdout) || parseJsonText(run.stderr);
  if (payload && Number.isFinite(run.status) && Number(run.status) === 0) {
    return {
      ok: true,
      payload
    };
  }
  return {
    ok: false,
    error: cleanText(run.stderr || run.stdout || 'proactive_assimilation_failed', 500),
    payload: payload || null
  };
}

function shouldGenerateSprintPrompt(query: string) {
  const q = String(query || '').toLowerCase();
  return /(build|implement|create|add|migrate|automate|software|engine|system|tool)/.test(q);
}

function generateSprintPrompt(query: string, synthesis: AnyObj, review: AnyObj) {
  const tasks = (synthesis.recommendations || []).slice(0, 8);
  const taskLines = tasks.length
    ? tasks.map((row: string, idx: number) => `${idx + 1}. ${row}`).join('\n')
    : '1. Run scoped implementation with regression and sovereignty checks.';

  return [
    'STRICT EXECUTION RULES ACTIVE — READ codex_enforcer.md FIRST.',
    '',
    'Sprint: Research-Driven Execution',
    '',
    `Goal: Execute implementation path from query: "${cleanText(query, 240)}"`,
    '',
    'Tasks:',
    taskLines,
    '',
    'Governance:',
    `- Core-5 winner: ${review.winner || 'n/a'}`,
    `- Arbitration rule: ${review.arbitration_rule || 'n/a'}`,
    `- Suggested resolution: ${review.suggested_resolution || 'n/a'}`,
    '- Keep behavior-preserving migration and fail-closed sovereignty checks.',
    '- Include at least one regression test and one sovereignty/security check.',
    '',
    'After tasks:',
    '- Show full git diff',
    '- Show successful test run output',
    '- Show runtime proof artifact path',
    '',
    'Do NOT mark anything done until I approve.',
    '',
    'Begin NOW.',
    '',
    'End with:',
    '--- REAL PROGRESS ---',
    'Files changed:',
    'Research command added? (yes/no)',
    'Next task:'
  ].join('\n');
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
    correspondence_path: relPath(filePath)
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
    '--source=system_research',
    '--tags=research,query-intake'
  ];
  if (dryRun) args.push('--dry-run=1');

  const run = spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });

  const payload = parseJsonText(run.stdout);
  if (Number.isFinite(run.status) && Number(run.status) === 0) {
    return {
      ok: true,
      persona_id: personaId,
      payload
    };
  }
  return {
    ok: false,
    persona_id: personaId,
    reason: cleanText(run.stderr || run.stdout || 'feed_append_failed', 300)
  };
}

function synthesize(query: string, hybrid: AnyObj, research: AnyObj, policy: ResearchPolicy) {
  const findings = (hybrid.hits || []).slice(0, 6).map((row: AnyObj) => `${row.path}:${row.line} ${row.text}`);
  const recommendations: string[] = [];
  recommendations.push('Convert top graded findings into explicit implementation tasks with measurable acceptance criteria.');
  if (research.ok) {
    recommendations.push('Use research-organ proposals as candidate work packages and attach confidence receipts.');
  }
  if ((hybrid.hits || []).length > 0) {
    recommendations.push('Prioritize paths under systems/ and docs/ with highest relevance scores for initial implementation slice.');
  }
  recommendations.push('Run one regression test and one sovereignty check before marking progress.');

  const summaryRaw = [
    `Query: ${query}`,
    `Hybrid hits: ${(hybrid.hits || []).length}`,
    `Research confidence: ${Number(research.probe_confidence || 0).toFixed(3)}`,
    `Top recommendation: ${recommendations[0]}`
  ].join(' | ');

  return {
    findings,
    recommendations,
    summary: cleanText(summaryRaw, policy.extraction.max_tokens_per_summary * 4),
    research_confidence: Number(research.probe_confidence || 0)
  };
}

function failClosed(errorCode: string, context: AnyObj = {}) {
  const payload = {
    ok: false,
    type: 'research_result',
    error: cleanText(errorCode, 180),
    fail_closed: true,
    ts: nowIso(),
    ...context
  };
  process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(1);
}

function renderMarkdown(payload: AnyObj) {
  const lines: string[] = [];
  lines.push('# Research Result');
  lines.push('');
  lines.push(`- Query: \`${payload.query}\``);
  lines.push(`- Budget: \`${payload.query_budget.estimated_tokens_after}/${payload.query_budget.max_tokens}\` tokens`);
  lines.push(`- Core-5 Winner: \`${payload.core5_review.winner || 'n/a'}\``);
  lines.push(`- Findings: \`${payload.hybrid_search.hits.length}\``);
  lines.push('');
  lines.push('## Summary');
  lines.push(payload.synthesis.summary || 'No summary generated.');
  if (payload.sprint_prompt) {
    lines.push('');
    lines.push('## Sprint Prompt');
    lines.push('```text');
    lines.push(payload.sprint_prompt);
    lines.push('```');
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length === 0) {
    usage();
    process.exit(args.help ? 0 : 2);
  }

  const policy = loadPolicy(args);
  const dryRun = toBool(args['dry-run'] ?? args.dry_run, false);
  const outputFormat = normalizeToken(args.format || 'json', 16) || 'json';
  const progressEnabled = Boolean(process.stderr && process.stderr.isTTY)
    && (outputFormat !== 'json' || toBool(args.progress, false) || toBool(process.env.PROTHEUS_PROGRESS, false));
  const spinner = createSpinner('Research intake...', progressEnabled);
  const queryRaw = cleanText(args._.join(' '), 12000);

  if (!policy.enabled) {
    failClosed('research_disabled_by_policy', { policy_path: relPath(POLICY_PATH) });
  }

  if (toBool(process.env.PROTHEUS_RESEARCH_FORCE_COVENANT_VIOLATION, false)) {
    failClosed('covenant_violation_detected_for_research');
  }

  const applyRequested = toBool(args.apply ?? args.execute ?? false, false);
  const executionConfirmed = toBool(args['confirm-execution'] ?? args.confirm_execution ?? false, false);
  if (applyRequested && policy.require_human_confirmation_for_execute && !executionConfirmed) {
    failClosed('human_confirmation_required_before_execution', {
      hint: 'rerun with --confirm-execution=1 after operator approval'
    });
  }

  const budget = enforceQueryBudget(queryRaw, policy);
  if (!budget.ok) {
    spinner.stop(false, 'Research blocked by token budget');
    failClosed('query_budget_exceeded', {
      query_tokens: budget.estimated_tokens_before,
      max_tokens: budget.max_tokens,
      budget_mode: budget.mode
    });
  }
  spinner.update('Checking proactive assimilation signal...');

  const query = cleanText(budget.query, 12000);
  const proactiveEnabled = normalizeToken(args['suggest-assimilate'] ?? args.suggest_assimilate ?? 'on', 20) !== 'off';
  const proactiveAutoConfirm = toBool(args['auto-confirm-assimilate'] ?? args.auto_confirm_assimilate, false);
  const proactiveAutoReject = toBool(args['auto-reject-assimilate'] ?? args.auto_reject_assimilate, false);

  const proactiveResult = proactiveEnabled
    ? runProactiveAssimilationSuggestion(query, {
        dryRun,
        autoConfirm: proactiveAutoConfirm,
        autoReject: proactiveAutoReject
      })
    : {
        ok: true,
        payload: {
          ok: true,
          type: 'proactive_assimilation',
          suggested: false,
          skipped: true,
          reason: 'suggest_assimilate_off'
        }
      };

  spinner.update('Running hybrid search...');
  const hybrid = localHybridSearch(query, policy);
  spinner.update('Running research organ probes...');
  const research = runResearchOrgan(query, hybrid);
  spinner.update('Synthesizing + Core-5 review...');
  const synthesis = synthesize(query, hybrid, research, policy);
  const core5Review = runCoreFiveReview(query, synthesis);
  const sprintPrompt = shouldGenerateSprintPrompt(query)
    ? generateSprintPrompt(query, synthesis, core5Review)
    : null;

  const ts = nowIso();
  const runId = normalizeToken(`research_${Date.now()}_${crypto.createHash('sha256').update(query).digest('hex').slice(0, 10)}`, 120);

  const correspondenceEntry = [
    '',
    `## ${ts.slice(0, 10)} - Re: research intake`,
    '',
    `Research query: ${cleanText(query, 240)}`,
    `Run id: ${runId}. Hybrid hits: ${(hybrid.hits || []).length}.`,
    `Core-5 winner: ${core5Review.winner || 'n/a'}.`,
    `Receipt: ${relPath(LATEST_PATH)}`,
    ''
  ].join('\n');

  const feedSnippet = cleanText(
    `Research ${runId}: query=${query}; winner=${core5Review.winner || 'n/a'}; hits=${(hybrid.hits || []).length}; confidence=${Number(synthesis.research_confidence || 0).toFixed(3)}`,
    500
  );

  const correspondenceLogs: AnyObj[] = [];
  const feedLogs: AnyObj[] = [];

  if (!dryRun && policy.logging.append_to_persona_correspondence) {
    for (const personaId of CORE_FIVE) {
      correspondenceLogs.push(appendCorrespondenceLog(personaId, correspondenceEntry));
    }
  }

  if (policy.logging.append_to_persona_feed) {
    for (const personaId of CORE_FIVE) {
      feedLogs.push(appendPersonaFeed(personaId, feedSnippet, dryRun));
    }
  }

  const payload = {
    ok: true,
    type: 'research_result',
    ts,
    run_id: runId,
    policy_path: relPath(POLICY_PATH),
    dry_run: dryRun,
    execution_mode: policy.proposal_only ? 'proposal_only' : 'execution_capable',
    human_confirmation_required: policy.require_human_confirmation_for_execute,
    query,
    query_budget: {
      max_tokens: budget.max_tokens,
      mode: budget.mode,
      estimated_tokens_before: budget.estimated_tokens_before,
      estimated_tokens_after: budget.estimated_tokens_after,
      trimmed: budget.trimmed
    },
    hybrid_search: {
      terms: hybrid.terms,
      hits: hybrid.hits
    },
    research_organ: research,
    synthesis,
    proactive_assimilation: proactiveResult.ok
      ? proactiveResult.payload
      : {
          ok: false,
          error: proactiveResult.error || 'proactive_assimilation_failed',
          payload: proactiveResult.payload || null
        },
    core5_review: {
      ok: core5Review.ok === true,
      winner: core5Review.winner || null,
      disagreement: core5Review.disagreement === true,
      arbitration_rule: core5Review.arbitration_rule || null,
      suggested_resolution: core5Review.suggested_resolution || null,
      confidence: Number(core5Review.confidence || 0)
    },
    sprint_prompt: sprintPrompt,
    logs: {
      correspondence: correspondenceLogs,
      feed: feedLogs
    },
    artifacts: {
      latest_path: relPath(LATEST_PATH),
      receipts_path: relPath(RECEIPTS_PATH)
    }
  };

  if (policy.logging.write_state_receipts) {
    const runPath = path.join(RUNS_DIR, `${runId}.json`);
    writeJsonAtomic(runPath, payload);
    writeJsonAtomic(LATEST_PATH, payload);
    appendJsonl(RECEIPTS_PATH, {
      ts,
      type: 'research_run',
      run_id: runId,
      query_hash: crypto.createHash('sha256').update(query).digest('hex').slice(0, 16),
      dry_run: dryRun,
      hybrid_hits: (hybrid.hits || []).length,
      research_confidence: Number(synthesis.research_confidence || 0),
      core5_winner: core5Review.winner || null
    });
  }

  if (outputFormat === 'markdown' || outputFormat === 'md') {
    spinner.stop(true, 'Research completed');
    process.stdout.write(`${renderMarkdown(payload)}\n`);
    return;
  }

  spinner.stop(true, 'Research completed');
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

if (require.main === module) {
  main();
}
