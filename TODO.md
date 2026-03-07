# TODO

## Backlog Follow-Up (Layer Ownership Guard)

- [ ] `V6-ADAPT-CORE-001` Port adaptation primitives from temporary client bootstrap to core authority.
  - Layer target: `core/layer2` (authoritative runtime primitive for `REQ-19-001`, `REQ-19-002`, `REQ-19-003`).
  - Client role: Layer 3 conduit-only wrappers, operator CLI surface, and tests.
  - Completion criteria:
    - Rust core owns cadence/resource/continuity policy and receipts.
    - Client runtime adaptation code is compatibility-only (no policy authority).
    - All client↔core communication for adaptation flows only through conduit + scrambler.
