# PsycheForge (V3-RACE-DEF-024)

Adaptive counter-profile defense lane with:

- Behavioral profile synthesis (`profile_synthesizer`)
- Risk-tiered countermeasure selection (`countermeasure_selector`)
- Encrypted temporal profile persistence + Rust hot-state mirror (`temporal_profile_store`)
- Shadow-to-live promotion flow for tier 3+ actions (`psycheforge_organ`)

## Commands

```bash
node client/systems/security/psycheforge/psycheforge_organ.js evaluate --actor=probe_a --telemetry_json='{"probe_density":0.92,"escalation_attempts":14}' --apply=1
node client/systems/security/psycheforge/psycheforge_organ.js promote --decision_id=<id> --two_gate_approved=1 --apply=1
node client/systems/security/psycheforge/psycheforge_organ.js status
```
