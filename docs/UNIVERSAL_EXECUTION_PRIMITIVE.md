# Universal Execution Primitive (Profile-Driven)

`systems/actuation/universal_execution_primitive.js` is the profile-driven execution entrypoint for capability profiles.

## Why

- Routes actions through one governed primitive path over capability profiles.
- Avoids bespoke per-tool execution branches.
- Preserves existing safety gates by delegating to `systems/actuation/actuation_executor.js`.

## Commands

```bash
# Execute from profile id (loaded from configured profile roots)
node systems/actuation/universal_execution_primitive.js run \
  --profile-id=my_profile \
  --params='{"url":"https://example.com/hook","method":"POST"}' \
  --context='{"passport_id":"passport-abc"}' \
  --dry-run

# Execute from inline/file profile payload
node systems/actuation/universal_execution_primitive.js run \
  --profile-json=@state/assimilation/capability_profiles/profiles/my_profile.json \
  --intent=write_file \
  --params='{"action":"write_file","path":"notes/out.txt","content":"hello"}'

# Coverage/health snapshot
node systems/actuation/universal_execution_primitive.js status
```

NPM shortcuts:

```bash
npm run actuation:universal:run -- --profile-id=my_profile --params='{"url":"https://example.com"}' --dry-run
npm run actuation:universal:status
```

## Policy

Policy file: `config/universal_execution_primitive_policy.json`

Key controls:

- `min_profile_confidence`
- `allowed_adapter_kinds`
- `source_type_adapter_map`
- `intent_adapter_map`
- `profile_roots`
- `receipts_path`

## Receipts

Daily receipts are written to:

- `state/actuation/universal_execution_primitive/receipts/YYYY-MM-DD.jsonl`

Each row includes:

- `profile_id`, `profile_hash`, `profile_confidence`
- resolved `adapter_kind` and resolution source
- `passport_link_id` passthrough
- executor status + payload
