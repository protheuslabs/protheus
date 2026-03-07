# Client Relationship Manager

`V3-BRG-001` introduces a governed lifecycle lane for client interactions:
- negotiation
- scope change
- dispute
- repeat business

## Commands

```bash
node client/systems/workflow/client_relationship_manager.js case-open --client-id=client_a --channel=email --tier=standard
node client/systems/workflow/client_relationship_manager.js event --case-id=client_a_case --type=negotiation --handled-by=auto --workflow-id=wf_123
node client/systems/workflow/client_relationship_manager.js evaluate --days=30 --strict=1
node client/systems/workflow/client_relationship_manager.js status --days=30
```

## Governance

- Auto-handled events require `workflow_id` when `require_workflow_ref_for_auto=true`
- Qualified tiers are policy-defined (`qualified_case_tiers`)
- Manual intervention target is enforced by evaluation (`manual_rate <= manual_intervention_target`)
- SLA tracking is type-specific (`sla_hours_by_type`)

## State

- `state/workflow/client_relationship_manager/state.json`
- `state/workflow/client_relationship_manager/latest.json`
- `state/workflow/client_relationship_manager/receipts.jsonl`
