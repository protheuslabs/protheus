# Red Legion

Operational namespace for Red Legion roster and mission coordination.

## Commands

- `node client/systems/red_legion/command_center.js enlist --operator-id=<id> [--alias=<name>] [--rank=recruit]`
- `node client/systems/red_legion/command_center.js promote --operator-id=<id> --rank=<rank>`
- `node client/systems/red_legion/command_center.js mission --operator-id=<id> --objective=<text> [--risk-tier=1..4]`
- `node client/systems/red_legion/command_center.js status [--operator-id=<id>]`
