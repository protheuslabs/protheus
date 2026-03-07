# Economy Lane

`V3-RACE-022` adds a governed compute-tithe flywheel where verified donated GPU-hours reduce effective tithe and publish receipted events.

## Core Invariants

- Risk-tier defaults to `<=2`.
- Tier `3+` apply paths require second-gate approval.
- Every mutation emits ledger + receipt artifacts and event-stream publish evidence.
- Soul continuity marks GPU patrons in `state/soul/gpu_patrons.json`.

## Runtime Lanes

- `client/systems/economy/tithe_engine.ts`
- `client/systems/economy/gpu_contribution_tracker.ts`
- `client/systems/economy/contribution_oracle.ts`
- `client/systems/economy/tithe_ledger.ts`
- `client/systems/economy/smart_contract_bridge.ts`
- `client/systems/economy/public_donation_api.ts`
- `client/systems/economy/flywheel_acceptance_harness.ts`
- `platform/api/donate_gpu.ts` (open-platform compatibility API surface)
- `client/systems/economy/protheus_token_engine.ts` (`V3-RACE-130`)
- `client/systems/economy/global_directive_fund.ts` (`V3-RACE-130`)
- `client/systems/economy/peer_lending_market.ts` (`V3-RACE-133`)

## Data Scope Boundaries

- User-specific economy preferences/agreements:
  - `client/memory/economy/**`
  - `client/adaptive/economy/**`
- Permanent economy runtime/policy:
  - `client/systems/economy/**`
  - `client/config/*economy*` and related policy contracts
- Boundary enforcement:
  - `client/systems/ops/data_scope_boundary_check.ts`
  - `client/docs/DATA_SCOPE_BOUNDARIES.md`

## Collective Intelligence Economy Contract (`V3-RACE-160`)

- Incentive and access-tier runtime lanes:
  - `client/systems/economy/training_contributor_incentive_engine.ts`
  - `client/systems/economy/model_access_tier_governance.ts`
- Cross-lane integrity and scope check:
  - `client/systems/ops/collective_intelligence_contract_check.ts`
- Companion docs:
  - `client/docs/INTELLIGENCE.md`

## Quick Commands

```bash
node client/systems/economy/public_donation_api.js register --donor_id=alice
node client/systems/economy/public_donation_api.js donate --donor_id=alice --gpu_hours=24 --proof_ref=tx_1
node client/systems/economy/public_donation_api.js status --donor_id=alice
node client/systems/economy/donor_mining_dashboard.js dashboard
protheusctl mine dashboard --human=1
node client/systems/economy/flywheel_acceptance_harness.js --donor_id=sim --gpu_hours=240
node platform/api/donate_gpu.js donate --donor_id=alice --gpu_hours=24 --proof_ref=tx_2
```
