#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const PERSONAS_DIR = path.join(ROOT, 'personas');
const ORG_DIR = path.join(PERSONAS_DIR, 'organization');
const REPO_COMMIT_URL_RE = /^https:\/\/github\.com\/protheuslabs\/protheus\/commit\/([0-9a-f]{7,40})$/i;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '');
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const eq = token.indexOf('=');
    if (eq >= 0) {
      out[token.slice(2, eq)] = token.slice(eq + 1);
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

function boolFlag(v, fallback = false) {
  if (v == null || v === '') return fallback;
  const raw = String(v).trim().toLowerCase();
  if (['1', 'true', 'on', 'yes'].includes(raw)) return true;
  if (['0', 'false', 'off', 'no'].includes(raw)) return false;
  return fallback;
}

function readText(filePath) {
  return String(fs.readFileSync(filePath, 'utf8') || '');
}

function gitCommitExists(hash) {
  if (!hash) return false;
  try {
    execSync(`git cat-file -e ${hash}^{commit}`, {
      cwd: ROOT,
      stdio: 'ignore'
    });
    return true;
  } catch {
    return false;
  }
}

function extractMarkdownLinks(markdown) {
  const links = [];
  const re = /\[([^\]]+)\]\(([^)]+)\)/g;
  let m;
  while ((m = re.exec(String(markdown || '')))) {
    links.push({ text: m[1], url: m[2] });
  }
  return links;
}

function sectionBody(markdown, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^##\\s+${escaped}\\s*$([\\s\\S]*?)(?=^##\\s+|\\Z)`, 'm');
  const hit = String(markdown || '').match(re);
  return hit && hit[1] ? hit[1].trim() : '';
}

function listPersonaDirs() {
  if (!fs.existsSync(PERSONAS_DIR)) return [];
  return fs.readdirSync(PERSONAS_DIR, { withFileTypes: true })
    .filter((entry) => entry && entry.isDirectory())
    .map((entry) => String(entry.name || ''))
    .filter((name) => !['organization', 'controls'].includes(name))
    .filter((name) => fs.existsSync(path.join(PERSONAS_DIR, name, 'profile.md')))
    .sort();
}

function validateProfile(personaId, profilePath) {
  const failures = [];
  const profile = readText(profilePath);
  const required = [
    'Role',
    'Professional Profile',
    'Cognitive Style',
    'Strengths',
    'Failure Modes',
    'Communication Style'
  ];
  for (const heading of required) {
    if (!new RegExp(`^##\\s+${heading}\\s*$`, 'm').test(profile)) {
      failures.push(`${personaId}:profile_missing_section:${heading}`);
    }
  }
  const cognitive = sectionBody(profile, 'Cognitive Style');
  if (cognitive) {
    const hasEmotionSignal = /(emotion|vigil|frustr|resolve|calm|anx|empath|baseline)/i.test(cognitive);
    if (!hasEmotionSignal) {
      failures.push(`${personaId}:profile_cognitive_style_missing_emotion_mirror`);
    }
  }
  return failures;
}

function splitCorrespondenceEntries(correspondence) {
  const raw = String(correspondence || '');
  const chunks = raw.split(/\n##\s+/).slice(1);
  return chunks.map((chunk) => {
    const firstNl = chunk.indexOf('\n');
    const title = firstNl >= 0 ? chunk.slice(0, firstNl).trim() : chunk.trim();
    const body = firstNl >= 0 ? chunk.slice(firstNl + 1).trim() : '';
    return { title, body, length: body.length };
  });
}

function validateCorrespondence(personaId, correspondencePath) {
  const failures = [];
  const body = readText(correspondencePath);
  const entries = splitCorrespondenceEntries(body);
  if (entries.length < 5) {
    failures.push(`${personaId}:correspondence_insufficient_entries:${entries.length}`);
  }
  const lengths = new Set(entries.map((entry) => entry.length).filter((n) => n > 0));
  if (lengths.size < 2) {
    failures.push(`${personaId}:correspondence_lacks_natural_variation`);
  }

  const links = extractMarkdownLinks(body);
  if (!links.length) {
    failures.push(`${personaId}:correspondence_missing_references`);
  }
  for (const link of links) {
    const match = String(link.url || '').match(REPO_COMMIT_URL_RE);
    if (!match) {
      failures.push(`${personaId}:correspondence_non_commit_reference:${link.url}`);
      continue;
    }
    const hash = String(match[1] || '').toLowerCase();
    if (!gitCommitExists(hash)) {
      failures.push(`${personaId}:correspondence_unknown_commit:${hash}`);
    }
  }
  return failures;
}

function validateDisagreementsJsonl(filePath) {
  const failures = [];
  if (!fs.existsSync(filePath)) {
    return ['organization:missing_disagreements_jsonl'];
  }
  const lines = readText(filePath)
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (!lines.length) {
    return ['organization:empty_disagreements_jsonl'];
  }
  const ids = new Set();
  for (let i = 0; i < lines.length; i += 1) {
    let row = null;
    try {
      row = JSON.parse(lines[i]);
    } catch {
      failures.push(`organization:disagreements_json_parse_failed:line_${i + 1}`);
      continue;
    }
    const id = String(row.id || '').trim();
    const topic = String(row.topic || '').trim();
    const resolution = String(row.resolution || '').trim();
    const personas = Array.isArray(row.personas) ? row.personas : [];
    const refs = Array.isArray(row.references) ? row.references : [];
    if (!id || !topic || !resolution || !personas.length || !refs.length) {
      failures.push(`organization:disagreements_row_missing_fields:${i + 1}`);
      continue;
    }
    if (ids.has(id)) failures.push(`organization:duplicate_disagreement_id:${id}`);
    ids.add(id);
    for (const ref of refs) {
      const hash = String(ref && ref.hash || '').trim().toLowerCase();
      if (!hash || !gitCommitExists(hash)) {
        failures.push(`organization:invalid_disagreement_commit_ref:${id}:${hash || 'missing'}`);
      }
    }
  }
  return failures;
}

function validateOrganizationDocs() {
  const failures = [];
  const orgPath = path.join(ORG_DIR, 'organization.md');
  const meetingsPath = path.join(ORG_DIR, 'meetings.md');
  const disagreementsPath = path.join(ORG_DIR, 'disagreements.jsonl');
  const templatePath = path.join(ORG_DIR, 'data_permissions.template.md');

  if (!fs.existsSync(orgPath)) failures.push('organization:missing_organization_md');
  if (!fs.existsSync(meetingsPath)) failures.push('organization:missing_meetings_md');
  if (!fs.existsSync(templatePath)) failures.push('organization:missing_data_permissions_template');

  if (fs.existsSync(orgPath)) {
    const org = readText(orgPath);
    if (!/Org Chart \(ASCII\)/.test(org) || !/[├└]─/.test(org)) {
      failures.push('organization:missing_ascii_org_chart');
    }
    if (!/Resolved Disagreements/.test(org)) {
      failures.push('organization:missing_resolved_disagreements_section');
    }
  }

  if (fs.existsSync(meetingsPath)) {
    const meetings = readText(meetingsPath);
    const count = (meetings.match(/^##\s+/gm) || []).length;
    if (count < 2) failures.push(`organization:insufficient_meeting_summaries:${count}`);
    if (!/dis-\d+/i.test(meetings)) failures.push('organization:meeting_summaries_missing_disagreement_links');
    for (const link of extractMarkdownLinks(meetings)) {
      const match = String(link.url || '').match(REPO_COMMIT_URL_RE);
      if (!match) failures.push(`organization:meeting_invalid_reference:${link.url}`);
      else if (!gitCommitExists(String(match[1] || '').toLowerCase())) {
        failures.push(`organization:meeting_unknown_commit:${match[1]}`);
      }
    }
  }

  failures.push(...validateDisagreementsJsonl(disagreementsPath));
  return failures;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const strict = boolFlag(args.strict, false);
  const allowEmpty = boolFlag(args['allow-empty'] ?? args.allow_empty, false);

  const failures = [];
  const personaDirs = listPersonaDirs();
  if (!personaDirs.length && !allowEmpty) {
    failures.push('personas:none_found');
  }

  for (const personaId of personaDirs) {
    const base = path.join(PERSONAS_DIR, personaId);
    const profilePath = path.join(base, 'profile.md');
    const corrPath = path.join(base, 'correspondence.md');
    if (!fs.existsSync(corrPath)) {
      failures.push(`${personaId}:missing_correspondence_md`);
      continue;
    }
    failures.push(...validateProfile(personaId, profilePath));
    failures.push(...validateCorrespondence(personaId, corrPath));
  }

  failures.push(...validateOrganizationDocs());

  const summary = {
    ok: failures.length === 0,
    strict,
    allow_empty: allowEmpty,
    personas_checked: personaDirs.length,
    failures
  };
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (strict && failures.length) process.exit(1);
}

main();
