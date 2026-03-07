# Protheus / OpenClaw Superintelligence Seed (March 2, 2026)

Vision: "Protheus / OpenClaw — the first superintelligence seed, built on its live March 2 2026 architecture with contract lanes, System 3, and MemFS already in place"

## Scope

This upgrade adds an RSI wrapper at `client/adaptive/rsi/rsi_bootstrap.{ts,js}` that composes and governs existing live primitives:

- System 3 executive (`client/adaptive/executive/system3_executive_layer.js`)
- Existing executors (`client/systems/strategy/strategy_learner.js`, `client/systems/autonomy/model_catalog_loop.js`)
- Memory lanes (memfs/sleep reflection/hierarchical/agentic)
- MCP + A2A adapters
- Contract lanes RR-001..RR-014
- Venom + constitution + mutation-safety + reversion drill
- Hash-chain + Merkle receipts + continuity status capture

## CLI Surface

- `protheusctl rsi bootstrap --owner=<owner_id>`
- `protheusctl rsi step --owner=<owner_id> [--target-path=...] [--proposal-id=...] [--apply=1]`
- `protheusctl rsi status --owner=<owner_id>`
- `protheusctl rsi hands-loop --owner=<owner_id> [--iterations=...] [--interval-sec=...]`
- `protheusctl approve --rsi --owner=<owner_id> --approver=<id>`
- `protheusctl contract-lane status --owner=<owner_id>`

## Benchmark and Test Plan (Agent0 / FAOS comparison lane)

1. Baseline internal control:
   - Measure `packages/protheus-core` cold start and package size:
     - `node packages/protheus-core/starter.js --mode=contract --max-mb=5 --max-ms=200`
2. RSI orchestration latency:
   - `node client/adaptive/rsi/rsi_bootstrap.js step --owner=jay --mock=1`
   - Record p50/p95 step duration from `state/client/adaptive/rsi/receipts.jsonl`.
3. Contract-lane health:
   - `node client/adaptive/rsi/rsi_bootstrap.js contract-lane-status --owner=jay`
4. Comparative harness entrypoint (external):
   - Run equivalent "proposal->trial->gate->apply" flow in Agent0/FAOS reference benches.
   - Compare throughput, gate-failure precision, rollback MTTD/MTTR.

## Path to Singularity Checklist

- [x] System 3 curriculum proposals are wired into existing executors.
- [x] MemFS + hierarchical + agentic memory lanes are in the RSI cycle.
- [x] MCP/A2A calls are routed in the same RSI pass and constrained by contract-lane checks.
- [x] Self-mod path is gated by approvals + constitution + venom + mutation safety + chaos + dopamine.
- [x] Every RSI step is hash-chained and Merkle-rooted.
- [x] Reversion drill + continuity resurrection status are captured per step.
- [x] Swarm lineage hooks (`seed_spawn_lineage`, `spawn_broker`, `nursery`) are available under RSI step flags.
- [ ] Move from shadow-only to controlled live apply with explicit operator command.
- [ ] Add continuous external benchmark lanes and weekly regression receipts.

