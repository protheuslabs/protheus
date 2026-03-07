# F100 Enterprise Baseline Status

Generated: 2026-03-06T16:44:45.768Z

| Check | Type | Path | Status | Reason |
|---|---|---|---|---|
| `license_apache2` | `file_contains` | `LICENSE` | PASS | `ok` |
| `security_posture_doc` | `file_exists` | `client/docs/SECURITY_POSTURE.md` | PASS | `ok` |
| `dependabot_enabled` | `file_exists` | `.github/dependabot.yml` | PASS | `ok` |
| `codeql_enabled` | `file_exists` | `.github/workflows/codeql.yml` | PASS | `ok` |
| `sbom_release_workflow` | `file_exists` | `.github/workflows/release-security-artifacts.yml` | PASS | `ok` |
| `coverage_workflow` | `file_exists` | `.github/workflows/coverage.yml` | PASS | `ok` |
| `helm_packaging_present` | `file_exists` | `client/deploy/helm/protheus/Chart.yaml` | PASS | `ok` |
| `terraform_packaging_present` | `file_exists` | `client/deploy/terraform/protheus_helm/main.tf` | PASS | `ok` |
| `human_split_compliance_certs` | `file_contains` | `client/docs/HUMAN_ONLY_ACTIONS.md` | PASS | `ok` |

## Summary

- Total checks: 9
- Passed checks: 9
- Failed checks: 0
- Contract status: PASS
- Receipt hash: `6efdc9c015120cc7849a184f31a5ec4c486db3eda989880c9ebdd19319cee9f0`
