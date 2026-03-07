# InfRing Launch Announcement Templates

Use these templates for coordinated launch communication.

## Positioning Pillars

- Rust-first kernel as single source of truth
- Typed conduit bridge for TS flexibility without kernel compromise
- Deterministic receipts and policy/constitution enforcement
- Portable runtime profile (desktop/server/embedded)

## X / Twitter Template

```text
InfRing (by Protheus Labs) is now live.

- Rust-first kernel
- typed conduit bridge
- deterministic receipts + governance
- runs across desktop/server/embedded profiles

If you want sovereign autonomous infrastructure instead of black-box orchestration, start here:
https://github.com/protheuslabs/protheus

Quick install:
curl -fsSL https://get.protheus.ai/install | sh
```

## Hacker News Template

Title:

```text
Show HN: InfRing — a Rust-first autonomous runtime with deterministic receipts
```

Body:

```text
We built InfRing as a Rust-first autonomous runtime where kernel logic (policy, constitution checks, receipts, primitives) is the source of truth.

TypeScript remains a thin surface layer connected through a typed conduit, so teams keep flexibility without moving trust boundaries out of Rust.

Repo: https://github.com/protheuslabs/protheus
Quick install: curl -fsSL https://get.protheus.ai/install | sh

Would love feedback from folks running regulated, local-first, or edge-heavy deployments.
```

## Reddit Template

```text
Title: InfRing (Rust-first autonomous runtime) is open — looking for technical feedback

We just shipped InfRing from Protheus Labs.

Highlights:
- Rust kernel is the single source of truth
- typed conduit bridge for TS surfaces
- deterministic claim/evidence receipts
- local-first + portable runtime profiles

If this is relevant to your stack, we’d appreciate hard technical feedback:
https://github.com/protheuslabs/protheus
```

## Internal Launch Checklist

- [ ] Confirm latest benchmark-matrix report is attached in release notes
- [ ] Confirm release SBOM + checksum uploaded
- [ ] Confirm coverage badge is green
- [ ] Confirm security workflows are green (CodeQL/Dependabot/security audit)
- [ ] Confirm announcement links point to current release tag
