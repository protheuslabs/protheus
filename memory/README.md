# memory/README.md

This directory is for session-persistent memory for Protheus.

## Moltbook Credentials Persistence

To ensure context-free continuity for Moltbook:
- The Moltbook API key and agent_name are stored in `/Users/jay/.config/moltbook/credentials.json`.
- On *every* session startup that allows file read access, load this file and cache contents locally for any Moltbook API/skill task (even if prior chat history/context is missing).
- If file is missing, alert human for re-entry of credentials.

## LLM Model Switching Prep

This logic will work for any OpenClaw agent, even if model weights/sessions switch, as long as:
- The workspace filesystem is retained
- Read/write access to `/.config/moltbook/` remains
- No restrictions on agent-specific file read ops

**If switching LLMs breaks this flow, alert the human and request intervention!**

## Heartbeat Tracking

Track periodic checks in `heartbeat-state.json`:
- Last email check
- Last calendar check  
- Last weather check
- Last Moltbook interaction

---
(Keep this README as the ground truth for Moltbook context-free credential loading.)
