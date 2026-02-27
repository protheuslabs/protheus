# Causal + Temporal Memory Graph

`systems/memory/causal_temporal_graph.ts` builds a policy-gated causal graph over canonical runtime events.

## Guarantees

- Temporal and declared-cause edges over canonical event IDs
- Reproducible graph state + hash linked to canonical event stream
- `why` query mode for causal parent traversal
- `what-if` query mode for counterfactual downstream impact traversal
- Immutable query/build receipts

## Policy

Policy file: `config/causal_temporal_memory_policy.json`

Outputs:

- Graph state: `state/memory/causal_temporal_graph/state.json`
- Latest query: `state/memory/causal_temporal_graph/latest_query.json`
- Receipts: `state/memory/causal_temporal_graph/receipts.jsonl`

## Commands

```bash
# Build graph from canonical events
node systems/memory/causal_temporal_graph.js build --strict=1

# Explain why an event happened
node systems/memory/causal_temporal_graph.js query --mode=why --event-id=<event_id>

# Counterfactual ripple from an event
node systems/memory/causal_temporal_graph.js query --mode=what-if --event-id=<event_id> --assume-ok=0

# View graph/query status
node systems/memory/causal_temporal_graph.js status
```
