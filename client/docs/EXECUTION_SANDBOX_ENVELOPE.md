# Execution Sandbox Envelope

`V3-024` enforces policy-selected sandbox profiles for workflow and actuation execution.

## Commands

```bash
node client/systems/security/execution_sandbox_envelope.js status
node client/systems/security/execution_sandbox_envelope.js evaluate-workflow --step-id=step_1 --step-type=command --command="node script.js"
node client/systems/security/execution_sandbox_envelope.js evaluate-actuation --kind=browser_automation --context='{"risk_class":"shell"}'
```

## Behavior

- Deny-by-default host filesystem and network access.
- Explicit capability manifests by sandbox profile.
- Escape-attempt token detection with audited deny events.
- High-risk actuation classes require explicit sandbox approval context.
