#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { moltbook_createPost, MoltbookApiError } = require('./moltbook_api');
const { writeContractReceipt } = require('../../lib/action_receipts');

const RECEIPTS_PATH = path.resolve(__dirname, '..', '..', 'state', 'moltbook', 'publish_receipts.jsonl');
const API_BASE = 'https://www.moltbook.com/api/v1';

function usage() {
  console.log('Usage:');
  console.log('  node skills/moltbook/moltbook_publish_guard.js --title="..." --body="..." [--submolt=general] [--dry-run]');
  console.log('  node skills/moltbook/moltbook_publish_guard.js --title-file=... --body-file=... [--submolt=general] [--dry-run]');
  console.log('  node skills/moltbook/moltbook_publish_guard.js --help');
}

function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv) {
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const eq = a.indexOf('=');
    if (eq === -1) out[a.slice(2)] = true;
    else out[a.slice(2, eq)] = a.slice(eq + 1);
  }
  return out;
}

function readJson(p) { return JSON.parse(fs.readFileSync(p, 'utf8')); }
function nowIso() { return new Date().toISOString(); }

function printJson(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function loadApiKey() {
  const candidates = [
    path.join(os.homedir(), '.openclaw', 'workspace', 'config', 'moltbook', 'credentials.json'),
    path.join(os.homedir(), '.config', 'moltbook', 'credentials.json')
  ];
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue;
    try {
      const key = readJson(p).api_key;
      if (typeof key === 'string' && key.trim()) return { apiKey: key.trim(), source: p };
    } catch {
      // continue
    }
  }
  throw new Error('Missing Moltbook api_key in credentials.json');
}

function resolveIfExists(p) {
  if (!p) return null;
  const abs = path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
  return fs.existsSync(abs) ? abs : null;
}

function getTextValue(args, inlineKey, fileKey) {
  if (typeof args[inlineKey] === 'string') return args[inlineKey];
  if (typeof args[fileKey] === 'string') {
    const abs = resolveIfExists(args[fileKey]);
    if (!abs) throw new Error(`file not found: --${fileKey}=${args[fileKey]}`);
    return fs.readFileSync(abs, 'utf8').trim();
  }
  return '';
}

function sameByContent(post, title, body) {
  if (!post || typeof post !== 'object') return false;
  const t = String(post.title || '').trim().toLowerCase();
  const c = String(post.content || post.body || '').trim().toLowerCase();
  const tt = String(title || '').trim().toLowerCase();
  const bb = String(body || '').trim().toLowerCase();
  return (tt && t === tt) || (bb && c.includes(bb.slice(0, 40)));
}

async function fetchJson(pathPart, apiKey) {
  const res = await fetch(`${API_BASE}${pathPart}`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` }
  });
  const txt = await res.text();
  let payload = null;
  try { payload = txt ? JSON.parse(txt) : null; } catch { payload = { raw: txt.slice(0, 400) }; }
  return { ok: res.ok, status: res.status, payload };
}

function normalizePosts(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.posts)) return payload.posts;
  if (payload && payload.data && Array.isArray(payload.data.posts)) return payload.data.posts;
  return [];
}

async function verifyVisible(apiKey, created, title, body) {
  const postId = created && created.post_id;
  if (postId) {
    const direct = await fetchJson(`/posts/${postId}`, apiKey);
    if (direct.ok) {
      const post = direct.payload && direct.payload.post ? direct.payload.post : direct.payload;
      if (sameByContent(post, title, body)) {
        return { verified: true, method: 'post_id_refetch', post_id: postId, status: direct.status };
      }
    }
  }

  for (const route of ['/posts?sort=new&limit=20', '/posts?sort=hot&limit=20']) {
    const feed = await fetchJson(route, apiKey);
    if (!feed.ok) continue;
    const posts = normalizePosts(feed.payload);
    const found = posts.find((p) => sameByContent(p, title, body));
    if (found) {
      return { verified: true, method: 'feed_refetch', post_id: String(found.id || found.post_id || '') || null, status: feed.status };
    }
  }

  return { verified: false, method: 'refetch_failed' };
}

async function run(argv, deps = {}) {
  const createPost = deps.createPost || moltbook_createPost;
  const verifier = deps.verifyVisible || verifyVisible;
  const writer = deps.appendReceipt || ((r, meta) => writeContractReceipt(RECEIPTS_PATH, r, meta));
  const getCreds = deps.loadApiKey || loadApiKey;
  const args = parseArgs(argv);

  if (args.help || argv.length === 0) {
    usage();
    return { exitCode: 0 };
  }

  const title = getTextValue(args, 'title', 'title-file');
  const body = getTextValue(args, 'body', 'body-file');
  const submolt = typeof args.submolt === 'string' && args.submolt.trim() ? args.submolt.trim() : 'general';
  const dryRun = Boolean(args['dry-run']);

  if (!title) throw new Error('Missing title: use --title or --title-file');
  if (!body) throw new Error('Missing body: use --body or --body-file');

  const creds = getCreds();
  if (dryRun) {
    const out = { ok: true, mode: 'dry_run', title_length: title.length, body_length: body.length, submolt_name: submolt };
    printJson(out);
    return { exitCode: 0, out };
  }

  const ts = nowIso();
  const receipt = { ts, action: 'publish_guard', submolt_name: submolt, title_length: title.length, body_length: body.length };

  try {
    const created = await createPost(title, body, creds.apiKey, submolt);
    receipt.create = {
      verified: created.verified === true,
      post_id: created.post_id || null,
      post_url: created.post_url || null,
      verification_method: created.verification && created.verification.method ? created.verification.method : null
    };

    if (created.verified !== true || !created.post_id) {
      receipt.result = 'failed';
      receipt.error = 'CREATE_UNVERIFIED_OR_MISSING_ID';
      writer(receipt, { attempted: true, verified: false });
      printJson({ ok: false, code: 'CREATE_UNVERIFIED_OR_MISSING_ID', receipt });
      return { exitCode: 1, out: receipt };
    }

    const refetch = await verifier(creds.apiKey, created, title, body);
    receipt.refetch = refetch;

    if (refetch.verified !== true) {
      receipt.result = 'failed';
      receipt.error = 'REFETCH_UNVERIFIED';
      writer(receipt, { attempted: true, verified: false });
      printJson({ ok: false, code: 'REFETCH_UNVERIFIED', receipt });
      return { exitCode: 1, out: receipt };
    }

    receipt.result = 'success';
    writer(receipt, { attempted: true, verified: true });
    printJson({
      ok: true,
      action: 'create_post',
      post_id: created.post_id,
      post_url: created.post_url,
      verified: true,
      receipt
    });
    return { exitCode: 0, out: receipt };
  } catch (err) {
    receipt.result = 'failed';
    if (err instanceof MoltbookApiError) {
      receipt.error = { code: err.code, status: err.status, method: err.method, path: err.path, message: err.message };
      writer(receipt, { attempted: true, verified: false });
      printJson({ ok: false, code: err.code, status: err.status, error: err.message, receipt });
      return { exitCode: 1, out: receipt };
    }
    receipt.error = String(err && err.message ? err.message : err);
    writer(receipt, { attempted: true, verified: false });
    printJson({ ok: false, error: receipt.error, receipt });
    return { exitCode: 1, out: receipt };
  }
}

if (require.main === module) {
  run(process.argv.slice(2)).then((r) => process.exit(r.exitCode)).catch((err) => {
    printJson({ ok: false, error: String(err && err.message ? err.message : err) });
    process.exit(1);
  });
}

module.exports = { run, verifyVisible, sameByContent, normalizePosts };
