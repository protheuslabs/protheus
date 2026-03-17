# REQ-55: DSPy Declarative Self-Improving Pipelines Assimilation

Version: 1.0
Date: 2026-03-17
Owner: InfRing Workflow / Optimization / Observability

## Objective

Assimilate DSPy's declarative, self-improving pipeline strengths into InfRing without introducing a parallel runtime authority path: signatures, typed predictors, modules, compilers, optimizers, assertions, multi-hop reasoning, RAG and agent loops, tool-use, evaluation, and self-optimizing observability should all map onto existing workflow, swarm, Dream Sequencer, content-skill, adapter, inference, receipt, and observability primitives.

## Source References

- [Source doc](https://docs.google.com/document/d/1J0UghF4LAP303v7I6lwf1x8wTGNyAhEoIBQTqaNw-9E/edit?usp=sharing)
- [DSPy upstream](https://github.com/stanfordnlp/dspy)

## Scope

In scope:
- Declarative signatures and typed predictor routing
- Module and compiler-style workflow execution
- Optimizers and teleprompter-style prompt/pipeline refinement
- Assertion-driven self-refinement and validation
- Multi-hop reasoning, RAG, and agent loops
- Metrics, evaluators, and benchmark bridging
- Retrieval, tool, and external integration routing
- Self-improving telemetry and reproducibility traces

Out of scope:
- A separate DSPy-owned compiler or workflow runtime
- Moving authority into `apps/dspy/**`
- Bypassing current budget, receipt, inference, or policy governance for optimization flows

## Placement Constraints

This intake must obey repository placement policy.

- Core authority remains in `core/`
- Thin runtime/operator surfaces remain in `client/runtime/systems/**`
- Retrieval, tool, and protocol bridges live in `adapters/`
- Optional demo shells may exist in `apps/`, but only as deletable, non-authoritative surfaces

## Related Requirements

- REQ-39: Haystack modular pipeline and agent assimilation
- REQ-49: LangGraph persistent graph orchestration assimilation
- REQ-53: CAMEL scaling-law agent society assimilation
- REQ-54: Pydantic AI type-safe structured agents assimilation
- Existing SRS families:
  - `V6-WORKFLOW-001.*` through `V6-WORKFLOW-015.*`
  - `V6-SWARM-*`
  - `V6-MEMORY-*`
  - `V9-AUDIT-026`
  - `V6-OBSERVABILITY-*`

## Requirements

### REQ-55-001: Signatures and Typed Predictor Registry

**Requirement:** Declarative signatures and typed predictors must route through governed workflow and swarm primitives rather than a separate DSPy-owned execution model.

**Acceptance:**
- Signature-driven execution preserves typed inputs/outputs through authoritative lanes
- Every run emits deterministic receipts and lineage
- No duplicate signature runtime is introduced

---

### REQ-55-002: Modules and Compiler Engine

**Requirement:** Module composition and compiler-style orchestration must normalize onto the canonical workflow engine.

**Acceptance:**
- Compiled programs run deterministically through existing workflow and initiative lanes
- Control flow remains receipted and replayable
- No second compiler authority path is introduced

---

### REQ-55-003: Optimizers and Teleprompter Bridge

**Requirement:** Automatic prompt and pipeline optimization must remain inside current inference, memory, and evidence lanes.

**Acceptance:**
- Optimization runs emit traceable receipts and benchmarkable outcomes
- Optimization state remains lineage-safe and policy-bounded
- Unsupported optimization paths degrade explicitly for pure/tiny-max profiles

---

### REQ-55-004: Assertions and Self-Refining Engine

**Requirement:** Assertion-driven retries and self-correction must build on existing receipt and policy primitives.

**Acceptance:**
- Assertions trigger deterministic retry, refinement, or rejection receipts
- Validation failures remain fail closed
- Context-budget enforcement stays authoritative

---

### REQ-55-005: Multi-Hop RAG and Agent Loop Bridge

**Requirement:** Multi-hop reasoning, RAG programs, and tool-using agent loops must map onto current memory, content-skill, and swarm primitives.

**Acceptance:**
- Multi-stage programs preserve isolated receipts and lineage
- Tool-use remains conduit-routed and adapter-owned where appropriate
- No second RAG or loop authority path is introduced

---

### REQ-55-006: Metrics, Evaluators, and Benchmark Bridge

**Requirement:** DSPy metrics, evaluators, and benchmark flows must stream through the native observability and evidence stack.

**Acceptance:**
- Evaluation runs emit deterministic receipts and feed native metrics surfaces
- Benchmarks remain replayable and provenance-linked
- No parallel evaluation stack is introduced

---

### REQ-55-007: RAG, Tool, and Integration Gateway

**Requirement:** DSPy retrieval, classifier, and external tool integrations must route through governed adapter and inference bridges.

**Acceptance:**
- `infring assimilate dspy` or equivalent intake normalizes programs into governed manifests
- Every component invocation is receipted
- Unsupported integrations fail closed with explicit reasons

---

### REQ-55-008: Declarative Self-Improving Observability

**Requirement:** Optimization traces and reproducibility signals must be captured through native observability lanes.

**Acceptance:**
- Optimization traces, program logs, and reproducibility data stream through current observability paths
- Evidence can be exported without a duplicate telemetry stack
- Self-improvement traces remain compatible with existing audit and benchmark lanes

## Verification Requirements

- SRS regression must parse and accept the `V6-WORKFLOW-017.*` family with no malformed rows
- Any future implementation must include:
  - at least one regression test,
  - at least one integration test,
  - runnable CLI evidence,
  - deterministic receipt/state evidence,
  - churn guard pass for touched scope

## Execution Notes

- This is a requirements intake only.
- Normalize the source doc's `apps/dspy/` idea into optional shells only; authority remains in `core/`, `client/runtime/systems/**`, and `adapters/`.
- Prefer `infring assimilate dspy` for operator-facing naming.
