# REQ-30 — Technical Excellence Roadmap Intake (Doc `19DO7nvxizNJmLuoRUFrYYTNOmMnHJCGKI44AlGHbcSw`)

## Source
- Intake document: `https://docs.google.com/document/d/19DO7nvxizNJmLuoRUFrYYTNOmMnHJCGKI44AlGHbcSw/edit`
- Captured date: 2026-03-08

## Objective
Convert roadmap claims into executable requirements with hard separation between:
- automatable engineering lanes (code/CI/docs artifacts), and
- human-authority lanes (legal, standards positioning, external publication authority).

## Derived Executable Requirements

### REQ-30-001 Three-plane formal spec surface
- Maintain machine-checkable three-plane boundary specs under `planes/spec/`.
- Required invariants: safety authority immutability and conduit-only cross-plane transport.
- CI must fail if required spec files or invariants are missing.

### REQ-30-002 Contract source-of-truth for inter-plane envelopes
- Maintain canonical inter-plane schema in `planes/contracts/`.
- Conduit envelope schema must require at least `domain`, `command`, and `payload`.
- Bind this schema into documentation and quality gates.

### REQ-30-003 Conduit-only boundary hard gate
- Runtime policy check must fail strict mode when client surfaces bypass conduit boundaries.
- Guard must run in CI and local verify flow.
- Existing dependency-boundary guard is the enforcement lane.

### REQ-30-004 Verification command contract
- `verify.sh` must execute architecture boundary checks before origin-integrity lane evaluation.
- Verification must produce deterministic pass/fail behavior suitable for release proof packs.

### REQ-30-005 Architecture contract visibility
- `ARCHITECTURE.md` must explicitly reference formal spec and contract registry locations.

## Human-Owned Requirements (Non-Automatable)

### REQ-30-H001 External standards/legal submission ownership
- NIST/standards responses and policy positioning require human sign-off and external account authority.

### REQ-30-H002 Public competitive narrative and claims publication
- Any external “category” or competitor claims require human legal/brand approval.

### REQ-30-H003 Third-party attestation contracts
- Independent audits/certifications remain human-owned procurement/legal workflows.

## This Sprint Implementation Status
- Implemented now:
  - `planes/spec/README.md`
  - `planes/spec/tla/three_plane_boundary.tla`
  - `planes/spec/tla/three_plane_boundary.cfg`
  - `planes/contracts/README.md`
  - `planes/contracts/conduit_envelope.schema.json`
  - `client/systems/ops/formal_spec_guard.ts`
  - `.github/workflows/formal-spec-guard.yml`
  - `verify.sh` updated to run boundary + formal spec checks.
  - `ARCHITECTURE.md` updated with formal contract surface references.
- Deferred:
  - Full model-checking runtime (TLC/Kani/Prusti/Lean) remains tracked as backlog follow-up due host/runtime constraints.
