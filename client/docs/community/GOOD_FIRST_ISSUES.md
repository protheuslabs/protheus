# Good First Issues (Seed Pack)

This file defines ten starter issues with clear scope, deterministic acceptance checks, and labels.

## Labels

Apply these labels to each issue:

- `good first issue`
- `help wanted`
- `area/<area-name>`

## Issue Pack

1. **Conduit: add JSON schema examples for 10 core messages**
- Area: `area/conduit`
- Acceptance:
  - Add `client/docs/conduit/message_examples/*.json` samples for command/event types.
  - Add a test that validates sample files parse as valid JSON.

2. **Ops dashboard: add queue depth sparkline for last 24h**
- Area: `area/ops`
- Acceptance:
  - Extend `protheus-ops status --dashboard` output with queue sparkline.
  - Add regression test covering empty/non-empty queue history.

3. **Docs: add failure-mode troubleshooting section to GETTING_STARTED**
- Area: `area/docs`
- Acceptance:
  - Add “Common Failures” section to `client/docs/GETTING_STARTED.md`.
  - Include at least 5 failure signatures and exact remediation commands.

4. **Installer: verify PATH injection on Linux shell variants**
- Area: `area/install`
- Acceptance:
  - Add shell-detection helper in `install.sh` for bash/zsh/fish guidance.
  - Add script-level test assertions for expected PATH advice strings.

5. **Coverage: publish per-language breakdown in README**
- Area: `area/quality`
- Acceptance:
  - Extend coverage merge script to emit TS vs Rust breakdown.
  - Update README with a short “Coverage Breakdown” section.

6. **Security inventory: add ownership metadata per layer**
- Area: `area/security`
- Acceptance:
  - Add `owner` field per layer in `client/config/security_layer_inventory.json`.
  - Update gate + markdown renderer to include owner column.

7. **Terraform module: add optional image pull secret support**
- Area: `area/deploy`
- Acceptance:
  - Add Terraform variable + helm values wiring for imagePullSecrets.
  - Document usage in `client/deploy/terraform/protheus_helm/README.md`.

8. **Helm chart: add pod annotations + labels override values**
- Area: `area/deploy`
- Acceptance:
  - Add values for pod labels/annotations and wire into cronjob template.
  - Validate render with `helm template` in CI/test harness.

9. **Contributing: add first-PR checklist snippet**
- Area: `area/community`
- Acceptance:
  - Add checklist block to `CONTRIBUTING.md` for first-time contributors.
  - Include local verification command sequence.

10. **Announcement automation: add markdown lint check for launch templates**
- Area: `area/community`
- Acceptance:
  - Add simple markdown lint/consistency check for `client/docs/announcements/`.
  - Include CI wiring and one regression test fixture.

## Optional Seeder Command

When maintainer credentials are available, use the seeder:

```bash
node client/systems/ops/good_first_issue_seed.js --apply=1
```

Dry-run preview:

```bash
node client/systems/ops/good_first_issue_seed.js --apply=0
```
