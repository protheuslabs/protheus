# Backlog GitHub Sync

One-way mirror from local canonical backlog registry to GitHub Issues.

## Purpose

- Keep local backlog contracts as source of truth (`config/backlog_registry.json`)
- Publish active queued/doing items to GitHub Issues for human visibility and PR linkage
- Preserve deterministic local receipts/state for replay and auditing

## Commands

```bash
npm run ops:backlog:github:status
npm run ops:backlog:github:sync          # dry-run by default
npm run ops:backlog:github:apply         # writes to GitHub
npm run ops:backlog:github:check
```

## Auth

The lane uses `gh` CLI and requires auth for `--apply=1`:

```bash
gh auth login
```

## Policy

Default policy file:

- `config/backlog_github_sync_policy.json`

Key controls:

- `dry_run_default`
- `sync_statuses`
- `github.owner` / `github.repo`
- `github.update_labels`
- `github.create_missing_labels`
- `github.project_sync` + `github.project_v2_id` (optional)

## Artifacts

- Latest receipt: `state/ops/backlog_github_sync/latest.json`
- Receipt history: `state/ops/backlog_github_sync/receipts.jsonl`
- Mapping state: `state/ops/backlog_github_sync/state.json`

## Spine Automation

Daily spine can run registry + GitHub mirror automatically.

Environment flags:

- `SPINE_BACKLOG_GITHUB_SYNC_ENABLED=1` (default `1`)
- `SPINE_BACKLOG_GITHUB_SYNC_APPLY=0|1` (default `0`, dry-run safety)
- `SPINE_BACKLOG_GITHUB_SYNC_STRICT=0|1` (default `1`)
- `SPINE_BACKLOG_GITHUB_SYNC_LIMIT=<n>` (optional)
- `SPINE_BACKLOG_GITHUB_SYNC_STATUSES=queued,in_progress,...` (optional)

Recommended enablement:

```bash
gh auth login
SPINE_BACKLOG_GITHUB_SYNC_ENABLED=1 \
SPINE_BACKLOG_GITHUB_SYNC_APPLY=1 \
node systems/spine/spine.js daily
```
