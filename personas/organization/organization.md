# Protheus Personas Organization

## Purpose

This layer defines organizational structure, ownership boundaries, and reporting lines for the persona system.

## Core Operating Model

- Founder/Principal: `jay_haslam`
- Core leadership personas: `vikram_menon`, `priya_venkatesh`, `rohan_kapoor`, `li_wei`, `aarav_singh`
- Supporting personas map to functional lanes (engineering, research, product, operations, QA, legal, finance).

## Org Chart (ASCII)

```
jay_haslam (Founder / Principal)
├─ vikram_menon (CTO) ............... safety + architecture arbitration
├─ priya_venkatesh (Research Lead) .. measurement rigor + drift controls
├─ rohan_kapoor (Ops Lead) .......... rollout timing + execution cadence
├─ li_wei (Product Lead) ............ user impact + adoption framing
└─ aarav_singh (Security Lead) ...... threat model + fail-closed enforcement
```

## Reporting Rules

- Safety/security escalations route to `aarav_singh` and `vikram_menon`.
- Measurement/validation escalations route to `priya_venkatesh`.
- Rollout/timeline escalations route to `rohan_kapoor`.
- Product/market framing escalations route to `li_wei`.
- Strategic disputes escalate to `jay_haslam` for final arbitration.

## Governance

- Arbitration policy source: `personas/organization/arbitration_rules.json`
- Routing policy source: `personas/organization/routing_rules.json`
- Disagreement log source: `personas/organization/disagreements.jsonl`
- Meeting summaries source: `personas/organization/meetings.md`
- Risk policy source: `personas/organization/risk_policy.json`
- Breaker policy source: `personas/organization/breaker_policy.json`
- Soul-token policy source: `personas/organization/soul_token_policy.json`
- Telemetry formulas source: `personas/organization/telemetry_policy.json`
- Retention policy source: `personas/organization/retention_policy.json`
- Pre-sprint checks: `personas/pre-sprint.md`
- Trigger prompt template: `personas/trigger_prompt.md`

## Control Plane Artifacts

- Meeting artifacts: `personas/organization/meetings/ledger.jsonl` (hash-chained rows)
- Project artifacts: `personas/organization/projects/ledger.jsonl` (hash-chained rows)
- Telemetry artifacts: `personas/organization/telemetry.jsonl` (formula-bound metrics)
- Shadow mode state: `personas/organization/shadow_mode_state.json`
- Live telemetry report: `protheus orchestrate telemetry`
- Artifact audit command: `protheus orchestrate audit "<artifact_id>"`
- Retention prune command: `protheus orchestrate prune [--ttl-days=90]`

## Resolved Disagreements

- `dis-001` Rust migration acceptance criteria: safety invariants gate rollout sequencing ([commit 479e8eb](https://github.com/protheuslabs/protheus/commit/479e8eb)).
- `dis-002` telemetry scope vs product pacing: measurement baseline first ([commit ff2d695](https://github.com/protheuslabs/protheus/commit/ff2d695)).
- `dis-003` override governance posture: token-backed high-risk authorization ([commit 6bed345](https://github.com/protheuslabs/protheus/commit/6bed345)).

## Feature Gates

- Persona local LLMs are supported but disabled by default via `llm_config.md`.
- Persona obfuscation/encryption is supported but disabled by default via `obfuscation_encryption.md`.
- External data integrations are permission-gated via `data_permissions.md`.
