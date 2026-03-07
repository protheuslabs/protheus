# Neural Dormant Seed

`V3-023` keeps neural-interface work in a research-only locked lane.

## Commands

```bash
node client/systems/symbiosis/neural_dormant_seed.js status --profile=prod
node client/systems/symbiosis/neural_dormant_seed.js check --strict=1 --profile=prod
node client/systems/symbiosis/neural_dormant_seed.js request-sim --purpose="evaluate consent signal contract"
node client/systems/symbiosis/neural_dormant_seed.js request-live --purpose="prototype" --approval-note="manual"
```

`request-live` is expected to fail while policy is locked or profile is blocked.

## Policy

- `client/config/neural_dormant_seed_policy.json`
- Research artifacts:
  - `research/neural_dormant_seed/README.md`
  - `research/neural_dormant_seed/governance_checklist.md`
