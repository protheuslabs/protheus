#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = process.env.OPENCLAW_WORKSPACE
  ? path.resolve(process.env.OPENCLAW_WORKSPACE)
  : path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(ROOT, 'state', 'personas', 'pre_commit_lens_gate');
const LATEST_PATH = path.join(STATE_DIR, 'latest.json');
const HISTORY_PATH = path.join(STATE_DIR, 'history.jsonl');

type ParsedArgs = {
  _: string[],
  [key: string]: unknown
};

type RiskFinding = {
  id: string,
  severity: 'low' | 'medium' | 'high',
  reason: string,
  line: string
};

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { _: [] };
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

function cleanText(v: unknown, maxLen = 240): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120): string {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function toBool(v: unknown, fallback = false): boolean {
  const raw = cleanText(v, 20).toLowerCase();
  if (!raw) return fallback;
  if (['1', 'true', 'yes', 'on'].includes(raw)) return true;
  if (['0', 'false', 'no', 'off'].includes(raw)) return false;
  return fallback;
}

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dirPath: string) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonAtomic(filePath: string, payload: Record<string, unknown>) {
  ensureDir(path.dirname(filePath));
  const tmp = `${filePath}.tmp-${Date.now()}-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

function appendJsonl(filePath: string, payload: Record<string, unknown>) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, 'utf8');
}

function readDecisionLensHint(personaId: string): string {
  const personaDir = path.join(ROOT, 'personas', personaId);
  const decisionPath = fs.existsSync(path.join(personaDir, 'decision_lens.md'))
    ? path.join(personaDir, 'decision_lens.md')
    : path.join(personaDir, 'lens.md');
  if (!fs.existsSync(decisionPath)) {
    return 'Preserve deterministic behavior and fail-closed security boundaries before merge.';
  }
  const body = String(fs.readFileSync(decisionPath, 'utf8') || '');
  const firstBullet = body
    .split('\n')
    .map((line: string) => String(line || '').trim())
    .find((line: string) => /^[-*]\s+/.test(line));
  if (!firstBullet) {
    return 'Preserve deterministic behavior and fail-closed security boundaries before merge.';
  }
  return cleanText(firstBullet.replace(/^[-*]\s+/, ''), 220);
}

function gitCapture(args: string[]) {
  return spawnSync('git', args, {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

function loadStagedFiles(): string[] {
  const out = gitCapture(['diff', '--cached', '--name-only']);
  if (Number.isFinite(out.status) && out.status !== 0) {
    return [];
  }
  return String(out.stdout || '')
    .split('\n')
    .map((line) => cleanText(line, 300))
    .filter(Boolean);
}

function loadStagedDiff(diffFile: string): string {
  if (diffFile) {
    const abs = path.isAbsolute(diffFile) ? diffFile : path.join(ROOT, diffFile);
    if (!fs.existsSync(abs)) return '';
    return String(fs.readFileSync(abs, 'utf8') || '');
  }
  const out = gitCapture(['diff', '--cached', '--no-color', '--unified=0']);
  if (Number.isFinite(out.status) && out.status !== 0) {
    return '';
  }
  return String(out.stdout || '');
}

function analyzeDiff(diff: string): RiskFinding[] {
  const findings: RiskFinding[] = [];
  const detectors: Array<{ id: string, severity: 'low' | 'medium' | 'high', reason: string, regex: RegExp }> = [
    {
      id: 'disable_security_gate',
      severity: 'high',
      reason: 'Possible security/sovereignty gate disable or bypass',
      regex: /\b(?:disable|bypass|override|remove)\b.{0,60}\b(?:security|guard|gate|sovereignty|veto|covenant|fail[-_ ]?closed)\b/i
    },
    {
      id: 'fail_open_pattern',
      severity: 'high',
      reason: 'Fail-open pattern detected',
      regex: /\bfail[-_ ]?open\b|\ballow_all\b|\bskip_(?:guard|security|auth)\b/i
    },
    {
      id: 'secret_literal',
      severity: 'high',
      reason: 'Potential hardcoded secret/token/key in staged diff',
      regex: /(?:secret|token|api[_-]?key|private[_-]?key)\s*[:=]\s*['\"][A-Za-z0-9_\-]{12,}/i
    },
    {
      id: 'test_bypass_language',
      severity: 'medium',
      reason: 'Potential test/verification bypass language',
      regex: /\b(?:skip|bypass|disable)\b.{0,40}\b(?:test|tests|verification|verify|parity|regression)\b/i
    },
    {
      id: 'emergency_override',
      severity: 'medium',
      reason: 'Emergency/override pathway touched in staged lines',
      regex: /\bemergency\b|\boverride\b|\bforce\b/i
    }
  ];

  const addedLines = String(diff || '')
    .split('\n')
    .map((line) => String(line || ''))
    .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
    .map((line) => line.slice(1).trim())
    .filter(Boolean)
    .slice(0, 1500);

  for (const line of addedLines) {
    for (const detector of detectors) {
      if (!detector.regex.test(line)) continue;
      findings.push({
        id: detector.id,
        severity: detector.severity,
        reason: detector.reason,
        line: cleanText(line, 320)
      });
    }
  }
  return findings;
}

function scoreTier(findings: RiskFinding[]): { tier: 'low' | 'medium' | 'high', score: number } {
  let score = 0;
  for (const finding of findings) {
    if (finding.severity === 'high') score += 3;
    else if (finding.severity === 'medium') score += 2;
    else score += 1;
  }
  const high = findings.some((f) => f.severity === 'high');
  if (high || score >= 4) return { tier: 'high', score };
  if (score >= 2) return { tier: 'medium', score };
  return { tier: 'low', score };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const personaId = normalizeToken(args.persona || 'vikram_menon', 120) || 'vikram_menon';
  const allowHighRisk = toBool(args['allow-high-risk'], false);
  const dryRun = toBool(args['dry-run'], false);
  const diffFile = cleanText(args['diff-file'] || '', 400);

  const files = loadStagedFiles();
  const diff = loadStagedDiff(diffFile);
  const findings = analyzeDiff(diff);
  const tier = scoreTier(findings);
  const recommendation = readDecisionLensHint(personaId);

  const payload = {
    ok: tier.tier !== 'high' || allowHighRisk,
    type: 'pre_commit_lens_gate',
    ts: nowIso(),
    persona_id: personaId,
    root: ROOT,
    staged_files: files,
    staged_file_count: files.length,
    findings_count: findings.length,
    risk_score: tier.score,
    risk_tier: tier.tier,
    allow_high_risk: allowHighRisk,
    recommendation,
    findings: findings.slice(0, 20),
    fail_closed: tier.tier === 'high' && !allowHighRisk,
    reason: tier.tier === 'high' && !allowHighRisk
      ? 'high_risk_diff_detected'
      : (tier.tier === 'high' && allowHighRisk
        ? 'high_risk_allowed_by_override'
        : 'risk_within_gate')
  };

  if (!dryRun) {
    writeJsonAtomic(LATEST_PATH, payload);
    appendJsonl(HISTORY_PATH, payload);
  }

  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  if (payload.ok !== true) {
    process.stderr.write('pre_commit_lens_gate_blocked\n');
    process.exit(1);
  }
  process.exit(0);
}

main();
