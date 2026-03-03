# Protheus Personas Organization

## Purpose

This layer defines organizational structure, ownership boundaries, and reporting lines for the persona system.

## Core Operating Model

- Founder/Principal: `jay_haslam`
- Core leadership personas: `vikram_menon`, `priya_venkatesh`, `rohan_kapoor`, `li_wei`, `aarav_singh`
- Supporting personas map to functional lanes (engineering, research, product, operations, QA, legal, finance).

## Reporting Rules

- Safety/security escalations route to `aarav_singh` and `vikram_menon`.
- Measurement/validation escalations route to `priya_venkatesh`.
- Rollout/timeline escalations route to `rohan_kapoor`.
- Product/market framing escalations route to `li_wei`.
- Strategic disputes escalate to `jay_haslam` for final arbitration.

## Governance

- Arbitration policy source: `personas/organization/arbitration_rules.json`
- Routing policy source: `personas/organization/routing_rules.json`
- Risk policy source: `personas/organization/risk_policy.json`
- Telemetry formulas source: `personas/organization/telemetry_policy.json`
- Retention policy source: `personas/organization/retention_policy.json`
- Pre-sprint checks: `personas/pre-sprint.md`
- Trigger prompt template: `personas/trigger_prompt.md`

## Control Plane Artifacts

- Meeting artifacts: `personas/organization/meetings/ledger.jsonl` (hash-chained rows)
- Project artifacts: `personas/organization/projects/ledger.jsonl` (hash-chained rows)
- Telemetry artifacts: `personas/organization/telemetry.jsonl` (formula-bound metrics)
- Shadow mode state: `personas/organization/shadow_mode_state.json`

## Feature Gates

- Persona local LLMs are supported but disabled by default via `llm_config.md`.
- Persona obfuscation/encryption is supported but disabled by default via `obfuscation_encryption.md`.
- External data integrations are permission-gated via `data_permissions.md`.
