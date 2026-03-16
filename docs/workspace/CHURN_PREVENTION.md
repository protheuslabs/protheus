# Churn Prevention

## Observed churn sources

1. Local simulation outputs committed by accident:
- `local/**`
- `simulated-commits/**`
- ad hoc credential scratch files (for example `local/workspace/private/*.md`)

2. Generated report drift from repeated audit runs:
- `core/local/artifacts/*_current.json`
- `docs/workspace/*CURRENT*.md`

3. Experimental feature side effects (currently ignored by request):
- `packages/lensmap/**`
- `tests/fixtures/lensmap_*`
- `core/layer0/ops/src/bin/lensmap.rs`

## Controls now in place

1. `.gitignore` guardrails for local/simulated scratch paths.
2. Churn classifier gate:
- `npm run -s ops:churn:guard`
- strict mode fails when local/simulation/lensmap/other unexpected churn is present.
3. Pre-commit churn gate:
- `npm run -s ops:churn:commit-gate`
- fails commits when untracked noise, local/generated churn, or unstaged move-pairs are present.
4. Simplicity drift gate:
- `npm run -s ops:simplicity:audit`
- ensures no duplicated command bodies and no client boundary drift.

## Recommended workflow

1. Before commit:

```bash
npm run -s ops:churn:commit-gate
npm run -s ops:churn:guard
npm run -s ops:simplicity:audit
```

2. Before push:

```bash
./verify.sh
```

3. If churn appears:
- classify into `actual work` vs `generated/local`.
- commit only `actual work`.
- clear generated/local churn before final checkpoint.
