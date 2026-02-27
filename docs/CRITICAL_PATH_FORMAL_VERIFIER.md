# Critical Path Formal Verifier

## Purpose

`critical_path_formal_verifier` hardens high-risk control paths with machine-checkable, fail-closed invariants for:

- Weaver arbitration behavior and constitutional veto coverage.
- Inversion tier gating, immutable axioms, and live-apply ladder constraints.
- Constitution and 0-point governance invariants.

This verifier complements `formal_invariant_engine` and is intended to run in merge/release gates.

## Commands

```bash
node systems/security/critical_path_formal_verifier.js run --strict=1
node systems/security/critical_path_formal_verifier.js status
```

## Policy

Policy file: `config/critical_path_formal_policy.json`

Key controls:

- `checks.required_weaver_weights`: required arbitration vector dimensions.
- `checks.required_axiom_ids`: immutable inversion axioms that must be present.
- `checks.require_shadow_pass_for_live_rank_at_least`: minimum rank that requires shadow-pass before live.
- `checks.require_human_veto_for_live_rank_at_least`: minimum rank that requires first-N human veto window.
- `checks.required_disabled_live_targets`: targets that must remain live-disabled.

## Outputs

- Latest state: `state/security/critical_path_formal/latest.json`
- Append-only history: `state/security/critical_path_formal/history.jsonl`

The output includes:

- `checks[]`: pass/fail rows with reason details.
- `model_rows[]`: per-target inversion ladder model checks.
- `ok`: overall gate result.
