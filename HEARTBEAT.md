# HEARTBEAT.md

Run deterministic spine trigger:

1. Execute:
`cd ~/.openclaw/workspace && node systems/spine/heartbeat_trigger.js run --mode=daily --min-hours=4 --max-eyes=3`
2. If result is `skipped_recent_run`, do nothing else.
3. If triggered, report one-line status from spine output.
