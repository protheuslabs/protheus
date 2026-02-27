# Gated Account Creation Organ (V2-065)

`systems/workflow/gated_account_creation_organ.ts` adds a governed account provisioning lane with profile-first execution.

## Design Constraints

- No bespoke per-service runtime branches.
- Uses profile templates from `config/account_creation_templates.json`.
- Executes steps through `systems/actuation/universal_execution_primitive.js`.
- Reuses existing safety/governance layers:
  - Eye/constitution route gate
  - Weaver status gate
  - Soul-token verification gate
  - Agent passport action chain
  - Alias/verification vault

## High-Risk Handling

Risk classes in `high_risk_classes` require `--human-approved=1`.

## CLI

```bash
node systems/workflow/gated_account_creation_organ.js create --template=generic_email_account --objective-id=acct_growth --apply=0
node systems/workflow/gated_account_creation_organ.js status
```

