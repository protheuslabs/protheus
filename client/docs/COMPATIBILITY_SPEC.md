# Protheus Compatibility Specification

Version: 1.0

## Scope
- Non-secret compatibility contract for governance-preserving integrations.
- Defines required invariants for identity, policy-root, tracing, and receipt integrity.

## Required Contracts
1. Policy-root invariants must remain non-bypassable.
2. Receipt contract must preserve deterministic `ts`, `type`, `ok` fields.
3. Trace contract must preserve `trace_id`, `request_id`, `run_id`, `job_id` when available.
4. Integration must not disable constitutional safety gates.

## Conformance Result
- Integrations may generate signed conformance badge artifacts via:
  - `node client/systems/ops/compatibility_conformance_program.js run --integration=<id>`
