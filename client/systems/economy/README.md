# Compute-Tithe Flywheel (V3-RACE-022)

This lane implements donation -> validation -> tithe-discount application with receipted event flow.

## Commands

```bash
node client/systems/economy/public_donation_api.js register --donor_id=alice
node client/systems/economy/public_donation_api.js donate --donor_id=alice --gpu_hours=24 --proof_ref=tx123
node client/systems/economy/public_donation_api.js status --donor_id=alice
node client/systems/economy/tithe_engine.js status --donor_id=alice
node client/systems/economy/flywheel_acceptance_harness.js --donor_id=sim --gpu_hours=240
node platform/api/donate_gpu.js donate --donor_id=alice --gpu_hours=24 --proof_ref=tx123
```

## Outputs

- `state/economy/contributions.json`
- `state/economy/donor_state.json`
- `state/economy/tithe_ledger.jsonl`
- `state/economy/receipts.jsonl`
- `state/blockchain/tithe_bridge_receipts.jsonl`
- integration hints under guard/fractal/routing/model/risk + soul patron marker lane
