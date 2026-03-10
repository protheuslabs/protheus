# Protheus

[![CI](https://github.com/protheuslabs/protheus/actions/workflows/ci.yml/badge.svg)](https://github.com/protheuslabs/protheus/actions/workflows/ci.yml)
[![CodeQL](https://github.com/protheuslabs/protheus/actions/workflows/codeql.yml/badge.svg)](https://github.com/protheuslabs/protheus/actions/workflows/codeql.yml)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Release](https://img.shields.io/github/v/release/protheuslabs/protheus?display_name=tag)](https://github.com/protheuslabs/protheus/releases)
[![npm](https://img.shields.io/npm/v/protheus)](https://www.npmjs.com/package/protheus)
[![Docker](https://img.shields.io/badge/docker-ghcr.io%2Fprotheuslabs%2Fprotheus-blue)](https://github.com/protheuslabs/protheus/pkgs/container/protheus)
[![Architecture](https://img.shields.io/badge/architecture-three--plane%20metakernel-0A7A5E)](planes/README.md)
![Coverage](docs/client/badges/coverage.svg)

**An evidence-first Rust kernel for autonomous operations, workflow execution, and policy-governed system evolution.**

[Documentation](docs/client/README.md) · [Quick Start](#quick-start) · [Architecture](ARCHITECTURE.md) · [Changelog](docs/workspace/CHANGELOG.md)

---

## Overview

Protheus is a deterministic three-plane metakernel designed for high-stakes autonomous operations. It combines a **safety-critical Rust core** with **probabilistic cognition runtime** and **substrate adapters** for heterogeneous execution environments.

Built to run like an internal platform team: typed runtime lanes, deterministic receipts, strict governance surfaces, and operational guardrails that are reviewable in-source.

## Quick Start

```bash
# macOS / Linux
curl -fsSL https://get.protheus.ai/install | sh

# Windows (PowerShell)
irm https://get.protheus.ai/install.ps1 | iex
```

```bash
# Verify installation
protheus --help
protheus status
protheus demo
```

### Alternative: npm
```bash
npm install -g protheus
protheus --help
```

### Local Development
```bash
npm ci
npm run build
npm run start
```

## Control Surface

| CLI | Purpose |
|:---|:---|
| `protheus` | Primary control-plane interface |
| `protheusd` | Daemon lifecycle wrapper |
| `protheusctl` | Job and control-plane operations |
| `protheus-top` | Live operator observability surface |

```bash
protheus list              # Command index
protheus status            # Health dashboard
protheus shadow list       # Manage persona shadows
protheus research "..."    # Research-organ routing
protheus assimilate <url>  # File/web assimilation
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  SAFETY PLANE                                           │
│  Deterministic Rust core · policy engine · receipts    │
├─────────────────────────────────────────────────────────┤
│  COGNITION PLANE                                        │
│  Probabilistic runtime · personas · workflows           │
├─────────────────────────────────────────────────────────┤
│  SUBSTRATE PLANE                                        │
│  Heterogeneous adapters · execution substrates          │
└─────────────────────────────────────────────────────────┘
```

| Path | Domain |
|:---|:---|
| [`planes/`](planes/) | Three-plane architecture contracts |
| [`client/runtime/systems/`](client/runtime/systems/) | Runtime lanes (ops, security, memory, routing, workflow...) |
| [`client/runtime/lib/`](client/runtime/lib/) | Shared runtime utilities |
| [`client/runtime/config/`](client/runtime/config/) | Policy, registries, configuration |
| [`client/observability/`](client/observability/) | Dashboards, runbooks, research artifacts |
| [`docs/client/`](docs/client/) | Architecture, governance, contracts |

## Key Features

- **Deterministic Safety Core** — Rust-native kernel with fail-closed policies
- **Shadow Operators** — Persona-based async execution with governance
- **Evidence-First Research** — Hybrid evidence grading with audit trails  
- **Policy-Governed Workflows** — Hash-chained receipts, reviewable by design
- **Platform-Team Operations** — Typed lanes, merge guards, drift detection

## Documentation

- [Architecture Overview](ARCHITECTURE.md)
- [Getting Started](docs/client/GETTING_STARTED.md)
- [Security Posture](docs/client/SECURITY_POSTURE.md)
- [Operator Runbook](docs/client/OPERATOR_RUNBOOK.md)
- [Developer Quickstart](docs/client/DEVELOPER_LANE_QUICKSTART.md)
- [Contributing](docs/workspace/CONTRIBUTING.md)

## Community & Governance

- **Security:** [Disclosure Policy](SECURITY.md)
- **Contributing:** [Guidelines](docs/workspace/CONTRIBUTING.md) · [Code of Conduct](.github/CODE_OF_CONDUCT.md)
- **Good First Issues:** [Start here](docs/client/community/GOOD_FIRST_ISSUES.md)
- **License:** [Apache-2.0](LICENSE)

---

<div align="center">

*Maintained by Protheus Labs · Evidence-first since 2024*

</div>
