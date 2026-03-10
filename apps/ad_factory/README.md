# Video Ad Factory (V6-COCKPIT-016)

Layer: app (runs on top of client; not core authority).

Purpose:
- Automated script generation
- UGC-style video variant generation
- High-volume ad factory batch orchestration

Core integration contract:
- Route all generation/dispatch actions through Conduit.
- Emit deterministic receipts for every script/video artifact.

CLI target:
- `protheus app run ad-factory`
