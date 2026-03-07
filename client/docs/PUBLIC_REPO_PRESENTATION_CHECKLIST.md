# Public Repo Presentation Checklist

`V4-CLEAN-005` ensures optics improve without destructive history operations.

## Surface Checklist

- naming consistency across README/client/docs/config surfaces
- docs mapping from top-level README to operator/developer materials
- root hygiene pass via `root_surface_contract`
- docs hygiene pass via `docs_surface_contract`
- linguist normalization present in `.gitattributes`

## Non-Destructive Constraint

Automated cleanup lanes must not use history-rewrite operations:

- `commit --amend`
- `push --force`
- `reset --hard`

## Verification Bundle

Run:

```bash
node client/systems/ops/public_repo_presentation_pass.js verify --strict=1
```

This writes a verification bundle under:

- `state/ops/public_repo_presentation_pass/verification_bundle.json`
