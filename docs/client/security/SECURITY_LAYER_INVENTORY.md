# Security Layer Inventory

Generated: 2026-03-18T23:05:26.903Z

This inventory maps each security layer to enforceable implementation paths, policy contracts, guard-check references, and live runtime checks.

| Layer | File/Guard Coverage | Runtime Checks |
|---|---|---|
| `constitution_policy_core`<br>Constitution + policy contract enforcement | missing paths: 0<br>missing guard ids: 0 | security-plane formal-invariant-engine ok<br>security-plane t0-invariants ok |
| `conduit_boundary`<br>Rust conduit boundary and command security | missing paths: 0<br>missing guard ids: 0 | security-plane required-checks-policy-guard ok<br>security-plane mcp-a2a-venom-contract-gate ok |
| `sandbox_isolation_and_egress`<br>Sandbox isolation and egress guardrails | missing paths: 0<br>missing guard ids: 0 | security-plane blast-radius-sentinel ok |
| `supply_chain_trust`<br>Supply-chain trust verification plane | missing paths: 0<br>missing guard ids: 0 | security-plane supply-chain-reproducible-build-plane ok |
| `key_lifecycle_and_pq`<br>Key lifecycle governance and post-quantum migration | missing paths: 0<br>missing guard ids: 0 | security-plane secrets-federation ok |
| `heartbeat_terms_and_repo_access`<br>Secure heartbeat endpoint + operator terms + repo access | missing paths: 0<br>missing guard ids: 0 | security-plane repository-access-auditor ok |
| `state_kernel_integrity`<br>State kernel integrity and replay guardrails | missing paths: 0<br>missing guard ids: 0 | state-kernel status ok |

## Verification Summary

- Layers checked: 7
- Missing paths: 0
- Missing guard checks: 0
- Runtime check failures: 0
- Contract status: PASS
- Receipt hash: `bee1921417c108d091d23dc6da1b57a5da7e11781617af8e7b17d03182534833`
