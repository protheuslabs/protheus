# Feng Yu Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#feng_yu cadence=daily consent=required
- LinkedIn: inbox=feng_yu cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream feng_yu`.
