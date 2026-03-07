# Sovereign Resurrection Substrate

`V3-RACE-037` composes cold archival, quantum-attestation checks, and resurrection drills into one continuity lane.

Entrypoint: `client/systems/continuity/sovereign_resurrection_substrate.js`

## Commands

```bash
node client/systems/continuity/sovereign_resurrection_substrate.js package --apply=1
node client/systems/continuity/sovereign_resurrection_substrate.js drill --apply=1 --target-host=drill_host
node client/systems/continuity/sovereign_resurrection_substrate.js status
```

Outputs include continuity hash attestations, bundle/verify/restore-preview receipts, and drill history.
