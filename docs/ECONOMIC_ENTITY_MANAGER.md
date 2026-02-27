# Economic Entity Manager

## Purpose

`economic_entity_manager` provides a governed economic lane for autonomous revenue operations:

- immutable accounting ledger entries
- tax classification and monthly tax report generation
- contract signing + verification workflow
- payout routing gated through Eye + payment bridge

## Commands

```bash
node systems/finance/economic_entity_manager.js ledger-entry --kind=income --amount-usd=1200 --category=saas_income --source=stripe --apply=0
node systems/finance/economic_entity_manager.js classify-tax --entry-id=<entry_id> --apply=0
node systems/finance/economic_entity_manager.js tax-report --month=2026-02 --apply=0
node systems/finance/economic_entity_manager.js contract-sign --contract-id=msa_1 --counterparty=client_a --value-usd=3000 --terms="..." --apply=0
node systems/finance/economic_entity_manager.js contract-verify --contract-id=msa_1
node systems/finance/economic_entity_manager.js payout-route --provider=stripe --recipient=acct_123 --amount-usd=450 --apply=0
node systems/finance/economic_entity_manager.js status --month=2026-02
```

## Governance

- High-risk filings (by category/amount) require explicit approval note.
- Payouts are blocked if Eye gate denies.
- Immutable receipt chaining (`prev_hash -> hash`) is appended for every operation.
- `shadow_only=true` by default.

## State Artifacts

- `state/finance/economic_entity/state.json`
- `state/finance/economic_entity/ledger.jsonl`
- `state/finance/economic_entity/receipts.jsonl`
- `state/finance/economic_entity/tax_reports/*.json`
