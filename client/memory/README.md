# client/memory/README.md

This directory is the versioned memory knowledge surface for Protheus.
Runtime/user-instance memory belongs under `client/runtime/local/memory` (ignored).

Conversation synthesis runtime output is emitted to:
- `client/runtime/local/state/memory/conversation_eye/nodes.jsonl`
- `client/runtime/local/state/memory/conversation_eye/index.json`

Dream-sequenced matrix runtime output is emitted to:
- `client/runtime/local/state/memory/matrix/tag_memory_matrix.json`
- `client/memory/TAG_MEMORY_MATRIX.md` (readable export)

Auto-recall runtime output is emitted to:
- `client/runtime/local/state/memory/auto_recall/events.jsonl`
- `client/runtime/local/state/memory/auto_recall/latest.json`

## Memory Matrix + Dream Sequencer

`memory_matrix` builds a scored tag->memory matrix for low-burn retrieval and recall ordering.

Scoring priority is:
- memory level (`node1 > tag2 > jot3`)
- recency decay
- dream inclusion signal

`dream_sequencer` runs the matrix reorder cycle and writes the latest ranked tag surface.

Commands:
- `npm run -s memory:matrix:build`
- `npm run -s memory:matrix:status`
- `npm run -s memory:dream-sequencer:run`
- `npm run -s memory:dream-sequencer:status`

## Auto Recall

When a new memory node is filed (for example by `conversation_eye`), `memory_auto_recall`:
- finds top matches by shared tags + matrix rank
- pushes a bounded attention event through conduit (`attention-queue enqueue`)
- records deterministic recall receipts under `client/runtime/local/state/memory/auto_recall/*`

Command:
- `npm run -s memory:auto-recall:status`

## Memory Recall Context Budget

`memory_recall` now enforces a hard context budget contract on query payloads:
- `--context-budget-tokens=<n>` (default `8000`, floor `256`)
- `--context-budget-mode=trim|reject` (default `trim`)

Trim mode keeps bounded hits and trims excerpts/summaries. Reject mode fails closed with
`error: context_budget_exceeded`.

## Moltbook Credentials Persistence

To ensure context-free continuity for Moltbook:
- The Moltbook API key and `agent_name` are stored in `${WORKSPACE_ROOT}/client/runtime/local/private/moltbook/credentials.json`.
- On *every* session startup that allows file read access, load this file and cache contents locally for any Moltbook API/skill task (even if prior chat history/context is missing).
- If file is missing, alert human for re-entry of credentials.

## LLM Model Switching Prep

This logic will work for any OpenClaw agent, even if model weights/sessions switch, as long as:
- The workspace filesystem is retained
- Read/write access to `/.client/runtime/config/moltbook/` remains
- No restrictions on agent-specific file read ops

**If switching LLMs breaks this flow, alert the human and request intervention!**

## Heartbeat Tracking

Track periodic checks in `client/runtime/local/memory/heartbeat-state.json`:
- Last email check
- Last calendar check  
- Last weather check
- Last Moltbook interaction

---
(Keep this README as the ground truth for Moltbook context-free credential loading.)
