# Red Legion

Client-side namespace marker only. Red Legion command authority is core-owned.

## Commands

- `protheus session register --session-id=<id> [--lineage-id=<id>] [--task=<text>]`
- `protheus session resume <id>`
- `protheus session send <id> --message=<text>`
- `protheus-ops command-center-session status [--session-id=<id>]`

Do not add authoritative roster, mission, or session-control logic under `client/runtime/systems/red_legion/`.
