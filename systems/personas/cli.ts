#!/usr/bin/env node
'use strict';
export {};

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PERSONAS_DIR = path.join(ROOT, 'personas');

type ParsedArgs = {
  _: string[],
  [key: string]: any
};

function usage() {
  console.log('Usage:');
  console.log('  protheus lens <persona> "<query>"');
  console.log('  protheus lens all "<query>"');
  console.log('  protheus lens --persona=<persona> --query="<query>"');
  console.log('  protheus lens --list');
  console.log('');
  console.log('Examples:');
  console.log('  protheus lens vikram "Should we prioritize memory or security first?"');
  console.log('  protheus lens jay_haslam "How can we reduce drift in the loops?"');
  console.log('  protheus lens all "Should we prioritize memory or security first?"');
  console.log('  protheus lens --persona=vikram_menon --query="What is the rollback path?"');
}

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

function cleanText(v: unknown, maxLen = 500): string {
  return String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, maxLen);
}

function normalizeToken(v: unknown, maxLen = 120): string {
  return cleanText(v, maxLen)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function listPersonaIds(): string[] {
  try {
    if (!fs.existsSync(PERSONAS_DIR)) return [];
    return fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
      .filter((entry: any) => entry && entry.isDirectory())
      .map((entry: any) => String(entry.name || ''))
      .filter(Boolean)
      .sort();
  } catch {
    return [];
  }
}

function aliasForms(id: string): Set<string> {
  const forms = new Set<string>();
  const norm = normalizeToken(id, 140);
  const compact = norm.replace(/_/g, '');
  const parts = norm.split('_').filter(Boolean);
  forms.add(norm);
  if (compact) forms.add(compact);
  if (parts[0]) forms.add(parts[0]);
  if (parts.length >= 2) forms.add(`${parts[0]}_${parts[1]}`);
  return forms;
}

function resolvePersonaId(rawPersona: string): string | null {
  const personas = listPersonaIds();
  if (!personas.length) return null;

  const query = normalizeToken(rawPersona, 140);
  if (!query) return null;
  const queryCompact = query.replace(/_/g, '');

  for (const personaId of personas) {
    if (normalizeToken(personaId, 140) === query) {
      return personaId;
    }
  }

  const scored = personas
    .map((personaId) => {
      const forms = aliasForms(personaId);
      let score = 0;
      for (const form of forms) {
        if (form === query) score = Math.max(score, 100);
        if (form === queryCompact) score = Math.max(score, 95);
        if (form.startsWith(query)) score = Math.max(score, 80);
        if (query.startsWith(form)) score = Math.max(score, 70);
        if (form.replace(/_/g, '').startsWith(queryCompact)) score = Math.max(score, 60);
      }
      return { personaId, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || a.personaId.localeCompare(b.personaId));

  return scored.length ? scored[0].personaId : null;
}

function readFileRequired(filePath: string): string {
  if (!fs.existsSync(filePath)) {
    throw new Error(`missing_required_file:${path.relative(ROOT, filePath)}`);
  }
  return String(fs.readFileSync(filePath, 'utf8') || '');
}

type PersonaContext = {
  personaId: string,
  personaName: string,
  profileMd: string,
  correspondenceMd: string,
  lensMd: string
};

function loadPersonaContext(personaId: string): PersonaContext {
  const personaDir = path.join(PERSONAS_DIR, personaId);
  const profileMd = readFileRequired(path.join(personaDir, 'profile.md'));
  const correspondenceMd = readFileRequired(path.join(personaDir, 'correspondence.md'));
  const lensMd = readFileRequired(path.join(personaDir, 'lens.md'));
  const personaName = extractTitle(profileMd, personaId);
  return {
    personaId,
    personaName,
    profileMd,
    correspondenceMd,
    lensMd
  };
}

function extractTitle(markdown: string, fallback: string): string {
  const lines = String(markdown || '').split('\n');
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    if (!trimmed.startsWith('#')) continue;
    const title = cleanText(trimmed.replace(/^#+\s*/, ''), 120);
    if (title) return title;
  }
  return fallback;
}

function extractListItems(markdown: string, maxItems = 4): string[] {
  const out: string[] = [];
  const lines = String(markdown || '').split('\n');
  for (const line of lines) {
    const trimmed = String(line || '').trim();
    const bullet = trimmed.match(/^[-*]\s+(.+)$/);
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    const picked = bullet ? bullet[1] : ordered ? ordered[1] : '';
    const item = cleanText(picked, 200);
    if (!item) continue;
    out.push(item);
    if (out.length >= maxItems) break;
  }
  return out;
}

function recommendFromQuery(personaName: string, query: string): string {
  const lower = String(query || '').toLowerCase();
  if (lower.includes('memory') && lower.includes('security') && (lower.includes('first') || lower.includes('priorit'))) {
    return 'Prioritize memory core determinism first, but keep security enforcement in pre-dispatch path from day one.';
  }
  if (lower.includes('rust') && (lower.includes('migrate') || lower.includes('migration') || lower.includes('cutover'))) {
    return 'Run behavior-preserving migration in thin slices with parity tests; treat source-level Rust composition as the only valid progress metric.';
  }
  if (lower.includes('rollback') || lower.includes('revert')) {
    return 'Define rollback invariants before implementation and prove rollback with an explicit test path.';
  }
  return `Use ${personaName}'s lens to execute the smallest reversible change that strengthens determinism, security posture, and test evidence.`;
}

function buildResponseDetails(
  personaName: string,
  query: string,
  profileMd: string,
  correspondenceMd: string,
  lensMd: string
) {
  const decisionFilters = extractListItems(lensMd, 4);
  const nonNegotiables = extractListItems(lensMd.split('## Non-Negotiables')[1] || '', 4);
  const correspondenceHighlights = extractListItems(correspondenceMd, 3);
  const profileHighlights = extractListItems(profileMd, 3);
  const promptTemplate = `As ${personaName}, using your profile, lens, and past correspondence, respond to: ${query}`;
  const recommendation = recommendFromQuery(personaName, query);
  const reasoning = [
    ...decisionFilters.map((v) => `Decision filter: ${v}`),
    ...nonNegotiables.map((v) => `Constraint: ${v}`),
    ...correspondenceHighlights.map((v) => `Prior correspondence: ${v}`),
    ...profileHighlights.map((v) => `Profile context: ${v}`)
  ].slice(0, 7);
  return {
    promptTemplate,
    recommendation,
    reasoning
  };
}

function renderMarkdownResponse(
  personaId: string,
  personaName: string,
  query: string,
  profileMd: string,
  correspondenceMd: string,
  lensMd: string
): string {
  const {
    promptTemplate,
    recommendation,
    reasoning
  } = buildResponseDetails(personaName, query, profileMd, correspondenceMd, lensMd);

  const lines: string[] = [];
  lines.push(`# Lens Response: ${personaName}`);
  lines.push('');
  lines.push(`**Persona ID:** \`${personaId}\``);
  lines.push(`**Query:** ${query}`);
  lines.push('');
  lines.push(`> ${promptTemplate}`);
  lines.push('');
  lines.push('## Position');
  lines.push(recommendation);
  lines.push('');
  lines.push('## Reasoning');
  if (reasoning.length) {
    for (const row of reasoning) {
      lines.push(`- ${row}`);
    }
  } else {
    lines.push('- No structured context parsed; defaulted to deterministic and fail-closed guidance.');
  }
  lines.push('');
  lines.push('## Suggested Next Steps');
  lines.push('1. Define the invariant and expected receipt fields before implementation.');
  lines.push('2. Implement the smallest behavior-preserving slice.');
  lines.push('3. Run one regression test and one sovereignty/security check before merge.');
  lines.push('');
  lines.push('## Context Files');
  lines.push(`- \`personas/${personaId}/profile.md\``);
  lines.push(`- \`personas/${personaId}/correspondence.md\``);
  lines.push(`- \`personas/${personaId}/lens.md\``);
  lines.push('');
  return lines.join('\n');
}

function renderMarkdownSection(ctx: PersonaContext, query: string): string {
  const {
    promptTemplate,
    recommendation,
    reasoning
  } = buildResponseDetails(ctx.personaName, query, ctx.profileMd, ctx.correspondenceMd, ctx.lensMd);

  const lines: string[] = [];
  lines.push(`## ${ctx.personaName} (\`${ctx.personaId}\`)`);
  lines.push('');
  lines.push(`> ${promptTemplate}`);
  lines.push('');
  lines.push('### Position');
  lines.push(recommendation);
  lines.push('');
  lines.push('### Reasoning');
  if (reasoning.length) {
    for (const row of reasoning) {
      lines.push(`- ${row}`);
    }
  } else {
    lines.push('- No structured context parsed; defaulted to deterministic and fail-closed guidance.');
  }
  lines.push('');
  lines.push('### Context Files');
  lines.push(`- \`personas/${ctx.personaId}/profile.md\``);
  lines.push(`- \`personas/${ctx.personaId}/correspondence.md\``);
  lines.push(`- \`personas/${ctx.personaId}/lens.md\``);
  lines.push('');
  return lines.join('\n');
}

function renderAllMarkdown(query: string, contexts: PersonaContext[]): string {
  const lines: string[] = [];
  lines.push('# Lens Response: All Personas');
  lines.push('');
  lines.push(`**Query:** ${query}`);
  lines.push('');
  for (const ctx of contexts) {
    lines.push(renderMarkdownSection(ctx, query));
  }
  return lines.join('\n');
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.h || args._.includes('help') || args._.includes('--help') || args._.includes('-h')) {
    usage();
    process.exit(0);
  }

  if (args.list === true || String(args.list || '') === '1') {
    const personas = listPersonaIds();
    if (!personas.length) {
      console.log('No personas found under personas/.');
      process.exit(0);
    }
    console.log('Available personas:');
    for (const personaId of personas) {
      console.log(`- ${personaId}`);
    }
    process.exit(0);
  }

  const personaArg = cleanText(args.persona || args._[0] || '', 120);
  const queryArg = cleanText(
    args.query
      || args.q
      || (args._.length > 1 ? args._.slice(1).join(' ') : ''),
    2000
  );
  if (!personaArg || !queryArg) {
    usage();
    process.exit(1);
  }

  if (normalizeToken(personaArg, 120) === 'all') {
    const personaIds = listPersonaIds();
    if (!personaIds.length) {
      process.stderr.write('no_personas_available\n');
      process.exit(1);
    }
    try {
      const contexts = personaIds.map((personaId) => loadPersonaContext(personaId));
      const markdown = renderAllMarkdown(queryArg, contexts);
      process.stdout.write(`${markdown}\n`);
      process.exit(0);
    } catch (err: any) {
      const msg = cleanText(err && err.message || 'persona_lens_all_failed', 260);
      process.stderr.write(`${msg}\n`);
      process.exit(1);
    }
  }

  const personaId = resolvePersonaId(personaArg);
  if (!personaId) {
    const known = listPersonaIds();
    process.stderr.write(`unknown_persona:${personaArg}\n`);
    if (known.length) {
      process.stderr.write(`known_personas:${known.join(', ')}\n`);
    }
    process.exit(1);
  }

  try {
    const ctx = loadPersonaContext(personaId);

    const markdown = renderMarkdownResponse(
      ctx.personaId,
      ctx.personaName,
      queryArg,
      ctx.profileMd,
      ctx.correspondenceMd,
      ctx.lensMd
    );
    process.stdout.write(`${markdown}\n`);
    process.exit(0);
  } catch (err: any) {
    const msg = cleanText(err && err.message || 'persona_lens_failed', 260);
    process.stderr.write(`${msg}\n`);
    process.exit(1);
  }
}

main();
