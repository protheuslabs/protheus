# Developer Lane Quickstart

Goal: ship your first custom lane **under 10 minutes**.

## 1) Bootstrap (2 minutes)

```bash
npm ci
npm run typecheck:systems
```

## 2) Create lane files (3 minutes)

Create:

- `client/systems/<domain>/my_lane.ts`
- `client/systems/<domain>/my_lane.js` (ts bootstrap wrapper)
- `client/config/my_lane_policy.json`
- `client/memory/tools/tests/my_lane.test.js`

Use a deterministic JSON output contract and include `--strict` behavior.

## 3) Wire docs + checks (3 minutes)

Update docs references:

- `README.md` if command surface changed
- `client/docs/README.md` for discoverability
- `CHANGELOG.md` for user-visible behavior

Run:

```bash
node client/memory/tools/tests/my_lane.test.js
node client/systems/ops/docs_surface_contract.js check --strict=1
node client/systems/ops/root_surface_contract.js check --strict=1
```

## 4) Rollback path (2 minutes)

Every lane must include rollback behavior before merge:

- feature flag or policy off-switch
- explicit fallback reason codes
- command-level rollback path in output/docs

Example rollback command pattern:

```bash
node client/systems/<domain>/my_lane.js run --force-fallback=1 --strict=1
```

## Done Criteria

- Tests green
- Docs linked and discoverable
- Rollback path documented
- Changelog updated (if behavior changed)
