# F100 A+ Readiness Status

Generated: 2026-03-08T05:22:11.440Z

| Check | Status | Expected | Actual | Source |
|---|---|---|---|---|
| `enterprise_baseline_contract_pass` | PASS | `baseline.ok == true` | `true` | `local/state/ops/f100_readiness_program/v6_f100_012/latest.json` |
| `combined_coverage_threshold` | FAIL | `combined_lines_pct >= 90` | `77.63` | `docs/client/reports/coverage_baseline_2026-03-06.json` |
| `semantic_release_cadence` | FAIL | `v* tags >= 9` | `0` | `git tag -l v*` |
| `release_slsa_attestation_enabled` | PASS | `release workflow contains actions/attest-build-provenance@v2` | `present` | `.github/workflows/release-security-artifacts.yml` |
| `support_envelope_template_present` | PASS | `support template exists` | `present` | `docs/client/ENTERPRISE_SUPPORT_ENVELOPE_TEMPLATE.md` |
| `case_study_template_present` | PASS | `case study template exists` | `present` | `docs/client/REFERENCE_CUSTOMER_CASE_STUDY_TEMPLATE.md` |
| `legal_packet_checklist_present` | PASS | `legal packet checklist exists` | `present` | `docs/client/LEGAL_ENTERPRISE_PACKET_CHECKLIST.md` |
| `human_owner_blockers_registered` | PASS | `all markers present: HMAN-026, HMAN-027, HMAN-028, HMAN-029, HMAN-030, HMAN-031, HMAN-032, HMAN-033, HMAN-034, HMAN-035` | `all_markers_present` | `docs/client/HUMAN_ONLY_ACTIONS.md` |

## Summary

- Total checks: 8
- Passed checks: 6
- Failed checks: 2
- Overall status: FAIL
- Receipt hash: `cab2a213e806d88d08fd7044921a61a35904854f1f7cd0a15ccdafee1afc2299`

## Note

A FAIL here does not imply runtime insecurity; it means Fortune-100 A+ procurement proof requirements are still incomplete.
