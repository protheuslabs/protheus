# Memory Fallback Retirement Gate

`systems/memory/memory_fallback_retirement_gate.ts` governs whether `memory_recall` may fall back from Rust to JS.

## Policy

Policy file: `config/memory_fallback_retirement_policy.json`

Key controls:
- `enabled`: turns enforcement on/off
- `allow_js_fallback`: global allow (use `false` for emergency-only mode)
- `paths.emergency_toggle_path`: one-click rollback toggle state

## Commands

```bash
node systems/memory/memory_fallback_retirement_gate.js status
node systems/memory/memory_fallback_retirement_gate.js enable-emergency --reason="manual_emergency"
node systems/memory/memory_fallback_retirement_gate.js disable-emergency
```

## Incident Receipts

Every fallback decision writes:
- `state/memory/rust_transition/js_fallback_gate/latest.json`
- `state/memory/rust_transition/js_fallback_gate/receipts.jsonl`

`memory_recall` includes `fallback_incident_id` in outputs/audit rows when a Rust->JS fallback path is evaluated.
