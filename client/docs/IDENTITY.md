# Identity Lane

Identity contracts in this workspace are split into three scopes:

- User-specific state:
  - `client/memory/identity/` for owner-facing identity preferences/history.
  - `client/adaptive/identity/` for adaptive tuning metadata.
- Permanent runtime logic:
  - `client/systems/identity/` for deterministic engines and verifiers.
  - `client/config/` for policy contracts and limits.

## Active Identity Runtime Lanes

- `client/systems/identity/identity_organ.ts`
- `client/systems/identity/identity_integrity_oracle.ts`
- `client/systems/identity/visual_signature_engine.ts` (`V3-RACE-134`)
- `client/systems/contracts/soul_contracts.ts` (`V3-RACE-129`)

## Invariants

- Runtime identity decisions are receipted.
- Tier `3+` actions require explicit approval.
- Visual signature manifests are deterministic and hash-verifiable.
- User identity history stays in `client/memory/` and `client/adaptive/`, not in `client/systems/`.
