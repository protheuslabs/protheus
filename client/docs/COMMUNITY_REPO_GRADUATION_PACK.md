# Community Repo Graduation Pack

`V4-MIGR-002` generates and verifies the migration artifacts that make the old → new repository path unambiguous.

## Outputs

- `client/docs/migration/community_repo_banner.md`
- `client/docs/migration/pinned_migration_issue.md`
- `client/docs/migration/repo_redirect.json`
- Optional README banner injection (between marker comments)

## Command

```bash
# Generate + verify only
node client/systems/migration/community_repo_graduation_pack.js run \
  --legacy-repo=https://github.com/openclaw/openclaw \
  --target-repo=https://github.com/protheuslabs/protheus

# Apply artifacts and update README banner
node client/systems/migration/community_repo_graduation_pack.js run \
  --legacy-repo=https://github.com/openclaw/openclaw \
  --target-repo=https://github.com/protheuslabs/protheus \
  --apply=1 --strict=1
```

## Verification Contract

The lane verifies that:

- Banner/pinned issue/redirect artifacts exist.
- One-click link to the official repository is present.
- Migration guide evidence link is included.
- Legacy README remains discoverable via explicit migration banner.

Receipts are written to `state/migration/community_repo_graduation/`.
