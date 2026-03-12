# Module Cohesion and Split Policy

Purpose: keep authority code reviewable, testable, and safe while preserving the core architecture contract (Rust truth, thin client).

## Decision Rule

Keep files large only when justified by cohesion and call frequency.

Split when one or more of these are true:

1. A module has multiple responsibilities (for example parsing + routing + policy + persistence).
2. Different teams/concerns repeatedly edit the same file.
3. Pieces cannot be tested independently.
4. A file is too long to reason about safely in one review pass.
5. New contributors cannot quickly locate related logic.

## Boundary-First Splitting

Split by domain boundary, not by arbitrary size.

For this repository:

1. Rust core modules stay cohesive and split by domain boundary when they grow (for example conduit policy, receipts, execution graph, model routing state, scheduling).
2. Client files stay thin adapters and intentionally explicit.
3. Avoid micro-fragmentation. Split to reduce coupling and improve safety review, not aesthetics.

## Practical Size Caps

Caps are enforcement hints, not architecture substitutes:

- Hard cap (general code): around 400-600 lines.
- Client thin-surface cap: 400 lines.
- Review-attention warning: over 800 lines.
- Exception class: generated output and simple/stable adapter glue.

## Enforcement Contract

Policy gate:

```bash
npm run -s ops:module-cohesion:audit
```

Guard behavior:

1. Fails new non-exempt files above cap.
2. Tracks existing over-cap files as explicit legacy debt.
3. Fails legacy debt growth above policy slack.
4. Emits warning-attention entries for files over 800 lines.

Outputs:

- `artifacts/module_cohesion_audit_current.json`
- `docs/workspace/MODULE_COHESION_AUDIT_CURRENT.md`

Policy config:

- `client/runtime/config/module_cohesion_policy.json`
- `client/runtime/config/module_cohesion_legacy_baseline.json`
