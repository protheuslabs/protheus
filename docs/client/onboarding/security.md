# Security Onboarding Track

1. Bootstrap using `./scripts/onboarding/protheus_onboarding_bootstrap.sh --role=security --dry-run=1`.
2. Run `protheus-ops enterprise-hardening run --strict=1`.
3. Run `protheus-ops supply-chain-provenance-v2 run --strict=1` against release bundle fixtures.
