#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

function parseArgs(argv) {
  const args = {
    manifest: 'docs/client/community/contributors_manifest.json',
    outDir: 'core/local/artifacts/empty-fort',
    releaseTag: process.env.GITHUB_REF_NAME || 'local'
  };
  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--manifest=')) args.manifest = token.slice('--manifest='.length);
    else if (token.startsWith('--out-dir=')) args.outDir = token.slice('--out-dir='.length);
    else if (token.startsWith('--release-tag=')) args.releaseTag = token.slice('--release-tag='.length);
  }
  return args;
}

function gitCount(args) {
  const res = spawnSync('git', args, { encoding: 'utf8' });
  if (res.status !== 0) return null;
  return (res.stdout || '').trim();
}

function main() {
  const args = parseArgs(process.argv);
  const manifestPath = path.resolve(args.manifest);
  const outDir = path.resolve(args.outDir);
  fs.mkdirSync(outDir, { recursive: true });

  let contributorCount = 0;
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    contributorCount = Array.isArray(manifest.contributors) ? manifest.contributors.length : 0;
  }

  const commitCount = Number(gitCount(['rev-list', '--count', 'HEAD']) || 0);
  const shortSha = gitCount(['rev-parse', '--short=12', 'HEAD']) || 'unknown';

  const payload = {
    generated_at: new Date().toISOString(),
    release_tag: args.releaseTag,
    short_sha: shortSha,
    contributors: contributorCount,
    commits: commitCount,
    badges: {
      contributors: `${contributorCount} contributors`,
      commits: `${commitCount} commits`
    }
  };

  const jsonPath = path.join(outDir, 'empty_fort_visual_metrics.json');
  const mdPath = path.join(outDir, 'empty_fort_visual_metrics.md');

  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2) + '\n');
  fs.writeFileSync(
    mdPath,
    [
      '# Empty Fort Visual Metrics',
      '',
      `- Release tag: ${payload.release_tag}`,
      `- Commit: ${payload.short_sha}`,
      `- Contributors: ${payload.contributors}`,
      `- Commits: ${payload.commits}`,
      ''
    ].join('\n')
  );

  console.log(JSON.stringify({ ok: true, out_dir: path.relative(process.cwd(), outDir), metrics: payload }, null, 2));
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }, null, 2));
    process.exit(1);
  }
}
