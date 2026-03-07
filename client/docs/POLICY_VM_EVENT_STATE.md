# Policy VM + Event-Sourced State (`V3-044`)

This lane formalizes governance/execution separation and deterministic replay behavior.

## Core Components

- Policy VM: `client/systems/primitives/policy_vm.js`
- Canonical event log: `client/systems/primitives/canonical_event_log.js`
- Runtime scheduler modes: `client/systems/primitives/runtime_scheduler.js`
- N-2 compatibility gate: `client/systems/ops/profile_compatibility_gate.js`

## Scheduler Modes

Policy file: `client/config/runtime_scheduler_policy.json`

Modes are first-class and governed:

- `operational`
- `dream`
- `inversion`

Transitions are policy-bound. Invalid transitions fail closed and are receipted.

## Event-Sourced Canonical State

All primitive execution emits append-only canonical events:

- hash-chained (`prev_hash` / `hash`)
- replay-verifiable (`client/systems/primitives/replay_verify.js`)
- scheduler mode transitions emit governance events (`FLOW_GATE`)

## N-2 Compatibility Gate

Policy file: `client/config/profile_compatibility_policy.json`

`client/systems/ops/profile_compatibility_gate.js run --strict=1` enforces schema compatibility:

- capability profile schema version window (N-2)
- primitive catalog schema readability
- fail-closed if profile artifacts drift outside compatibility envelope

This check is wired into merge guard for CI discipline.
