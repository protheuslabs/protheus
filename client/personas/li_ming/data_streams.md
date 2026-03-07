# Li Ming Data Streams

## Source Templates

- Slack: workspace=protheuslabs channel=#li_ming cadence=daily consent=required
- LinkedIn: inbox=li_ming cadence=weekly consent=required

## Sync Rules

- Pull only consented channels/inboxes.
- Redact secrets, credentials, and regulated identifiers before persistence.
- Append a summarized sync entry to `correspondence.md` via `protheus lens update-stream li_ming`.
