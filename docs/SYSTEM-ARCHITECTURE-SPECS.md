# Protheus System Architecture Specification
## Conscious/Subconscious Iceberg Model
Version 1.0 - March 7, 2026
Status: Locked (use this document for all future Codex sprints, regression checks, code reviews, and onboarding)

## 1. Purpose and Core Philosophy
Protheus is deliberately structured as an iceberg:

- `client/` = Conscious mind (the driver)
  The user and client layer only see clean controls, notifications, and high-level outputs. They never see how the engine works.
- `core/` = Subconscious mind (the engine + electronics)
  All intelligence, memory, scoring, initiative, and efficiency logic lives here and is completely hidden.
- Conduit = The dashboard + quantum schema scrambler
  The only bidirectional interface between client and core. No other path exists.

This separation is non-negotiable. It protects our secret sauce (5% token burn rate) and keeps the system maintainable, auditable, and future-proof.

## 2. High-Level Structure

```text
Client (conscious mind - driver)
          ↑↓ (only via Conduit + quantum schema scrambler)
   core/layer3/  <- Surface and Integration Layer (thin placeholder)
          ↑
   core/layer2/  <- Reasoning, Priority and Agency Engine
          ↑
   core/layer1/  <- Memory and Persistence Engine
          ↑
   core/layer0/  <- Deterministic Foundation Kernel
          ↑
Raw inputs (adapters, eyes, hardware, timers, external APIs)
```

## 3. Strict Layer Ownership (Codex MUST obey these rules)

### `core/layer0/` — Deterministic Foundation Kernel
ONLY: raw event ingestion from adapters/hardware/timers, deterministic scheduling, isolation, capabilities, resource accounting, covenant/policy enforcement, receipts generation, watchdogs, boot/update trust, low-level I/O primitives.

NEVER: memory nodes, indexing, scoring, reasoning, initiative, proactive messaging, reflexes, epistemic logic, or any cognitive/probabilistic behavior.

### `core/layer1/` — Memory and Persistence Engine
ONLY: jot/tag/node system, Memory Matrix, indices, Dream Sequencer, Auto-Recall logic, Conversation Eye synthesis engine, epistemic memory (confidence/provenance/expiry), reflexes (crystallized low-burn tasks), tag-based lookup and persistence.

NEVER: importance scoring, priority queue management, initiative/outreach logic, task collision resolution, or direct Conduit calls.

### `core/layer2/` — Reasoning, Priority and Agency Engine
ONLY: importance scoring engine, Attention Queue (priority queue with front-jump logic), Initiative Layer (proactive messaging + escalation thresholds), task collision resolution, attention management, burn monitoring, context compression rules.

NEVER: raw memory storage, indexing, low-level primitives, direct Conduit communication, or substrate integration.

### `core/layer3/` — Surface and Integration Layer (thin placeholder)
ONLY: final event preparation and humanization before Conduit, coordination with quantum schema scrambler, clean translation to client-visible formats, substrate adapters for new tech (quantum, BCI, ternary, neural I/O, etc.).

NEVER: heavy business logic, memory operations, scoring, initiative decisions.

### `core/conduit/` — Single Gate to Client
ONLY: bidirectional communication between core and `client/`, quantum schema scrambler enforcement.

NEVER: scoring, memory logic, initiative decisions, or business logic.

## 4. Flow and Communication Rules
- Events flow upward only: Layer0 -> Layer1 -> Layer2 -> Layer3 -> Conduit.
- No downward calls, no peer-to-peer communication, no spaghetti.
- Each layer may receive its own direct inputs from adapters (no single bottleneck at Layer0).
- Only Layer3 communicates with Conduit.
- All inter-layer communication uses typed internal events.

## 5. Initiative Layer and Priority Queue (Layer2 only)
- Importance Scoring Engine: deterministic, low-latency, non-LLM.
  `weighted_score = 0.35*criticality + 0.25*urgency + 0.20*impact + 0.15*user_relevance + 0.05*confidence` plus optional `core_floor` boost for system-critical events.
- Attention Queue: true priority queue. On insert, if score >= 0.7, auto-push to front.
- Initiative Layer threshold contract:
  - `< 0.40` -> internal only
  - `0.40–0.70` -> one polite message + wait
  - `0.70–0.85` -> double-message
  - `> 0.85` -> escalate
  - `> 0.95` -> persistent until acknowledged

## 6. Future-Proofing Rules
Adding new tech (quantum, BCI, ternary, neural I/O) should only require:
- New adapters (if needed)
- Optional new Layer4+ (if required)
- Updates to Layer3 and Conduit

Layers 0-2 remain untouched.

## 7. Enforcement and Regression Prevention
- Future Codex prompts should include:
  "Strictly follow Protheus Conscious/Subconscious Iceberg Specification v1.0 — subconscious code only in core/ layers with upward-only flow."
- Any ONLY/NEVER violation is a blocking regression.
- This document is the architecture contract source of truth.
