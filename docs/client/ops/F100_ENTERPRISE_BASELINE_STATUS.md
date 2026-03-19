# F100 Enterprise Baseline Status

Generated: 2026-03-08T05:19:04.541Z

| Check | Type | Path | Status | Reason |
|---|---|---|---|---|
| `license_apache2` | `file_contains` | `LICENSE` | PASS | `ok` |
| `security_posture_doc` | `file_exists` | `docs/client/SECURITY_POSTURE.md` | PASS | `ok` |
| `dependabot_enabled` | `file_exists` | `.github/dependabot.yml` | PASS | `ok` |
| `codeql_enabled` | `file_exists` | `.github/workflows/codeql.yml` | PASS | `ok` |
| `sbom_release_workflow` | `file_exists` | `.github/workflows/release-security-artifacts.yml` | PASS | `ok` |
| `ga_release_pipeline_present` | `file_exists` | `.github/workflows/release.yml` | PASS | `ok` |
| `ga_release_semver_contract` | `file_contains` | `.github/workflows/release.yml` | PASS | `ok` |
| `ga_release_spdx_sbom_attach` | `file_contains` | `.github/workflows/release.yml` | PASS | `ok` |
| `ga_release_signatures_attached` | `file_contains` | `.github/workflows/release.yml` | PASS | `ok` |
| `slsa_attestation_release_workflow` | `file_contains` | `.github/workflows/release-security-artifacts.yml` | PASS | `ok` |
| `coverage_workflow` | `file_exists` | `.github/workflows/coverage.yml` | PASS | `ok` |
| `helm_packaging_present` | `file_exists` | `client/runtime/deploy/helm/protheus/Chart.yaml` | PASS | `ok` |
| `helm_conformance_ci_present` | `file_exists` | `.github/workflows/helm-conformance.yml` | PASS | `ok` |
| `helm_sso_values_present` | `file_contains` | `client/runtime/deploy/helm/protheus/values.yaml` | PASS | `ok` |
| `helm_vault_values_present` | `file_contains` | `client/runtime/deploy/helm/protheus/values.yaml` | PASS | `ok` |
| `helm_nvidia_values_present` | `file_contains` | `client/runtime/deploy/helm/protheus/values.yaml` | PASS | `ok` |
| `helm_daemon_multinode_present` | `file_exists` | `client/runtime/deploy/helm/protheus/templates/deployment.yaml` | PASS | `ok` |
| `helm_conformance_test_hook_present` | `file_exists` | `client/runtime/deploy/helm/protheus/templates/tests/conformance.yaml` | PASS | `ok` |
| `terraform_packaging_present` | `file_exists` | `client/runtime/deploy/terraform/protheus_helm/main.tf` | PASS | `ok` |
| `terraform_enterprise_inputs_present` | `file_contains` | `client/runtime/deploy/terraform/protheus_helm/variables.tf` | PASS | `ok` |
| `docker_supply_chain_workflow_present` | `file_exists` | `.github/workflows/docker-supply-chain.yml` | PASS | `ok` |
| `dockerfile_fips_contract_present` | `file_contains` | `Dockerfile` | PASS | `ok` |
| `dependabot_required_checks_contract` | `file_contains` | `.github/workflows/required-checks.yml` | PASS | `ok` |
| `codeql_required_checks_contract` | `file_contains` | `.github/workflows/required-checks.yml` | PASS | `ok` |
| `runtime_telemetry_policy_present` | `file_exists` | `client/runtime/config/runtime_telemetry_policy.json` | PASS | `ok` |
| `runtime_telemetry_lane_present` | `file_exists` | `client/runtime/systems/observability/runtime_telemetry_optin.ts` | PASS | `ok` |
| `k8s_secret_runtime_manifest_present` | `file_exists` | `client/runtime/deploy/k8s/secret.runtime.example.yaml` | PASS | `ok` |
| `helm_secret_wiring_enabled` | `file_contains` | `client/runtime/deploy/helm/protheus/templates/cronjob.yaml` | PASS | `ok` |
| `enterprise_support_template_present` | `file_exists` | `docs/client/ENTERPRISE_SUPPORT_ENVELOPE_TEMPLATE.md` | PASS | `ok` |
| `case_study_template_present` | `file_exists` | `docs/client/REFERENCE_CUSTOMER_CASE_STUDY_TEMPLATE.md` | PASS | `ok` |
| `legal_packet_checklist_present` | `file_exists` | `docs/client/LEGAL_ENTERPRISE_PACKET_CHECKLIST.md` | PASS | `ok` |
| `a_plus_gate_rust_lane_present` | `file_exists` | `core/layer0/ops/src/f100_reliability_certification.rs` | PASS | `ok` |
| `human_split_compliance_certs` | `file_contains` | `docs/client/HUMAN_ONLY_ACTIONS.md` | PASS | `ok` |

## Summary

- Total checks: 33
- Passed checks: 33
- Failed checks: 0
- Contract status: PASS
- Receipt hash: `81fec63c7fb5fc4fed2c09d0cdc6f9a211ffa65ae92d90109ba76913f038a7c2`
