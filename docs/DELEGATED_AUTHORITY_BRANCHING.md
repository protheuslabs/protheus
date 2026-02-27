# Delegated Authority and Soul-Branching

`systems/security/delegated_authority_branching.ts` implements `V3-059`.

It provides bounded delegation branches with:

- scoped/time-boxed authority (`roles` + `scopes` + `ttl`)
- constitution-denied scope enforcement (non-bypass)
- key-lifecycle dependency gate (requires active signing-class keys)
- revocation ceremony with immutable receipts
- handoff contract compatibility output for `V4-006`

## Commands

- `issue`
- `evaluate`
- `revoke`
- `handoff-contract`
- `status`

## Governance Contract

A branch is considered valid only when all are true:

- branch status is active
- branch not revoked and not expired
- signature matches configured signing key
- requested scope/role are explicitly allowed
- scope is not on constitution denied list

## State

- index: `state/security/delegated_authority/index.json`
- receipts: `state/security/delegated_authority/receipts.jsonl`
- latest: `state/security/delegated_authority/latest.json`

