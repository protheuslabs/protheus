# Self-Serve Signup Spec

## Objective
Allow pilot customers to self-onboard into PQTS with controlled tier entitlements.

## Core Flow
1. Account registration (email + organization).
2. Workspace creation and API key issuance.
3. Tier selection (`Launch`, `Professional`, `Enterprise`).
4. Entitlement provisioning and environment bootstrap.
5. Guided paper-campaign start with default safety profile.

## Required Controls
- Mandatory acceptance of risk disclaimer and paper-first policy.
- No live-canary entitlement unless promotion gate passes.
- Audit trail of entitlement changes and admin overrides.

## API Surface
- `POST /signup`
- `POST /workspace/{id}/billing/subscribe`
- `POST /workspace/{id}/campaign/start`
- `GET /workspace/{id}/ops-health`
- `GET /workspace/{id}/promotion-gate`

## First Release Non-Goals
- Marketplace billing split automation
- Multi-org delegated RBAC
- Regional data residency controls
