# Bug Bounty Policy (Starter Program)

Version: 1.0  
Date: 2026-03-06

## Program Goal

Incentivize responsible disclosure for high-signal vulnerabilities affecting Protheus kernel security, conduit boundaries, and release trust.

## Initial Budget

- Starter pool: **$500** per reward cycle.
- Program can scale after triage throughput and response SLAs remain stable.

## In-Scope Targets

- `core/layer2/conduit/**`
- `core/layer2/conduit-security/**`
- `core/layer0/ops/**` security, policy, receipt, and constitution enforcement paths
- release artifact integrity (SBOM/signature/attestation flow)
- bypasses that violate Rust source-of-truth controls

## Out-of-Scope

- social engineering
- purely theoretical findings without plausible exploit path
- low-impact style issues without security consequence
- third-party service outages unrelated to project code

## Reward Guidance

- Critical: `$200-$500`
- High: `$100-$250`
- Medium: `$50-$100`
- Low: acknowledgement, no guaranteed payout

Payout depends on exploitability, impact, and report quality.

## Submission Requirements

- clear reproduction steps
- affected commit/version
- expected vs actual security behavior
- minimal PoC if safe to share
- remediation suggestion (optional but encouraged)

Submit reports via the private channel described in [SECURITY.md](../SECURITY.md).
