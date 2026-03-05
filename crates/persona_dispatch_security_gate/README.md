# persona_dispatch_security_gate

Fail-closed persona dispatch gate for protheusctl dispatch routing.

## API
- `evaluate_persona_dispatch_gate(script_rel, requested_lens, valid_lenses, blocked_paths, covenant_violation, tamper_signal)`

## Guarantees
- Covenant/tamper signals fail closed.
- Blocked paths are denied deterministically.
- Invalid requested lenses can fallback to a valid lens list.
- Deterministic envelope for all pass/fail outcomes.
