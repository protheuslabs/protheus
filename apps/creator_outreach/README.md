# Creator Outreach (V6-APP-001)

Layer: app (runs on top of client; not core authority).

Purpose:
- Creator discovery (YouTube/Twitch)
- Personalized outreach generation and scheduling
- Response handling and call-booking orchestration

Core integration contract:
- Route all outbound actions through Conduit policy gates.
- Emit deterministic receipts for discovery, outreach, and follow-up flows.

CLI target:
- `protheus app run creator-outreach`
