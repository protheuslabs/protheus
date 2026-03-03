# Wu Jie Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#wu_jie cadence=daily consent=required
- LinkedIn: inbox=wu_jie cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream wu_jie`.
