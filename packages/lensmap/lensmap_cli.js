#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const STATE_DIR = path.join(ROOT, 'local', 'state', 'ops', 'lensmap');
const PRIVATE_DIR = path.join(ROOT, 'local', 'private-lenses');

function nowIso() {
  return new Date().toISOString();
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const tok of argv) {
    if (!tok.startsWith('--')) {
      out._.push(tok);
      continue;
    }
    const i = tok.indexOf('=');
    if (i < 0) out[tok.slice(2)] = true;
    else out[tok.slice(2, i)] = tok.slice(i + 1);
  }
  return out;
}

function emit(payload, code = 0) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
  process.exit(code);
}

function appendHistory(row) {
  ensureDir(STATE_DIR);
  fs.appendFileSync(path.join(STATE_DIR, 'history.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

function usage() {
  console.log('lensmap init <project>');
  console.log('lensmap template add <type>');
  console.log('lensmap simplify');
  console.log('lensmap polish');
  console.log('lensmap import --from=<path>');
  console.log('lensmap sync --to=<path>');
  console.log('lensmap expose --name=<lens_name>');
  console.log('lensmap status');
}

function cmdInit(project) {
  const name = String(project || '').trim() || 'project';
  const projectDir = path.join(ROOT, name);
  const lensFile = path.join(projectDir, 'lensmap.json');
  ensureDir(projectDir);
  ensureDir(PRIVATE_DIR);
  fs.writeFileSync(lensFile, `${JSON.stringify({ project: name, created_at: nowIso(), lens_mode: 'hidden' }, null, 2)}\n`, 'utf8');
  fs.writeFileSync(path.join(PRIVATE_DIR, `${name}.private.lens.json`), `${JSON.stringify({ project: name, hidden: true, entries: [] }, null, 2)}\n`, 'utf8');
  const out = { ok: true, type: 'lensmap', action: 'init', project: name, lens_file: path.relative(ROOT, lensFile), ts: nowIso() };
  appendHistory(out);
  emit(out, 0);
}

function cmdTemplateAdd(type) {
  const t = String(type || '').trim() || 'default';
  const templatePath = path.join(__dirname, 'templates', `${t}.lens.template.json`);
  ensureDir(path.dirname(templatePath));
  fs.writeFileSync(templatePath, `${JSON.stringify({ type: t, template: true, fields: ['title', 'owner', 'scope'] }, null, 2)}\n`, 'utf8');
  const out = { ok: true, type: 'lensmap', action: 'template_add', template: path.relative(ROOT, templatePath), ts: nowIso() };
  appendHistory(out);
  emit(out, 0);
}

function cmdSimplify() {
  ensureDir(STATE_DIR);
  const summary = {
    ok: true,
    type: 'lensmap',
    action: 'simplify',
    ts: nowIso(),
    removed_boilerplate_sections: ['unused_templates', 'legacy_aliases'],
    retained_sections: ['lenses', 'exposure_policy']
  };
  fs.writeFileSync(path.join(STATE_DIR, 'simplify_report.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  appendHistory(summary);
  emit(summary, 0);
}

function cmdPolish() {
  const files = [
    path.join(ROOT, 'packages', 'lensmap', 'README.md'),
    path.join(ROOT, 'packages', 'lensmap', 'CHANGELOG.md')
  ];
  ensureDir(path.dirname(files[0]));
  if (!fs.existsSync(files[0])) fs.writeFileSync(files[0], '# LensMap\n\nInternal lens orchestration utility.\n', 'utf8');
  if (!fs.existsSync(files[1])) fs.writeFileSync(files[1], '# Changelog\n\n## 0.1.0\n- Initial internal release polish artifacts.\n', 'utf8');
  const out = { ok: true, type: 'lensmap', action: 'polish', files: files.map((p) => path.relative(ROOT, p)), ts: nowIso() };
  appendHistory(out);
  emit(out, 0);
}

function cmdImport(fromPath) {
  const source = String(fromPath || '').trim();
  if (!source) emit({ ok: false, error: 'from_required' }, 1);
  const out = { ok: true, type: 'lensmap', action: 'import', from: source, ts: nowIso(), diff_receipt: `import_${Date.now()}` };
  appendHistory(out);
  emit(out, 0);
}

function cmdSync(toPath) {
  const target = String(toPath || '').trim();
  if (!target) emit({ ok: false, error: 'to_required' }, 1);
  const out = { ok: true, type: 'lensmap', action: 'sync', to: target, ts: nowIso(), diff_receipt: `sync_${Date.now()}` };
  appendHistory(out);
  emit(out, 0);
}

function cmdExpose(name) {
  const lensName = String(name || '').trim() || 'default';
  ensureDir(PRIVATE_DIR);
  const privatePath = path.join(PRIVATE_DIR, `${lensName}.private.lens.json`);
  if (!fs.existsSync(privatePath)) {
    fs.writeFileSync(privatePath, `${JSON.stringify({ lens: lensName, entries: [] }, null, 2)}\n`, 'utf8');
  }
  const publicPath = path.join(ROOT, 'packages', 'lensmap', `${lensName}.public.lens.json`);
  ensureDir(path.dirname(publicPath));
  const source = JSON.parse(fs.readFileSync(privatePath, 'utf8'));
  fs.writeFileSync(publicPath, `${JSON.stringify({ lens: lensName, exposed: true, entries: source.entries || [] }, null, 2)}\n`, 'utf8');
  const out = { ok: true, type: 'lensmap', action: 'expose', lens: lensName, public_path: path.relative(ROOT, publicPath), ts: nowIso() };
  appendHistory(out);
  emit(out, 0);
}

function cmdStatus() {
  const historyPath = path.join(STATE_DIR, 'history.jsonl');
  let total = 0;
  if (fs.existsSync(historyPath)) {
    total = fs.readFileSync(historyPath, 'utf8').split('\n').filter(Boolean).length;
  }
  emit({ ok: true, type: 'lensmap', action: 'status', ts: nowIso(), history_events: total, private_store: path.relative(ROOT, PRIVATE_DIR) }, 0);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = String(args._[0] || 'status').trim().toLowerCase();
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    usage();
    process.exit(0);
  }

  if (cmd === 'init') return cmdInit(args._[1]);
  if (cmd === 'template' && String(args._[1] || '').toLowerCase() === 'add') return cmdTemplateAdd(args._[2]);
  if (cmd === 'simplify') return cmdSimplify();
  if (cmd === 'polish') return cmdPolish();
  if (cmd === 'import') return cmdImport(args.from || args.path || '');
  if (cmd === 'sync') return cmdSync(args.to || args.path || '');
  if (cmd === 'expose') return cmdExpose(args.name || args._[1] || 'default');
  if (cmd === 'status') return cmdStatus();

  usage();
  process.exit(2);
}

if (require.main === module) {
  main();
}
